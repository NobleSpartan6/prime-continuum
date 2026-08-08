import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GatewayError,
  type GatewayAdmission,
  type GatewayDispatchContext,
  type PrimeAgentProjectionChange,
  type PrimeAgentGateway,
} from "./gateway";
import {
  PrimeAgentResidentAdapter,
  type PrimeAgentPublicModuleLoader,
  type PrimeAgentResidentAdapterOptions,
} from "./prime-agent-resident-adapter";
import {
  ResidentRuntimeContractError,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentRuntimeConnection,
  type ResidentSessionBinding,
} from "./resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "./runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "./runtime-model-catalog";
import {
  residentDispatchAuthorityFingerprint,
  validateResidentAbortReconciliationLease,
  validateResidentPromptReconciliationLease,
  type HostStore,
  type ResidentAbortIdleObservedEvent,
  type ResidentAbortReconciliationLease,
  type ResidentPromptIdleObservedEvent,
  type ResidentPromptReconciliationLease,
} from "./store";
import type { CommandEnvelope } from "../shared/protocol";

const PROCESS_HANDLER_EVENTS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "beforeExit",
  "exit",
  "uncaughtException",
  "unhandledRejection",
] as const;

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

type ResidentGatewayAdapter = PrimeAgentGateway & {
  attachResident(binding: ResidentSessionBinding): Promise<ResidentRuntimeConnection>;
  reconcileAcknowledgedPromptIdle(
    lease: ResidentPromptReconciliationLease,
  ): Promise<ResidentPromptIdleAuthorityEvidence>;
  reconcileAcknowledgedAbortIdle(
    lease: ResidentAbortReconciliationLease,
  ): Promise<ResidentAbortIdleAuthorityEvidence>;
};

export interface VerifiedResidentGatewayOptions {
  readonly store: HostStore;
  readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  /** Test seam. Production constructs the pinned resident adapter exactly once. */
  readonly adapterFactory?: (options: PrimeAgentResidentAdapterOptions) => ResidentGatewayAdapter;
  /** Test seam for the verified deep-module loader. */
  readonly moduleLoaderFactory?: (handle: VerifiedInstalledRuntimeHandle) => PrimeAgentPublicModuleLoader;
}

/**
 * Lazily attaches only durable resident bindings after a fresh runtime-tree
 * verification. It never creates or replaces a Prime Agent session as a side
 * effect of `isLive`; session creation remains a separate durable operation.
 */
