# Native launch-proof capture

The native launch-proof lane records an operator-completed Prime RLM run from an already-running packaged Prime Continuim window. It is separate from fixture visual QA. It does not launch the app, sign in, invoke a provider, submit a prompt, start a resident, or create synthetic renderer state.

The collector changes only presentation state: it opens the inspector and selects the **Session** and **Review** tabs needed for the two screenshots. It leaves **Review** selected when capture completes.

## Prerequisites

1. Run the canonical candidate gate and retain its passing receipt:

   ```bash
   pnpm self-build
   pnpm verify:self-build-receipt .prime-continuim-self-build/receipts/<receipt>.json
   ```

2. Without changing the candidate, build the verified local package with `pnpm package`.
3. Launch that package yourself with a loopback-only DevTools port. On Apple silicon macOS, for example:

   ```bash
   open -n "release/mac-arm64/Prime Continuim.app" --args \
     --remote-debugging-address=127.0.0.1 \
     --remote-debugging-port=9222
   ```

   Use `release/mac/Prime Continuim.app` on Intel macOS. Choose an unused local port. A DevTools port can execute code in the renderer; do not bind it to another interface or leave the proof app running after capture.

4. In that native window, complete a real Prime RLM run, wait for its terminal assistant outcome, and leave the exact thread selected. The run must have at least one completed child with returned result evidence.

## Capture

From the repository root, attach the collector to the already-running window:

```bash
node scripts/capture-native-launch-proof.mjs \
  --debug-port 9222 \
  --self-build-receipt .prime-continuim-self-build/receipts/<receipt>.json
```

The command fails closed unless all of these checks pass:

- exactly one DevTools page is the packaged `file:` renderer inside `app.asar`; preview URLs, preview user agents, HUD surfaces, and non-loopback debugger endpoints are rejected;
- `app.asar` main, preload, and renderer trees match the supplied passing self-build receipt byte-for-byte;
- the packaged runtime pointer matches the same receipt's exact release, platform, architecture, tree, manifest, and pointer digest;
- native bootstrap reports an online local-socket host whose exact hostd bundle digest matches the packaged hostd;
- the live hostd runtime trust anchor and ready runtime target match the packaged attestation's exact release, build identity, platform, architecture, manifest, tree, and file inventory;
- a read-only `requestSnapshot` succeeds for the cache-selected thread and exact latest cursor;
- workbench heading, selected sidebar thread, live snapshot title, host, execution generation, and cursor agree;
- the latest terminal assistant outcome belongs to that same latest cursor and references materialized assistant text;
- the native **Session** view visibly renders the RLM hierarchy and at least one returned child result;
- the native **Review** view visibly renders the outcome as current live snapshot proof, never `Last reported` cached state;
- a second live read proves thread, host, execution generation, and cursor did not change during capture.

Success publishes a new no-replace directory under `out/native-launch-proof/run-<uuid>/` containing:

- `rlm.png` — native Session view with visible RLM delegation evidence;
- `outcome.png` — native Review view with the visible final outcome;
- `manifest.json` — canonical path-free correlation evidence.

The manifest hashes private host, thread, generation, cursor, assistant text, and child identities rather than recording their raw values. It ties the images to the self-build source commit and candidate-tree digest, the exact packaged app archive, hostd bundle, three UI/code trees, and the live and packaged Prime Agent runtime identity. Capture filenames are relative; no local filesystem path is stored.

The screenshots themselves are full native-window images and may visibly contain workspace names, conversation text, or other operator content. Review them before sharing.

## Evidence boundary

This lane proves local byte correlation and visible native state for one already-completed run. It does not authenticate the receipt author or machine, verify Apple signing/notarization, prove installer provenance, independently attest the candidate-controlled build, inspect provider billing, or prove that the visible answer is correct. The manifest records those boundaries explicitly. Its SHA-256 is tamper-detection and correlation evidence, not a signature.

The existing `pnpm verify:renderer-visual` workflow remains fixture-based visual regression QA. Its preview routes and captures are intentionally unchanged and cannot satisfy native launch proof.
