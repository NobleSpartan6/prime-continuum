import type {
  VerifiedPairingCeremonyAdmission,
  VerifiedPairingCeremonyEvidence,
  VerifiedPairingCommit,
  VerifiedPairingReservation,
} from "../../src/hostd/pairing/authority";

export interface TestVerifiedPairingCeremonies {
  readonly admission: VerifiedPairingCeremonyAdmission;
  issueReservation(input: VerifiedPairingReservation): object;
  issueCommit(input: VerifiedPairingCommit): object;
}

/** Each test authority receives a provider-like, isolated one-shot token map. */
export function createTestVerifiedPairingCeremonies(): TestVerifiedPairingCeremonies {
  const issued = new WeakMap<object, VerifiedPairingCeremonyEvidence>();
  const admission: VerifiedPairingCeremonyAdmission = Object.freeze({
    consume(capability: unknown): VerifiedPairingCeremonyEvidence | undefined {
      if (!capability || typeof capability !== "object") return undefined;
      const evidence = issued.get(capability);
      if (!evidence) return undefined;
      issued.delete(capability);
      return evidence;
    },
  });

  return Object.freeze({
    admission,
    issueReservation(input: VerifiedPairingReservation): object {
      const capability = Object.freeze({});
      issued.set(
        capability,
        Object.freeze({
          phase: "reservation" as const,
          reservation: Object.freeze(structuredClone(input)),
        }),
      );
      return capability;
    },
    issueCommit(input: VerifiedPairingCommit): object {
      const capability = Object.freeze({});
      const commit = structuredClone(input);
      Object.freeze(commit.grantedScopes);
      issued.set(
        capability,
        Object.freeze({
          phase: "commit" as const,
          commit: Object.freeze(commit),
        }),
      );
      return capability;
    },
  });
}
