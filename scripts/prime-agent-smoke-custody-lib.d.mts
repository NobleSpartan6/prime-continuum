export interface PrimeAgentCustodyProof {
  readonly canonicalHostDataRoot: string;
  readonly canonicalCustodyParent: string;
  readonly canonicalAgentDirectory: string;
  readonly custodyParentIdentity: string;
  readonly agentDirectoryIdentity: string;
  readonly platform: NodeJS.Platform;
  readonly currentUserSid?: string;
}

export interface PrimeAgentSmokeHostdModule {
  readonly resolvePrimeAgentRuntimeDirectory: (
    hostDataRoot: string,
    options?: { readonly platform?: NodeJS.Platform; readonly programDataRoot?: string },
  ) => string;
  readonly HostScopedPrimeAgentAuthSecurity: new (options?: {
    readonly platform?: NodeJS.Platform;
    readonly programDataRoot?: string;
  }) => {
    prepareAndVerify(hostDataRoot: string, agentDirectory: string): Promise<PrimeAgentCustodyProof>;
    assertStillSecure(proof: PrimeAgentCustodyProof): Promise<void>;
  };
}

export interface PrimeAgentSmokeCustody {
  readonly agentDirectory: string;
  assertInitiallyAbsent(): Promise<void>;
  captureExisting(): Promise<PrimeAgentCustodyProof | undefined>;
  removeAfterConfirmedShutdown(options: {
    readonly confirmedCleanShutdown: boolean;
  }): Promise<{ readonly removed: boolean; readonly entries: number; readonly bytes: number }>;
}

export function createPrimeAgentSmokeCustody(options: {
  readonly hostDataRoot: string;
  readonly hostdModule: PrimeAgentSmokeHostdModule;
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}): Promise<PrimeAgentSmokeCustody>;