export class VerifiedResidentGateway implements PrimeAgentGateway {
  readonly continuity = "resident" as const;
  private readonly store: HostStore;
  private readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly platform: NodeJS.Platform;
  private readonly adapterFactory: NonNullable<VerifiedResidentGatewayOptions["adapterFactory"]>;
  private readonly moduleLoaderFactory: NonNullable<VerifiedResidentGatewayOptions["moduleLoaderFactory"]>;
  private readonly projectionListeners = new Set<(change: PrimeAgentProjectionChange) => void>();
  private readonly promptIdleListeners = new Set<(event: ResidentPromptIdleObservedEvent) => void>();
  private readonly abortIdleListeners = new Set<(event: ResidentAbortIdleObservedEvent) => void>();
  private readonly promptReconciliationJobs = new Map<string, Promise<void>>();
  private readonly abortReconciliationJobs = new Map<string, Promise<void>>();
  private adapter: ResidentGatewayAdapter | undefined;
  private adapterPromise: Promise<ResidentGatewayAdapter> | undefined;
  private preparationPromise: Promise<boolean> | undefined;
  private preparedBindingSetFingerprint: string | undefined;
  private promptReconciliationDiscovery: Promise<void> | undefined;
  private abortReconciliationDiscovery: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: VerifiedResidentGatewayOptions) {
    this.store = options.store;
    this.runtimeHandles = options.runtimeHandles;
    this.environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.platform = options.platform ?? process.platform;
    this.adapterFactory = options.adapterFactory ?? ((adapterOptions) => new PrimeAgentResidentAdapter(adapterOptions));
    this.moduleLoaderFactory = options.moduleLoaderFactory ?? createVerifiedResidentModuleLoader;
  }

  async isLive(threadId: string, executionGenerationId: string): Promise<boolean> {
    if (this.closed) return false;
    const binding = await this.store.getResidentSessionBinding(threadId, executionGenerationId);
    if (!binding) return false;
    const expectedSet = await this.currentBindingSetFingerprint();
    if (!expectedSet || expectedSet !== this.preparedBindingSetFingerprint || !this.adapter) return false;
    try {
      const live = await this.adapter.isLive(threadId, executionGenerationId);
      if (!live) this.preparedBindingSetFingerprint = undefined;
      return !this.closed && live;
    } catch (error) {
      this.preparedBindingSetFingerprint = undefined;
      if (isDefinitivelyUnavailableResident(error)) return false;
      throw error;
    }
  }

  /**
   * Nonblocking health gate. The first call for a new exact binding set starts
   * verified reattachment and returns false. A later call returns true only
   * after every durable binding attached and the set remained unchanged.
   */
  async capabilityReady(): Promise<boolean> {
    if (this.closed) return false;
    const bindings = await this.store.listResidentSessionBindings();
    if (bindings.length === 0) {
      this.preparedBindingSetFingerprint = undefined;
      return false;
    }
    const fingerprint = residentBindingSetFingerprint(bindings);
    if (fingerprint === this.preparedBindingSetFingerprint && this.adapter) {
      this.schedulePromptReconciliationDiscovery();
      this.scheduleAbortReconciliationDiscovery();
      return true;
    }
    if (!this.preparationPromise) {
      const attempt = this.prepareBindings(bindings, fingerprint);
      this.preparationPromise = attempt;
      void attempt.finally(() => {
        if (this.preparationPromise === attempt) this.preparationPromise = undefined;
      });
    }
    return false;
  }

  subscribeProjectionChanges(listener: (change: PrimeAgentProjectionChange) => void): () => void {
    if (this.closed) return () => undefined;
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  subscribeResidentPromptIdleObserved(
    listener: (event: ResidentPromptIdleObservedEvent) => void,
  ): () => void {
    if (this.closed) return () => undefined;
    this.promptIdleListeners.add(listener);
    return () => this.promptIdleListeners.delete(listener);
  }

  subscribeResidentAbortIdleObserved(
    listener: (event: ResidentAbortIdleObservedEvent) => void,
  ): () => void {
    if (this.closed) return () => undefined;
    this.abortIdleListeners.add(listener);
    return () => this.abortIdleListeners.delete(listener);
  }

  scheduleResidentPromptReconciliation(leaseValue: ResidentPromptReconciliationLease): void {
    const lease = validateResidentPromptReconciliationLease(leaseValue);
    if (this.closed || this.promptReconciliationJobs.has(lease.attemptId)) return;
    const job = this.reconcileResidentPrompt(lease);
    this.promptReconciliationJobs.set(lease.attemptId, job);
    job.then(
      () => {
        if (this.promptReconciliationJobs.get(lease.attemptId) === job) {
          this.promptReconciliationJobs.delete(lease.attemptId);
        }
      },
      () => {
        // The durable lock remains authoritative. A later readiness poll can
        // retry the read-only proof, while this rejection is fully supervised.
        if (this.promptReconciliationJobs.get(lease.attemptId) === job) {
          this.promptReconciliationJobs.delete(lease.attemptId);
        }
      },
    );
  }

  scheduleResidentAbortReconciliation(leaseValue: ResidentAbortReconciliationLease): void {
    const lease = validateResidentAbortReconciliationLease(leaseValue);
    if (this.closed || this.abortReconciliationJobs.has(lease.attemptId)) return;
    const job = this.reconcileResidentAbort(lease);
    this.abortReconciliationJobs.set(lease.attemptId, job);
    job.then(
      () => {
        if (this.abortReconciliationJobs.get(lease.attemptId) === job) {
          this.abortReconciliationJobs.delete(lease.attemptId);
        }
      },
      () => {
        // The durable running Stop receipt remains authoritative. A later
        // readiness poll retries only this read-only proof, never the abort.
        if (this.abortReconciliationJobs.get(lease.attemptId) === job) {
          this.abortReconciliationJobs.delete(lease.attemptId);
        }
      },
    );
  }

  async submit(command: CommandEnvelope, context?: GatewayDispatchContext): Promise<GatewayAdmission> {
    if (this.closed) {
      throw new GatewayError("GATEWAY_CLOSED", "The resident Prime Agent gateway is closed", false);
    }
    const adapter = this.adapter;
    if (!adapter || !this.preparedBindingSetFingerprint) {
      throw new GatewayError(
        "RESIDENT_SESSION_NOT_ATTACHED",
        "Every durable resident Prime Agent session must be attached before dispatch",
        true,
      );
    }
    return adapter.submit(command, context);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= (async () => {
      const pending = this.adapterPromise;
      const pendingAdapter = pending ? await pending.catch(() => undefined) : this.adapter;
      // Closing the owned adapter first rejects any blocked pinned idle barrier;
      // reconciliation jobs are drained only after that terminal fence.
      await pendingAdapter?.close().catch(() => undefined);
      const preparation = this.preparationPromise;
      if (preparation) await preparation.catch(() => undefined);
      const discovery = this.promptReconciliationDiscovery;
      if (discovery) await discovery.catch(() => undefined);
      const abortDiscovery = this.abortReconciliationDiscovery;
      if (abortDiscovery) await abortDiscovery.catch(() => undefined);
      await Promise.allSettled([...this.promptReconciliationJobs.values()]);
      await Promise.allSettled([...this.abortReconciliationJobs.values()]);
      await this.adapter?.close();
      this.projectionListeners.clear();
      this.promptIdleListeners.clear();
      this.abortIdleListeners.clear();
    })();
    return this.closePromise;
  }

  private ensureAdapter(): Promise<ResidentGatewayAdapter> {
    if (this.closed) return Promise.reject(new GatewayError("GATEWAY_CLOSED", "The resident gateway is closed"));
    if (this.adapter) return Promise.resolve(this.adapter);
    if (this.adapterPromise) return this.adapterPromise;
    const attempt = this.createAdapter();
    this.adapterPromise = attempt;
    attempt.then(
      (adapter) => {
        if (this.adapterPromise === attempt) this.adapterPromise = undefined;
        if (!this.closed) this.adapter = adapter;
      },
      () => {
        if (this.adapterPromise === attempt) this.adapterPromise = undefined;
      },
    );
    return attempt;
  }

  private async prepareBindings(
    bindings: readonly ResidentSessionBinding[],
    fingerprint: string,
  ): Promise<boolean> {
    this.preparedBindingSetFingerprint = undefined;
    try {
      const adapter = await this.ensureAdapter();
      for (const binding of bindings) {
        if (this.closed) return false;
        await adapter.attachResident(binding);
      }
      const current = await this.currentBindingSetFingerprint();
      if (this.closed || current !== fingerprint) return false;
      this.preparedBindingSetFingerprint = fingerprint;
      this.schedulePromptReconciliationDiscovery();
      this.scheduleAbortReconciliationDiscovery();
      return true;
    } catch {
      this.preparedBindingSetFingerprint = undefined;
      return false;
    }
  }

  private schedulePromptReconciliationDiscovery(): void {
    if (
      this.closed ||
      !this.adapter ||
      !this.preparedBindingSetFingerprint ||
      this.promptReconciliationDiscovery
    ) {
      return;
    }
    const discovery = this.store.listResidentPromptReconciliationLeases().then((leases) => {
      if (this.closed) return;
      for (const lease of leases) this.scheduleResidentPromptReconciliation(lease);
    });
    this.promptReconciliationDiscovery = discovery;
    discovery.then(
      () => {
        if (this.promptReconciliationDiscovery === discovery) {
          this.promptReconciliationDiscovery = undefined;
        }
      },
      () => {
        if (this.promptReconciliationDiscovery === discovery) {
          this.promptReconciliationDiscovery = undefined;
        }
      },
    );
  }

  private scheduleAbortReconciliationDiscovery(): void {
    if (
      this.closed ||
      !this.adapter ||
      !this.preparedBindingSetFingerprint ||
      this.abortReconciliationDiscovery
    ) {
      return;
    }
    const discovery = this.store.listResidentAbortReconciliationLeases().then((leases) => {
      if (this.closed) return;
      for (const lease of leases) this.scheduleResidentAbortReconciliation(lease);
    });
    this.abortReconciliationDiscovery = discovery;
    discovery.then(
      () => {
        if (this.abortReconciliationDiscovery === discovery) {
          this.abortReconciliationDiscovery = undefined;
        }
      },
      () => {
        if (this.abortReconciliationDiscovery === discovery) {
          this.abortReconciliationDiscovery = undefined;
        }
      },
    );
  }

  private async reconcileResidentPrompt(lease: ResidentPromptReconciliationLease): Promise<void> {
    const adapter = this.adapter;
    if (this.closed || !adapter || !this.preparedBindingSetFingerprint) return;
    const evidence = await adapter.reconcileAcknowledgedPromptIdle(lease);
    if (this.closed) return;
    const observation = await this.store.completeResidentPromptReconciliation(lease, evidence);
    if (this.closed) return;
    for (const listener of this.promptIdleListeners) {
      try {
        listener(observation);
      } catch {
        // The proof, receipt, and dedicated audit event are already durable.
        // One advisory listener cannot roll them back or suppress another.
      }
    }
    if (this.closed) return;
    const trailingChange = Object.freeze({
      threadId: observation.command.threadId,
      executionGenerationId: observation.command.expectedExecutionGenerationId,
    });
    for (const listener of this.projectionListeners) {
      try {
        listener(trailingChange);
      } catch {
        // The trailing invalidation is advisory; the receipt, proof event, and
        // ownership removal are already durable and reconnect-safe.
      }
    }
  }

  private async reconcileResidentAbort(lease: ResidentAbortReconciliationLease): Promise<void> {
    const adapter = this.adapter;
    if (this.closed || !adapter || !this.preparedBindingSetFingerprint) return;
    const evidence = await adapter.reconcileAcknowledgedAbortIdle(lease);
    if (this.closed) return;
    // Store alone may replace a lagging active view at the same upstream
    // cursor, and only under this exact branded acknowledged-Stop lease.
    await this.store.publishResidentProjectionSnapshot(lease.binding, evidence.projection, lease);
    if (this.closed) return;
    const observation = await this.store.completeResidentAbortReconciliation(lease, evidence);
    if (this.closed) return;
    for (const listener of this.abortIdleListeners) {
      try {
        listener(observation);
      } catch {
        // The proof, receipt, projection, and audit event are already durable.
      }
    }
    if (this.closed) return;
    const trailingChange = Object.freeze({
      threadId: observation.command.threadId,
      executionGenerationId: observation.command.expectedExecutionGenerationId,
    });
    for (const listener of this.projectionListeners) {
      try {
        listener(trailingChange);
      } catch {
        // The trailing invalidation is advisory and follows durable proof.
      }
    }
  }

  private async currentBindingSetFingerprint(): Promise<string | undefined> {
    const bindings = await this.store.listResidentSessionBindings();
    return bindings.length === 0 ? undefined : residentBindingSetFingerprint(bindings);
  }

  private async createAdapter(): Promise<ResidentGatewayAdapter> {
    const handle = await this.runtimeHandles.acquireVerifiedRuntimeHandle();
    const daemonWorkingDirectory = residentDaemonWorkingDirectory(this.store.paths.root);
    const socketPath = residentDaemonEndpoint(this.store.paths.root, this.platform);
    await ensurePrivateRuntimeDirectory(daemonWorkingDirectory);
    if (this.platform !== "win32") await ensurePrivateRuntimeDirectory(dirname(socketPath));
    if (this.closed) throw new GatewayError("GATEWAY_CLOSED", "The resident gateway closed during runtime verification");

    const adapter = this.adapterFactory({
      executable: handle.executable,
      cliEntrypoint: handle.cliEntrypoint,
      socketPath,
      daemonWorkingDirectory,
      environment: this.environment,
      loadRuntimeModule: this.moduleLoaderFactory(handle),
      persistBinding: (binding) => this.store.persistResidentSessionBinding(binding),
      completeBinding: (binding) => this.store.completeResidentSessionBinding(binding),
      publishProjection: async (binding, projection) => {
        await this.store.publishResidentProjectionSnapshot(binding, projection);
        if (this.closed) return;
        const change = Object.freeze({
          threadId: binding.threadId,
          executionGenerationId: binding.executionGenerationId,
        });
        for (const listener of this.projectionListeners) {
          try {
            listener(change);
          } catch {
            // Projection publication is already durable. One observer cannot
            // roll it back or prevent another connection from refreshing.
          }
        }
      },
    });
    if (this.closed) {
      await adapter.close().catch(() => undefined);
      throw new GatewayError("GATEWAY_CLOSED", "The resident gateway closed while its adapter was starting");
    }
    return adapter;
  }
}

