# Prime Agent relay server

This package is the first deployable routing boundary for remote Prime Agent
channels. It accepts one-shot 256-bit bearer grants over an exact WebSocket
upgrade, assigns bounded device channels, and forwards validated
`prime-relay-routing.v1` binary frames byte-for-byte between one host and its
authorized devices.

```ts
import { readFile } from "node:fs/promises";
import {
  InMemoryRelayGrantStore,
  PrimeRelayServer,
} from "@prime-agent/relay-server";

const grants = new InMemoryRelayGrantStore();
const hostToken = grants.issue({
  routeId: "opaque-route-id",
  endpointId: "opaque-host-endpoint-id",
  role: "host",
  expiresAt: Date.now() + 60_000,
});

const relay = new PrimeRelayServer({
  grantStore: grants,
  host: "0.0.0.0",
  port: 8443,
  tls: {
    key: await readFile("/run/secrets/relay-key.pem"),
    cert: await readFile("/run/secrets/relay-cert.pem"),
  },
});
await relay.start();
```

Clients connect only to `/relay`, request the
`prime-relay-routing.v1` subprotocol, and send the token as
`Authorization: Bearer <token>`. Tokens in URLs are rejected. The in-memory
store retains only each token's SHA-256 digest and atomically consumes the
grant at authentication. Because this is a native-only endpoint, upgrades
carrying a browser `Origin` header are rejected before a one-shot grant is
consumed.

The relay never queues offline messages. A `forward_result` status of `0`
means only that the frame entered the bounded online peer socket; it is not an
application receipt. Status `1` means unavailable and status `2` means the
peer crossed its backpressure bound.

Each accepted connection has a 60-second idle timeout by default. Operators
may configure `limits.idleConnectionTimeoutMs` only from 1 second through 10
minutes. The timer is refreshed only after that connection's own client data
frame passes binary, size, rate, codec, kind, and channel-binding policy. Peer
data, server-authored routing controls, rejected text, malformed frames,
client-authored controls, and policy/rate violations never refresh it. A future
secure client must send authenticated heartbeat data when otherwise silent.
Expiry closes the WebSocket with application code
`4000` and reason `idle_timeout`; connection close and server stop cancel the
timer. The optional scheduler and clock injections exist for deterministic
tests. A custom scheduler is rejected unless the explicit insecure-loopback
test flag is set on a loopback host; ordinary TLS/production construction
therefore always uses the default unref'ed Node timer.

From the repository root, the canonical `pnpm typecheck`, `pnpm test`, and
`pnpm build` scripts include this package exactly once. `pnpm self-build` uses
the same relay-inclusive typecheck/test gates and its relay-inclusive
`build:release` gate; cross-platform source CI uses the three canonical root
commands rather than duplicating package tests in another workflow step. Relay
builds run as a supervised step inside the shared repository workflow lock,
including release, packaging, distribution, and visual-verification workflows;
they do not mutate `dist/` before build admission succeeds.

## Security boundary and current non-claims

- Production construction requires TLS configuration. Plain `ws://` is
  available only with an explicit test option on a loopback listener.
- The router validates fixed routing metadata but does not implement E2EE.
  Callers must encrypt and authenticate every payload before it reaches this
  package; otherwise the relay process can observe the supplied bytes even
  though it never parses, persists, or logs them.
- The included grant store is process-local and ephemeral. This slice has no
  admin API, durable/multi-node grant database, pairing flow, key storage,
  revocation authority, secure-channel handshake, or mobile client.
- The idle timeout is a resource bound, not peer authentication, a liveness
  proof, a maximum session-age/rekey policy, or end-to-end delivery evidence.
  Accepted traffic can keep a connection open until another bound or shutdown
  applies.
- The relay is deliberately not wired into host capabilities or the desktop
  renderer yet. Its passing tests establish an isolated transport boundary,
  not production remote control.
