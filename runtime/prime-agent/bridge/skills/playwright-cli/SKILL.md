---
name: playwright-cli
description: Drive the verified Prime Continuim browser for navigation, interaction, snapshots, and page diagnostics.
allowed-tools: Bash(playwright-cli:*)
---

# Verified browser automation

Use `playwright-cli` directly. Prime Continuim supplies the executable and
browser engine for the exact resident session; never install another browser,
use `npx`, or select an ambient Chrome profile.

```bash
playwright-cli doctor --json
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli click e3
playwright-cli fill e5 "value"
playwright-cli close
```

Named sessions use `-s=<name>`. Use references from the latest snapshot. The
commands and element targeting otherwise follow Playwright CLI semantics.

The packaged bridge supports the verified Chromium engine hosted by Electron.
External CDP endpoints, browser channels, arbitrary profiles, browser installs,
extension attachment, and persistent profiles are intentionally unavailable.
Every `open` uses a clean ephemeral profile for its named session. Discovery of this
skill does not itself prove execution readiness; `doctor` is the path-free live
probe when a task needs confirmation.
