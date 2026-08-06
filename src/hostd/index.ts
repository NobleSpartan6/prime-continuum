import { basename, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { defaultLocalEndpoint, resolveHostDataDir } from "./paths";
import { collectHostProbe } from "./probe";
import { PairingAuthority, type ChannelCloseFailureDiagnostic } from "./pairing/authority";
import { bridgeStdioToLocalSocket, serveLocalSocket } from "./server";
import { HostService } from "./service";
import { HostStore } from "./store";

export * from "./gateway";
export * from "./paths";
export * from "./probe";
export * from "./prime-agent-resident-adapter";
export * from "./resident-runtime";
export * from "./runtime-attestation";
export * from "./server";
export * from "./service";
export * from "./store";

type CliMode = "serve" | "connect" | "probe" | "seed";

interface CliOptions {
  mode: CliMode;
  dataDir: string;
  socket?: string;
  stdio: boolean;
  json: boolean;
}

export async function runHostdCli(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "Invalid arguments"}\n${usage()}\n`);
    return 2;
  }

  const store = new HostStore(options.dataDir);

  if (options.mode === "seed") {
    await store.initialize({ seed: false });
    const result = await store.seedIfEmpty();
    stdout.write(`${JSON.stringify({ version: 1, ...result })}\n`);
    return 0;
  }

  if (options.mode === "connect") {
    await bridgeStdioToLocalSocket(defaultLocalEndpoint(options.dataDir), stdin, stdout);
    return 0;
  }

  if (options.mode === "probe") {
    // Probe reads the store without constructing pairing authority. Routine
    // diagnostics must never look like an authority restart or cancel tickets.
    await store.initialize({ seed: false });
    const result = await collectHostProbe(options.dataDir, store);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const service = new HostService(
    store,
    undefined,
    new PairingAuthority(store.paths.pairingAuthority, {
      onChannelCloseFailure: reportChannelCloseFailure,
    }),
  );
  const endpoint = options.socket ?? defaultLocalEndpoint(options.dataDir);
  // Endpoint ownership is the cross-process single-writer boundary. Pairing
  // recovery runs only after this process has won that boundary, so a losing
  // second serve attempt cannot mutate or cancel live authority state.
  const server = await serveLocalSocket({
    endpoint,
    dataDir: options.dataDir,
    service,
    onOwned: () => service.initialize({ seed: false }),
  });
  await waitForTermination();
  await server.close();
  await service.close();
  return 0;
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

function parseCli(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.length > 16 || argv.some((argument) => argument.length > 4_096)) {
    throw new Error("A bounded hostd mode and arguments are required");
  }
  const mode = argv[0];
  if (mode !== "serve" && mode !== "connect" && mode !== "probe" && mode !== "seed") {
    throw new Error(`Unknown hostd mode: ${mode ?? "(missing)"}`);
  }

  let dataDir = resolveHostDataDir();
  let socket: string | undefined;
  let stdio = false;
  let json = false;
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
    if (argument === "--data-dir" || argument === "--socket") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires one value`);
      index += 1;
      if (argument === "--data-dir") dataDir = resolve(value);
      else socket = value;
      continue;
    }
    throw new Error(`Unknown hostd argument: ${argument ?? "(missing)"}`);
  }

  if (mode === "connect" && !stdio) throw new Error("connect requires the fixed --stdio transport");
  if (mode !== "connect" && stdio) throw new Error("--stdio is valid only with connect");
  if (mode === "probe" && !json) throw new Error("probe requires --json");
  if (mode !== "probe" && json) throw new Error("--json is valid only with probe");
  if (mode !== "serve" && socket) throw new Error("--socket is valid only with serve");
  return { mode, dataDir, socket, stdio, json };
}

function usage(): string {
  return [
    "Usage:",
    "  prime-agent-hostd serve [--socket <local-endpoint>] [--data-dir <directory>]",
    "  prime-agent-hostd connect --stdio [--data-dir <directory>]",
    "  prime-agent-hostd probe --json [--data-dir <directory>]",
    "  prime-agent-hostd seed [--data-dir <directory>]",
  ].join("\n");
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolvePromise();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
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