export function residentDaemonWorkingDirectory(canonicalDataDirectory: string): string {
  return join(resolve(canonicalDataDirectory), "resident-daemon");
}

export function residentDaemonEndpoint(
  canonicalDataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const root = resolve(canonicalDataDirectory);
  const identity = createHash("sha256")
    .update(platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  if (platform === "win32") {
    return `\\\\.\\pipe\\prime-continuim-resident-${identity}`;
  }
  // Unix sockaddr paths are commonly limited to roughly 108 bytes. Keep the
  // endpoint short while namespacing it to the canonical data root; its parent
  // is separately verified as a private, process-owned directory.
  const endpoint = join(resolve(tmpdir()), `pc-${identity}`, "d.sock");
  if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Resident daemon endpoint exceeds the Unix socket path limit");
  }
  return endpoint;
}

/**
 * Import only the two verified daemon transport modules, not Prime Agent's
 * broad root barrel. The latter eagerly loads CLI/kernel modules that register
 * process handlers and must remain outside long-lived hostd.
 */
export function createVerifiedResidentModuleLoader(
  handle: VerifiedInstalledRuntimeHandle,
): PrimeAgentPublicModuleLoader {
  let load: Promise<unknown> | undefined;
  return () => {
    load ??= loadVerifiedResidentModules(handle);
    return load;
  };
}

