import { createHash, randomBytes } from "node:crypto";

export type RelayEndpointRole = "host" | "device";

export interface RelayGrant {
  readonly routeId: string;
  readonly endpointId: string;
  readonly role: RelayEndpointRole;
  readonly expiresAt: number;
}

/**
 * A grant lookup must atomically consume the digest. Implementations must not
 * retain or log the presented bearer token.
 */
export interface RelayGrantStore {
  consumeSha256(digestHex: string, now: number): Promise<RelayGrant | null>;
}

export interface IssueRelayGrantInput extends RelayGrant {
  /** Test seam. Production callers should omit this and use generated entropy. */
  readonly tokenBytes?: Uint8Array;
}

/**
 * Minimal ephemeral grant store for a single relay process. Only SHA-256
 * digests are retained; the returned 256-bit bearer token is never stored.
 */
export class InMemoryRelayGrantStore implements RelayGrantStore {
  readonly #grants = new Map<string, RelayGrant>();

  issue(input: IssueRelayGrantInput): string {
    assertGrant(input);
    const tokenBytes = input.tokenBytes === undefined ? randomBytes(32) : new Uint8Array(input.tokenBytes);
    if (tokenBytes.byteLength !== 32) {
      throw new TypeError("Relay bearer tokens must contain exactly 256 bits");
    }

    const digestHex = sha256Hex(tokenBytes);
    if (this.#grants.has(digestHex)) {
      throw new Error("Relay bearer token digest is already registered");
    }

    this.#grants.set(digestHex, {
      routeId: input.routeId,
      endpointId: input.endpointId,
      role: input.role,
      expiresAt: input.expiresAt,
    });
    const encoded = Buffer.from(tokenBytes).toString("base64url");
    tokenBytes.fill(0);
    return encoded;
  }

  registerSha256(digestHex: string, grant: RelayGrant): void {
    assertDigest(digestHex);
    assertGrant(grant);
    if (this.#grants.has(digestHex)) {
      throw new Error("Relay bearer token digest is already registered");
    }
    this.#grants.set(digestHex, { ...grant });
  }

  async consumeSha256(digestHex: string, now: number): Promise<RelayGrant | null> {
    assertDigest(digestHex);
    const grant = this.#grants.get(digestHex);
    if (grant === undefined) {
      return null;
    }

    // Delete before checking expiry so both expired and valid credentials are
    // one-shot and concurrent retries cannot revive a grant.
    this.#grants.delete(digestHex);
    if (!Number.isFinite(now) || grant.expiresAt <= now) {
      return null;
    }
    return { ...grant };
  }

  get pendingCount(): number {
    return this.#grants.size;
  }
}

export function parseBearerToken(authorization: string | undefined): Uint8Array | null {
  if (authorization === undefined) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (match === null) {
    return null;
  }
  const encoded = match[1];
  if (encoded === undefined) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== encoded) {
    return null;
  }
  const result = new Uint8Array(bytes);
  bytes.fill(0);
  return result;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Relay grant digests must be lowercase SHA-256 hex");
  }
}

function assertGrant(value: RelayGrant): void {
  assertOpaqueIdentifier(value.routeId, "routeId");
  assertOpaqueIdentifier(value.endpointId, "endpointId");
  if (value.role !== "host" && value.role !== "device") {
    throw new TypeError("Relay grants require a host or device role");
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) {
    throw new TypeError("Relay grant expiry must be a non-negative epoch millisecond integer");
  }
}

function assertOpaqueIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} must be a bounded opaque identifier`);
  }
}
