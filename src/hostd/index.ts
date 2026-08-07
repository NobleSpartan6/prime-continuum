import { basename, isAbsolute, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { resolveCanonicalLocalHostTarget } from "../shared/local-host-target";
import { resolveHostDataDir } from "./paths";
import { collectHostProbe } from "./probe";
import { PairingAuthority, type ChannelCloseFailureDiagnostic } from "./pairing/authority";
import { readEmbeddedRuntimeAttestationEnvelope } from "./runtime-attestation";
import { RuntimeInitializationCoordinator } from "./runtime-initialization-coordinator";
import { VerifiedRuntimeModelCatalog } from "./runtime-model-catalog";
import { bridgeStdioToLocalSocket, serveLocalSocket } from "./server";
import { HostService } from "./service";
import { HostStore } from "./store";

export * from "./gateway";
export * from "./oauth-session-broker";
export * from "./paths";
export * from "./probe";
export * from "./prime-agent-resident-adapter";
export * from "./resident-runtime";
export * from "./runtime-attestation";
export * from "./runtime-initialization-coordinator";
export * from "./runtime-integrity-manager";
export * from "./runtime-model-catalog";
export * from "./server";
export * from "./service";
export * from "./store";

type CliMode = "serve" | "connect" | "probe" | "seed";

export interface HostdCliOptions {
  mode: CliMode;
  dataDir: string;
  socket?: string;
  runtimeSeed?: string;
  stdio: boolean;
  json: boolean;
}

export async function runHostdCli(argv = process.argv.slice(2)): Promise<number> {
  let options: HostdCliOptions;
  try {
    options = parseHostdCli(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "Invalid arguments"}\n${usage()}\n`);
    return 2;
  }

  if (options.mode === "seed") {
    const target = await resolveCanonicalLocalHostTarget(options.dataDir, { create: true });
    const store = new HostStore(target.dataDirectory);
    const service = new HostService(store);
    let result: Awaited<ReturnType<HostStore["seedIfEmpty"]>> | undefined;
    let server: Awaited<ReturnType<typeof serveLocalSocket>> | undefined;
    try {
      server = await serveLocalSocket({
        endpoint: target.endpoint,
        dataDir: target.dataDirectory,
        service,
        onOwned: async () => {
          // Seed is a durable store mutation, so it must run behind the same
          // endpoint ownership boundary as the persistent service. A live
          // daemon wins and this callback is never reached.
          result = await store.initialize({ seed: true });
        },
      });
      await server.close();
    } finally {
      // serveLocalSocket owns service shutdown after a successful listen. A
      // contender can fail before that point, so close the uninitialized
      // service here as an idempotent fallback.
      await service.close();
    }
    if (!result) throw new Error("Seed did not run under endpoint ownership");
    stdout.write(`${JSON.stringify({ version: 1, ...result })}\n`);
    return 0;
  }

  if (options.mode === "connect") {
    const target = await resolveCanonicalLocalHostTarget(options.dataDir);
    await bridgeStdioToLocalSocket(target.endpoint, stdin, stdout);
    return 0;
  }

  if (options.mode === "probe") {
    // Probe is strictly read-only. It obtains recent projects through the live
    // local protocol when available and never initializes or recovers the
    // file-backed store in a competing process.
    const result = await collectHostProbe(options.dataDir);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  // Install process termination handling before the first asynchronous serve
  // step, including physical data-root canonicalization. An immediate signal
  // must be remembered and routed through normal owned teardown once startup
  // settles.
  const termination = waitForTermination();
  try {
    const target = await resolveCanonicalLocalHostTarget(options.dataDir, { create: true });
    const store = new HostStore(target.dataDirectory);
    const runtimeAttestation = readEmbeddedRuntimeAttestationEnvelope();
    const runtimeInitialization = runtimeAttestation
        ? new RuntimeInitializationCoordinator({
            paths: store.paths,
            envelope: runtimeAttestation,
            ...(process.env.PRIME_CONTINUIM_PACKAGE_SMOKE === "1"
              ? { onFailure: reportPackageSmokeRuntimeFailure }
              : {}),
          })
      : undefined;
    const runtimeModelCatalog = runtimeInitialization
      ? new VerifiedRuntimeModelCatalog({ runtimeHandles: runtimeInitialization })
      : undefined;
    const service = new HostService(
      store,
      undefined,
      new PairingAuthority(store.paths.pairingAuthority, {
        onChannelCloseFailure: reportChannelCloseFailure,
      }),
      {
        runtimeIntegrityProvider: runtimeInitialization,
        runtimeModelCatalogProvider: runtimeModelCatalog,
      },
    );
    const endpoint = options.socket ?? target.endpoint;
    // Endpoint ownership is the cross-process single-writer boundary. Pairing
    // recovery runs only after this process has won that boundary, so a losing
    // second serve attempt cannot mutate or cancel live authority state.
    const server = await serveLocalSocket({
      endpoint,
      dataDir: target.dataDirectory,
      service,
      onOwned: async (lease) => {
        // Core authority recovery remains the bounded startup gate. Runtime
        // verification publishes an initializing snapshot synchronously, then
        // starts on the next event-loop turn without delaying health sessions.
        await service.initialize({ seed: false });
        runtimeInitialization?.start(lease, options.runtimeSeed);
      },
    });
    const completed = await Promise.race([
      termination.promise.then(() => "signal" as const),
      server.closed.then(() => "server" as const),
    ]);
    if (completed === "signal") await server.close();
    return 0;
  } finally {
    // A fatal ownership loss tears the server down without a process signal.
    // Remove the otherwise-live signal listeners so that failure can exit.
    termination.cancel();
  }
}

function reportChannelCloseFailure(diagnostic: ChannelCloseFailureDiagnostic): void {
  // Keep relay-channel teardown failures observable without ever writing to
  // stdout, which may be carrying framed protocol data in bridge mode.
  try {
    stderr.write(`${JSON.stringify({ event: "pairing.channel_close_failed", ...diagnostic })}\n`);
  } catch {
    // Diagnostics must never alter authorization or shutdown semantics.
  }
}

function reportPackageSmokeRuntimeFailure(error: unknown): void {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  try {
    stderr.write(`Package-smoke runtime initialization failed: ${messages.join(" <- ")}\n`);
  } catch {
    // Package-smoke diagnostics must never alter the integrity state machine.
  }
}

export function parseHostdCli(argv: string[]): HostdCliOptions {
  if (
    argv.length === 0 ||
    argv.length > 16 ||
    argv.some((argument) => argument.length > 4_096 || /[\0\r\n]/.test(argument))
  ) {
    throw new Error("A bounded hostd mode and arguments are required");
  }
  const mode = argv[0];
  if (mode !== "serve" && mode !== "connect" && mode !== "probe" && mode !== "seed") {
    throw new Error(`Unknown hostd mode: ${mode ?? "(missing)"}`);
  }

  let dataDir = resolveHostDataDir();
  let socket: string | undefined;
  let runtimeSeed: string | undefined;
  let stdio = false;
  let json = false;
  let dataDirSpecified = false;
  let socketSpecified = false;
  let runtimeSeedSpecified = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stdio") {
      if (stdio) throw new Error("--stdio may be specified only once");
      stdio = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new Error("--json may be specified only once");
      json = true;
      continue;
    }
    if (argument === "--data-dir" || argument === "--socket" || argument === "--runtime-seed") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires one value`);
      index += 1;
      if (argument === "--data-dir") {
        if (dataDirSpecified) throw new Error("--data-dir may be specified only once");
        dataDirSpecified = true;
        dataDir = resolve(value);
      } else if (argument === "--socket") {
        if (socketSpecified) throw new Error("--socket may be specified only once");
        socketSpecified = true;
        socket = value;
      } else {
        if (runtimeSeedSpecified) throw new Error("--runtime-seed may be specified only once");
        runtimeSeedSpecified = true;
        if (!isAbsolute(value)) throw new Error("--runtime-seed requires an absolute path");
        runtimeSeed = resolve(value);
      }
      continue;
    }
    throw new Error(`Unknown hostd argument: ${argument ?? "(missing)"}`);
  }

  if (mode === "connect" && !stdio) throw new Error("connect requires the fixed --stdio transport");
  if (mode !== "connect" && stdio) throw new Error("--stdio is valid only with connect");
  if (mode === "probe" && !json) throw new Error("probe requires --json");
  if (mode !== "probe" && json) throw new Error("--json is valid only with probe");
  if (mode !== "serve" && socket) throw new Error("--socket is valid only with serve");
  if (mode !== "serve" && runtimeSeed) throw new Error("--runtime-seed is valid only with serve");
  return { mode, dataDir, socket, runtimeSeed, stdio, json };
}

function usage(): string {
  return [
    "Usage:",
    "  prime-agent-hostd serve [--socket <local-endpoint>] [--data-dir <directory>] [--runtime-seed <absolute-directory>]",
    "  prime-agent-hostd connect --stdio [--data-dir <directory>]",
    "  prime-agent-hostd probe --json [--data-dir <directory>]",
    "  prime-agent-hostd seed [--data-dir <directory>]",
  ].join("\n");
}

function waitForTermination(): { promise: Promise<void>; cancel(): void } {
  let settled = false;
  let resolveTermination!: () => void;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    resolveTermination();
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolveTermination = resolvePromise;
  });
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  return { promise, cancel: finish };
}

function isDirectInvocation(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  const name = basename(script).toLowerCase();
  return name === "hostd.cjs" || name === "prime-agent-hostd" || name === "prime-agent-hostd.exe";
}

if (isDirectInvocation()) {
  void runHostdCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      stderr.write(`${error instanceof Error ? error.message : "Host service failed"}\n`);
      process.exitCode = 1;
    },
  );
}