async function loadVerifiedResidentModules(handle: VerifiedInstalledRuntimeHandle): Promise<unknown> {
  const moduleUrl = new URL(handle.moduleUrl);
  if (moduleUrl.protocol !== "file:" || moduleUrl.username || moduleUrl.password || moduleUrl.search || moduleUrl.hash) {
    throw new Error("Verified Prime Agent module URL is invalid");
  }
  const rootEntrypoint = fileURLToPath(moduleUrl);
  const distDirectory = dirname(rootEntrypoint);
  const daemonClientPath = join(distDirectory, "modes", "daemon", "daemon-client.js");
  const daemonConnectionPath = join(distDirectory, "modes", "agent-connection", "daemon-agent-connection.js");
  assertPathWithin(distDirectory, daemonClientPath);
  assertPathWithin(distDirectory, daemonConnectionPath);

  const before = snapshotProcessHandlers();
  const [clientModule, connectionModule] = await Promise.all([
    import(pathToFileURL(daemonClientPath).href),
    import(pathToFileURL(daemonConnectionPath).href),
  ]);
  if (!processHandlersEqual(before, snapshotProcessHandlers())) {
    // Never remove listeners here: another subsystem may have installed one
    // concurrently and attribution would be unsafe. The memoized loader stays
    // rejected, so the altered import can never authorize resident commands.
    throw new Error("Verified Prime Agent transport modules modified host process handlers");
  }
  return Object.freeze({
    DaemonClient: clientModule.DaemonClient,
    DaemonAgentConnection: connectionModule.DaemonAgentConnection,
  });
}

