# Public repository security review

## Executive summary

The reviewed working tree contains no confirmed credential, private key, OAuth token, or developer-specific absolute path intended for publication. Synthetic secrets and paths remain in tests where they verify redaction and rejection behavior. Public repository defaults now ignore common local credential files, document the runtime trust boundary, provide a private-reporting policy, and retain notices for copied development skills.

This is a source review, not a guarantee about Git history, packaged dependency licenses, or a developer's untracked files. Run a dedicated history and artifact scanner before the first public release tag.

## Scope

- Electron 43 main/preload boundary
- React 19 renderer and Markdown projection
- root documentation, GitHub workflow, package metadata, ignored files, and copied skills
- current tracked files plus non-ignored working-tree files

## Findings

### PUB-SEC-001 — Private vulnerability reporting must be enabled

- **Severity:** Medium
- **Location:** `SECURITY.md:7-11` and repository settings
- **Evidence:** GitHub reported private vulnerability reporting as disabled on 2026-08-12. The source now directs sensitive reports to that channel when available.
- **Impact:** If the GitHub feature is disabled, a reporter has no direct repository-owned private intake channel and may disclose sensitive details publicly.
- **Fix:** Enable **Security → Private vulnerability reporting** before announcing the repository.
- **Mitigation:** `SECURITY.md` tells reporters to publish only a minimal request for a private channel when the feature is unavailable.
- **False-positive notes:** None. Close this item after the repository API reports private vulnerability reporting enabled.

### PUB-SEC-002 — Release signing is not configured

- **Severity:** Medium
- **Location:** `package.json:142-193` and `README.md:99-105`
- **Evidence:** The macOS identity is ad hoc and notarization is disabled; Windows artifacts are intentionally unsigned.
- **Impact:** A checksum can detect changed bytes after trusted acquisition but cannot authenticate the publisher. Public binary distribution would create avoidable impersonation and warning-dialog risk.
- **Fix:** Add owner-controlled Apple and Windows signing identities, notarization, and platform-native install/upgrade verification before publishing stable binaries.
- **Mitigation:** The README labels current artifacts as controlled development builds and states that no stable binary release exists.
- **False-positive notes:** This does not block publishing source code; it blocks presenting current binaries as a trusted stable release.

## Verified controls

- No `dangerouslySetInnerHTML`, direct HTML injection sink, dynamic code evaluation, or raw-HTML Markdown plugin was found in the renderer.
- The renderer CSP at `src/renderer/index.html:5-8` blocks non-local scripts, objects, and base-URL changes. `src/main/window-security.ts:4-16` enables context isolation and sandboxing while disabling Node integration and webviews.
- Renderer storage contains only bounded layout preferences and an opaque device identifier; provider credentials are not stored in Web Storage.
- Common local environment, private-key, certificate, OAuth, Playwright, and generated design-concept files are ignored by `.gitignore:15-31`.
- The GitHub workflow uses frozen dependencies, pinned action commits, read-only contents permission, typechecking, tests, and a source build on Linux, Windows, and macOS.
- Copied development skills now have an attribution index and the Apache 2.0 text required by the Playwright CLI skill.
- GitHub reports the repository as public, with secret scanning and push protection enabled. The latest source-gate run for committed `HEAD` succeeded; the current dirty candidate still requires a new CI run.

## Publication checks still requiring an owner

1. Enable GitHub private vulnerability reporting and Dependabot security updates. Secret scanning and push protection are already enabled.
2. Configure branch protection or a repository ruleset for the source gates; GitHub currently reports none.
3. Add a concise GitHub description, topics, and social preview; the repository currently has no description, homepage, or topics.
4. Run an organization-approved secret and license scan over full Git history and the final release artifacts.
5. Do not publish binary releases until the signing findings above are closed.

## Verification performed

- High-signal current-tree scans for private-key headers, common provider-token prefixes, credential-bearing URLs, credential-shaped filenames, and developer-specific home paths found no publishable secret. Matching values in tests were synthetic redaction fixtures.
- Local Markdown targets in the public repository documents resolved successfully.
- Every GitHub YAML file parsed successfully.
- `corepack pnpm typecheck` passed.
- The documentation and cross-platform workflow suites passed 14/14 tests.
- `git diff --check` passed.

## Verdict

**Needs changes for a binary release.** Source publication is acceptable after review and commit of this public-repository slice. Private vulnerability reporting, repository rules, public metadata, full-history scanning, and signed distribution remain owner-controlled launch work.
