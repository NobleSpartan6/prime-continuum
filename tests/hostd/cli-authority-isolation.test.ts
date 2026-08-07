import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHostdCli } from "../../src/hostd/index";
import { resolveCanonicalLocalHostTarget } from "../../src/shared/local-host-target";
import { PairingAuthority } from "../../src/hostd/pairing/authority";
import { defaultLocalEndpoint, getHostDataPaths } from "../../src/hostd/paths";
import { serveLocalSocket } from "../../src/hostd/server";
import { HostService } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hostd CLI authority isolation", () => {
  it("keeps probe filesystem-read-only when the host data directory does not exist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "prime-hostd-cli-read-only-probe-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "missing-host-data");
    const output = captureStdout();

    await expect(runHostdCli(["probe", "--json", "--data-dir", directory])).resolves.toBe(0);

    expect(JSON.parse(output.read())).toMatchObject({
      hostd: { status: "installed" },
      recentProjects: [],
    });
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads a live recent-project catalog without initializing a competing store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-cli-live-probe-"));
    temporaryDirectories.push(directory);
    const store = new HostStore(directory);
    const service = new HostService(store);
    await service.initialize({ seed: true });
    const server = await serveLocalSocket({
      endpoint: defaultLocalEndpoint(directory),
      dataDir: directory,
      service,
    });
    const initialize = vi.spyOn(HostStore.prototype, "initialize");
    const output = captureStdout();

    try {
      await expect(runHostdCli(["probe", "--json", "--data-dir", directory])).resolves.toBe(0);
      const probe = JSON.parse(output.read()) as {
        hostd: { status: string; runningVersion?: string };
        recentProjects: Array<{ projectId: string }>;
      };
      expect(probe.hostd).toMatchObject({ status: "running", runningVersion: expect.any(String) });
      expect(probe.recentProjects).toContainEqual(expect.objectContaining({ projectId: "demo-project" }));
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does not initialize seed state while a live serve process owns the endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-cli-seed-contender-"));
    temporaryDirectories.push(directory);
    const store = new HostStore(directory);
    const service = new HostService(store);
    await service.initialize({ seed: true });
    const server = await serveLocalSocket({
      endpoint: defaultLocalEndpoint(directory),
      dataDir: directory,
      service,
    });
    const initialize = vi.spyOn(HostStore.prototype, "initialize");
    const output = captureStdout();

    try {
      await expect(runHostdCli(["seed", "--data-dir", directory])).rejects.toBeInstanceOf(Error);
      expect(initialize).not.toHaveBeenCalled();
      expect(output.read()).toBe("");
      expect((await store.getCatalogSnapshot()).projects).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "collapses a junction alias before two serve contenders acquire endpoint ownership",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "prime-hostd-cli-junction-contender-"));
      temporaryDirectories.push(parent);
      const physicalDirectory = join(parent, "physical");
      const junctionDirectory = join(parent, "junction");
      await mkdir(physicalDirectory);
      await symlink(physicalDirectory, junctionDirectory, "junction");

      const physicalTarget = await resolveCanonicalLocalHostTarget(physicalDirectory);
      const junctionTarget = await resolveCanonicalLocalHostTarget(junctionDirectory);
      expect(junctionTarget).toMatchObject({
        dataDirectory: physicalTarget.dataDirectory,
        endpoint: physicalTarget.endpoint,
        physicalIdentityAvailable: true,
      });

      const ownerStore = new HostStore(physicalDirectory);
      const ownerService = new HostService(ownerStore);
      const contenderStore = new HostStore(junctionDirectory);
      const contenderService = new HostService(contenderStore);
      const contenderInitialize = vi.spyOn(contenderStore, "initialize");
      const ownerServer = await serveLocalSocket({
        endpoint: physicalTarget.endpoint,
        dataDir: physicalDirectory,
        service: ownerService,
        onOwned: async () => {
          await ownerService.initialize({ seed: true });
        },
      });

      try {
        await expect(
          serveLocalSocket({
            endpoint: junctionTarget.endpoint,
            dataDir: junctionDirectory,
            service: contenderService,
            onOwned: async () => {
              await contenderService.initialize();
            },
          }),
        ).rejects.toBeInstanceOf(Error);
        expect(contenderInitialize).not.toHaveBeenCalled();
        expect((await ownerStore.getCatalogSnapshot()).projects).toHaveLength(1);
      } finally {
        await contenderService.close();
        await ownerServer.close();
      }
    },
  );

  it("does not initialize or cancel live pairing state during probe or seed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-cli-authority-"));
    temporaryDirectories.push(directory);
    const stateFile = getHostDataPaths(directory).pairingAuthority;
    const authority = new PairingAuthority(stateFile, { allowTestTicketIds: true });
    await authority.initialize({
      hostId: "host-cli-authority",
      identity: {
        identityEpoch: 1,
        algorithm: "Noise_25519",
        publicKeyB64u: Buffer.alloc(32, 41).toString("base64url"),
        secretRef: "keyring:prime-agent-cli-authority-test",
      },
    });
    await authority.createTicket({
      expectedHostId: "host-cli-authority",
      ticketId: "ticket-must-survive-diagnostics",
      relayOrigin: "wss://relay.example.test",
      requestedScopes: ["projection.read"],
      ttlSeconds: 300,
    });
    const before = await readFile(stateFile, "utf8");
    vi.spyOn(stdout, "write").mockImplementation(() => true);

    await expect(runHostdCli(["probe", "--json", "--data-dir", directory])).resolves.toBe(0);
    expect(await readFile(stateFile, "utf8")).toBe(before);

    await expect(runHostdCli(["seed", "--data-dir", directory])).resolves.toBe(0);
    expect(await readFile(stateFile, "utf8")).toBe(before);
  });
});

function captureStdout(): { read(): string } {
  let output = "";
  vi.spyOn(stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stdout.write);
  return { read: () => output };
}
