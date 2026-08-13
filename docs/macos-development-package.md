# macOS development package

`pnpm package` builds and verifies a native macOS application directory. `pnpm dist` applies the same runtime and resident-lifecycle gates, then creates and verifies a drag-to-Applications DMG. Neither workflow publishes an artifact, discovers a signing certificate, uses notarization credentials, or makes a production distribution claim.

The workflow is intentionally bounded to the current `arm64` or `x64` host and produces:

```text
release/mac-arm64/Prime Continuim.app   # Apple silicon
release/mac/Prime Continuim.app         # Intel
release/Prime-Continuim-<version>-macos-arm64.dmg  # Apple silicon dist
release/Prime-Continuim-<version>-macos-x64.dmg    # Intel dist
```

Before Electron Builder runs, the workflow validates the exact reviewed build configuration and replaces the child environment with a signing/publishing-sanitized projection. The app is signed with the explicit ad-hoc identity (`-`), while notarization is disabled. This is sufficient for local development launch on the machine that built it; it is not Developer ID signing, notarization, Gatekeeper distribution approval, or installer evidence.

The DMG lane additionally removes only exact stale generated destinations, disables update metadata and blockmaps, forces the reviewed UDZO format and cross-architecture name, and keeps macOS system tools ahead of the exact Node/Corepack directory in `PATH`. Verification attaches through a private `/private/tmp` mount with `-readonly -verify -plist`, binds the returned devices against a pre-attach baseline, requires `diskutil` to report non-writable disk-image media, compares the mounted app byte-for-byte to the directory package, runs the hidden packaged-app smoke from the mounted image, detaches the exact whole device, and proves all returned device IDs and mount contents are gone. Only then is the DMG rehashed and its create-new checksum synced.

After packaging, the verifier fails closed unless all of the following hold:

- `app.asar` contains byte-exact same-run main, preload, and renderer outputs and no external host/runtime trees;
- the ASAR integrity record matches the exact packaged ASAR header, with embedded integrity validation and `OnlyLoadAppFromAsar` enabled and `RunAsNode` disabled in the desktop Electron framework;
- the external hostd and runtime seed match the same-run build;
- the packaged standalone Node and complete browser Electron distribution match their pinned source bytes;
- desktop Electron, standalone Node, and browser Electron resolve to three distinct files with three distinct SHA-256 digests;
- the runtime attestation binds the exact seed, standalone Node, and browser Electron identities;
- the app has only an ad-hoc top-level identity with the expected bundle identifier;
- a hidden packaged GUI reaches the real main/preload/renderer/hostd/runtime readiness marker, then the GUI and hostd stop cooperatively with no isolated-state process residue before temporary state is removed.

Run from the repository root with the pinned Node and pnpm versions:

```bash
corepack pnpm package
open "release/mac-arm64/Prime Continuim.app"

# Or build the verified ad-hoc disk image:
corepack pnpm dist
open "release/Prime-Continuim-<version>-macos-arm64.dmg"
```

On Intel macOS, use the x64 paths shown above. The app is ad-hoc signed; the DMG container is unsigned, and neither is notarized. Another Mac may require an explicit Finder **Open** confirmation or may reject the app under managed Gatekeeper policy. If verification, detach, or shutdown is uncertain, the command fails; it does not reinterpret an incomplete artifact as usable evidence. Use `pnpm self-build` separately for the canonical source/build readiness gate described in `AGENTS.md`.

## Production-distribution readiness contract

The local `pnpm dist` lane remains deliberately ad-hoc. A separate credential-free gate records exactly why its output is not yet a downloadable production release:

```bash
pnpm verify:macos-distribution-readiness -- --config-only
pnpm verify:macos-distribution-readiness -- --preflight
```

Both commands are read-only. They never inspect a keychain, read notarization credentials, submit to Apple, staple a ticket, sign code, or publish an artifact. `--config-only` verifies the public source contract and currently blocks because `macos-distribution-policy.json` has no reviewed Apple Team ID and the only implemented builder remains the development lane. `--preflight` additionally hashes the exact app and DMG, enumerates every nested Mach-O and code bundle into path-free count/digest evidence, and runs the Apple signature, strict-seal, system-policy, Gatekeeper, and stapler checks. Findings contain bounded category codes, counts, and remediation copy; they never include a local filesystem path or raw tool output.

The production gate rejects unsigned or ad-hoc nested code, a Team-ID mismatch, missing secure timestamps or hardened runtime, `com.apple.security.get-task-allow`, broken strict signatures, an unsigned DMG, absent or invalid app/DMG tickets, failed `syspolicy_check` or `spctl`, and missing or inconsistent correlation evidence. The future signed stage must publish the exact sibling `<dmg>.signed-stage.json` only after nested code is signed and the outer app is sealed, but before the DMG is created. The future credentialed notarization lane must publish `<dmg>.notary-receipt.json`, binding one accepted submission and notary-log digest to the exact DMG, signed-stage bytes, Team ID, bundle ID, and architecture. These JSON files are correlation records, not Apple authentication; positive Apple-tool checks and a fresh quarantine-bearing install test remain mandatory.

The packaged Info.plist now carries explicit purpose strings for user-selected Desktop, Documents, Downloads, network-volume, and removable-volume workspaces. Selection remains user initiated through the native folder picker; the app does not request Full Disk Access or Accessibility access by default.

For an attach-only record of an operator-completed real Prime RLM run in this packaged app, use the separate [native launch-proof capture](native-launch-proof.md). It does not replace package verification or fixture visual QA.
