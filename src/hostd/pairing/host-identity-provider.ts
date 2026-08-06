import type { HostIdentityInput, HostIdentityMetadata } from "./authority";

export type HostIdentityProviderUnavailableCode =
  | "provider_not_installed"
  | "credential_missing"
  | "credential_locked"
  | "credential_inaccessible"
  | "credential_corrupt";

export type HostIdentityRecoveryAction =
  | "install_provider"
  | "restore_identity"
  | "unlock_credentials"
  | "repair_permissions"
  | "review_identity";

export type HostIdentityProviderLoadResult =
  | {
      readonly status: "ready";
      readonly hostId: string;
      /** Exact public metadata and opaque handle verified by the provider. */
      readonly identity: HostIdentityInput;
    }
  | {
      readonly status: "unavailable";
      readonly code: HostIdentityProviderUnavailableCode;
      readonly recoveryAction: HostIdentityRecoveryAction;
    };

/**
 * Minimal custody boundary for the architecture checkpoint. It verifies an
 * already-configured opaque key reference without returning private key bytes.
 * Provisioning and key operations remain blocked until the cross-platform
 * crypto architecture is selected and reviewed.
 */
export interface HostIdentityKeyProvider {
  readonly backend: string;
  loadExisting(input: {
    readonly hostId: string;
    readonly expected: Readonly<HostIdentityMetadata>;
    readonly signal: AbortSignal;
  }): Promise<HostIdentityProviderLoadResult>;
  close(): void | Promise<void>;
}

/** Production default: no private-key backend is implied or silently emulated. */
export class UnavailableHostIdentityKeyProvider implements HostIdentityKeyProvider {
  readonly backend = "unavailable";

  async loadExisting(): Promise<HostIdentityProviderLoadResult> {
    return {
      status: "unavailable",
      code: "provider_not_installed",
      recoveryAction: "install_provider",
    };
  }

  close(): void {}
}