async function ensurePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Resident daemon working directory is not a private directory");
  }
  if (process.platform !== "win32") {
    if ((entry.mode & 0o077) !== 0) {
      throw new Error("Resident daemon working directory permissions are too broad");
    }
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
      throw new Error("Resident daemon working directory is owned by another user");
    }
  }
  const physical = await realpath(path);
  if (!samePath(physical, path)) {
    throw new Error("Resident daemon working directory changed physical identity");
  }
}

function isDefinitivelyUnavailableResident(error: unknown): boolean {
  return error instanceof ResidentRuntimeContractError && (
    error.code === "PRIME_RUNTIME_SESSION_NOT_FOUND" ||
    error.code === "PRIME_RUNTIME_UNAVAILABLE" ||
    error.code === "PRIME_RUNTIME_ADAPTER_CLOSED"
  );
}

function assertPathWithin(parent: string, child: string): void {
  const childRelative = relative(resolve(parent), resolve(child));
  if (childRelative === "" || childRelative === ".." || childRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Verified resident module path escaped its runtime dist directory");
  }
}

type ProcessHandlerSnapshot = ReadonlyMap<string, readonly Function[]>;

function snapshotProcessHandlers(): ProcessHandlerSnapshot {
  return new Map(PROCESS_HANDLER_EVENTS.map((event) => [event, [...process.rawListeners(event)]]));
}

function processHandlersEqual(left: ProcessHandlerSnapshot, right: ProcessHandlerSnapshot): boolean {
  for (const event of PROCESS_HANDLER_EVENTS) {
    const leftHandlers = left.get(event) ?? [];
    const rightHandlers = right.get(event) ?? [];
    if (leftHandlers.length !== rightHandlers.length) return false;
    if (leftHandlers.some((handler, index) => handler !== rightHandlers[index])) return false;
  }
  return true;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function residentBindingSetFingerprint(bindings: readonly ResidentSessionBinding[]): string {
  const canonical = [...bindings]
    // Readiness tracks the same stable resident authority as durable dispatch.
    // A verified attach may refresh supervisor metadata or reorder an equal
    // capability set without changing which session owns command authority.
    .map((binding) => residentDispatchAuthorityFingerprint(binding))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
