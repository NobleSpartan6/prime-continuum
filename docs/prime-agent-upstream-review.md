# Prime Agent upstream review

Prime Continuim tracks Prime Agent deliberately. The desktop may review the
latest upstream release and documentation, but it runs only the exact stable
release pinned, locked, hashed, and attested by this repository.

## Review procedure

Run these read-only checks before changing the integration or making a
compatibility claim:

```sh
gh api repos/PrimeIntellect-ai/prime-agent/releases/latest \
  --jq '{tag_name,published_at,target_commitish,html_url}'

gh api 'repos/PrimeIntellect-ai/prime-agent/git/trees/<tag>?recursive=1' \
  --jq '.tree[] | select(.type=="blob") | select((.path|endswith(".md")) or (.path|endswith(".mdx"))) | .path'

gh api 'repos/PrimeIntellect-ai/prime-agent/compare/<tag>...main' \
  --jq '.files[]? | select((.filename|endswith(".md")) or (.filename|endswith(".mdx"))) | [.status,.filename,.patch]'
```

Read the complete upstream release notes and every changed document reported by
the comparison. Treat `main` documentation as forward-looking evidence, not a
stable runtime contract. Review source and tests when documentation changes a
protocol or behavior that Continuim depends on.

For an upgrade, update all exact version, protocol, schema, package, asset, and
digest pins together. Rebuild and verify the runtime before changing product
claims. Never replace the pinned runtime with an ambient install.

## Latest review

Reviewed on 2026-08-12.

- Latest stable release: `v0.7.2`, published 2026-08-11.
- Release commit: `83a0f9f9566219551fcb6ffaf7f519a815749a58`.
- Upstream `main` reviewed at:
  `0987c1ba7637cbcb99afe9efe1180b838a0aa958` (2026-08-12).
- Continuim runtime pin: `v0.7.2`; no runtime upgrade is required.
- Release documentation inventory: 96 Markdown/MDX files, including the coding
  agent architecture, daemon, RPC, RLM, sessions, providers, models, skills,
  extensions, SDK, examples, bundled skills, fixtures, and changelogs. The
  inventory contains 910,397 bytes. Its canonical `path<TAB>git-blob<TAB>size`
  manifest SHA-256 is
  `c62df36a34c00d53371bca9d22e20f212dd54ac4a4b75d036d574e04db61ae89`.
- Upstream `main` documentation changes since `v0.7.2`: nine files. Seven add
  the forward-looking `max` thinking level to AI/model/provider/extension/RPC/
  SDK/settings documentation; two changelogs describe fullscreen terminal link
  handling. These changes are not part of the stable `v0.7.2` contract and do
  not change Continuim's current runtime pin.
- The `v0.7.2` release contains the worker/session recovery fixes Continuim
  depends on: disconnected workers no longer report ready, timed-out stops
  finish cleanup, zombies are not considered alive, and stale registrations
  self-heal when a session is opened or resumed.
- The release dependency graph still includes `extract-zip@2.0.1`, and the
  shipped CLI bundle embeds the same implementation. GitHub advisory
  `GHSA-jmr9-qjv8-65gv` reports an unpatched symlink-target traversal for every
  published `extract-zip` version. Upstream `main` still declares `^2.0.1`, so
  there is no verified Prime Agent release to upgrade to for this issue.
- Continuim therefore retains Prime Agent `v0.7.2` and applies one bounded,
  hash-gated runtime assembly substitution: every `extract-zip` resolution and
  the exact embedded bundle block delegate to
  `@electron-internal/extract-zip@1.0.5`. That Electron-owned package has no
  runtime dependencies or install script, ships reviewed macOS/Linux/Windows
  prebuilds, and hardens symlink containment. Runtime assembly rejects source
  drift, prunes to the target prebuild, performs a real ZIP extraction smoke,
  and attests the changed runtime tree. The effective minimum Node version is
  consequently 22.12 rather than upstream's 22.8.

Official sources:

- <https://github.com/PrimeIntellect-ai/prime-agent>
- <https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.2>
- <https://github.com/advisories/GHSA-jmr9-qjv8-65gv>
- <https://github.com/electron/extract-zip/releases/tag/v1.0.5>
