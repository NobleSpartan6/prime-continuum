import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHostdCli } from "../../src/hostd/index";
import { PairingAuthority } from "../../src/hostd/pairing/authority";
import { getHostDataPaths } from "../../src/hostd/paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hostd CLI authority isolation", () => {
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
