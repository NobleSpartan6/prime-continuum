# Interface review

Verdict: **Pass for the Phase 0/Phase 1 desktop foundation; not a production remote-release approval.** The workbench is coherent, accessible, and restricted to implemented native capabilities. Phone control has no product entry point and remains gated by the engineering items in `implementation-status.md`.

Review order followed the requested `make-interfaces-feel-better` workflow, with `better-layout` and `better-accessibility` applied to responsive structure and interaction semantics.

## Findings

| Priority | Area | Finding | Resolution / evidence |
| --- | --- | --- | --- |
| P1 | Accessibility | Narrow sidebar and inspector drawers initially allowed focus behind the scrim. | Resolved with overlay focus containment, Escape dismissal, and trigger focus restoration; covered by renderer tests. |
| P1 | Product honesty | Model, new-thread, search, attachment, and resident controls risked implying native operations that did not exist. | Resolved by exposing a read-only runtime model catalog, implementing real project/thread search, shipping native local resident setup through a path-private folder picker and crash-safe lifecycle transaction, and enabling Prompt/Stop only after the exact new or reattached binding is projection-ready. Remote attachment and other deferred operations remain explicit informational gates; no clickable no-op remains. |
| P1 | Product honesty | Seeded renderer-fixture host data could read like live OpenSSH verification. | Resolved by removing browser access to Add computer. The product entry is native-only and its wording is tied to the actual OpenSSH probe result. |
| P1 | Host setup | Native onboarding did not state that interactive OpenSSH prompts are outside the current UI bridge. | Resolved in the Add computer description: password, passphrase, and new host-key prompts must be completed in a terminal before retrying in this build. |
| P1 | Handoff | The completion view could rename the reviewed source after authority changed. | Resolved by retaining the plan's immutable source identity; regression-tested. Native commit is separately gated until a destination coordinator exists. |
| P2 | Layout | Sheet content could extend below its footer at the desktop QA viewport. | Resolved with a bounded grid frame and independently scrollable body. At 1278×1248, the 864 px dialog and footer end at the same 1056 px boundary. |
| P2 | Touch / input | Compact controls were smaller than a comfortable coarse-pointer target. | Resolved with 44 px minimum targets under `pointer: coarse`. |
| P2 | Motion | Frequent navigation items inherited unnecessary transitions. | Resolved. Only occasional controls and responsive drawers transition; frequent thread/project/file/tab navigation does not. |
| P1 | Mobile architecture | An interim LAN server would expose host authority and create a second security model. | Rejected. No mobile product surface is exposed; real control requires an outbound untrusted relay, application E2EE, device-bound scopes, revocation, and a verified mobile client. |
| P1 | Mobile honesty | A stand-in QR, code, phone, or approval could look like working pairing. | Resolved by removing mobile entry points until the real pairing and command path exists. |
| P1 | Projection truth | A failed A→B thread selection could temporarily label A's evidence, agents, and attention as B. | Resolved by clearing materialization while B loads, requiring an exact returned thread ID, and restoring A only when the same host/selection generation fails. Regression-tested. |
| P1 | Operation safety | Escape or backdrop dismissal could hide an in-flight host install or authority-changing handoff while it continued. | Resolved with dismissibility guards, busy state, and locked handoff choices; regression-tested. |
| P1 | Responsive layering | Sidebar, inspector, and palette could stack independent focus traps at narrow widths. | Resolved with mutually exclusive layer state, modal dialog semantics, inert backing content, and one full-screen scrim; regression-tested. |
| P1 | Thread layout | Simultaneous connection and refresh notices could create implicit grid rows and displace the transcript/composer. | Resolved with one permanent notice grid region that contains both messages. |
| P1 | Runtime truth | Infrastructure concepts risked becoming global product destinations or implying fleet-wide health. | Resolved by keeping them scoped to the active thread and organizing the contextual Runtime panel around Status, Reported work, Delivery, and Usage. Cached and unreported states remain explicit. |
| P1 | Upstream trust | Prime Agent installation could be confused with Continuim host installation or sandboxing. | Resolved with the official macOS/Linux installer as terminal-only help, a separately named Continuim host service, and an explicit user-permissions / not-a-security-sandbox warning. |
| P1 | Keyboard and high contrast | Corrected Add computer fields could retain stale alerts, and forced-colors mode could suppress composer and palette focus. | Resolved by clearing field-local errors on correction and restoring 2 px `Highlight` outlines under forced colors; regression-tested. |
| P2 | Drawer operation | The narrow project drawer relied on Escape or the scrim for dismissal. | Resolved with an in-drawer Close action that participates in the focus loop and restores the opener. |
| P2 | Visual hierarchy | Deferred destinations competed with the active thread. | Resolved by removing unavailable mobile entry points, keeping model metadata native-only, and leaving the active durable thread as the primary surface. |

## Research basis and information architecture

The implementation follows durable patterns from primary platform guidance:

- [VS Code's workbench model](https://code.visualstudio.com/docs/editing/userinterface) informed one dominant editor/thread surface, secondary navigation, and contextual evidence rather than three equally weighted panes.
- [VS Code command-palette guidance](https://code.visualstudio.com/api/ux-guidelines/command-palette) informed a keyboard-first `Ctrl/Cmd+K` path that exposes only real navigation and supported actions.
- [Material 3 adaptive layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) informed a separate compact supervision projection rather than shrinking the complete desktop workbench onto a phone.
- [WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) and [focus-appearance guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance) informed coarse-pointer hit areas, visible focus, and keyboard operation.
- [Apple's Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) reinforced clear hierarchy, platform-familiar controls, and safe-area-aware mobile navigation.
- [Hermes Desktop's design notes](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/DESIGN.md) reinforced chat as home, flat composition, non-focus-stealing background updates, persistent expensive panes, and explicit keyboard ownership.
- [Prime Agent's architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md) and [RPC reference](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md) informed truthful client/runtime ownership, steering, recovery snapshots, schedules, and reported usage.

The resulting desktop defaults to navigation plus the active durable thread. The inspector is closed until evidence or context is requested, and execution location stays metadata instead of becoming a separate product mode. Deferred mobile concepts do not appear in navigation.

An earlier GPT Pro review was used as a read-only architecture, taste, and ship review for the desktop foundation. Its scope-separated verdict was **GO** for the implemented desktop boundary and **NO-GO** for production remote/mobile positioning. It specifically rejected a LAN listener, stand-in pairing artifacts, invented infrastructure telemetry, and treating terminal installer guidance as provisioning. That historical review predates the resident continuity checkpoint; the current executable boundary and verification evidence live in `implementation-status.md` and the repository's automated gates.

## Accessibility and interaction coverage

- Semantic banner, main, complementary regions, named navigation, transcript region, form, tablist/tabpanels, dialogs, and live status regions.
- Skip link targets the main thread; modal and drawer focus is restored to its trigger.
- Inspector tabs support arrow-key activation; sheets and the composer are keyboard operable.
- The command palette is a labeled combobox/listbox with arrow, Enter, and Escape handling; its results are real threads, projects, and supported commands.
- Status never depends on color alone. Forced-colors and increased-contrast modes have explicit rules.
- Coarse-pointer hit targets are at least 44×44 px.

## Typography and color

- System-first UI typography avoids a web-font startup dependency, keeps body copy at 15 px, metadata at 13 px, and uses bounded line lengths and balanced/pretty wrapping where helpful.
- Palette tokens use OKLCH for light, dark, and increased-contrast themes.
- Calculated key WCAG contrast ratios:
  - light: body 15.46:1, secondary 8.11:1, muted 4.96:1, primary button 5.78:1;
  - dark: body 16.82:1, secondary 9.51:1, muted 6.62:1, primary button 6.85:1;
  - semantic text on semantic soft surfaces ranges from 4.93:1 to 7.40:1.

## Animation review

| Check | Result |
| --- | --- |
| Custom UI easing | `cubic-bezier(0.23, 1, 0.32, 1)` |
| Drawer easing | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Interaction duration | 100–120 ms |
| Drawer duration | 180 ms |
| Press feedback | `scale: 0.96` |
| Expensive animated properties | None; transitions use scale, translate, color, background, border, shadow, and visibility |
| `transition: all` | None |
| Reduced motion | All transitions and spinners are inside `prefers-reduced-motion: no-preference` |
| Continuous animation | Only meaningful in-progress spinners, using linear rotation |

Considered but rejected: decorative entrance sequences, list-item motion, spring/bounce easing, gradient-heavy surfaces, oversized marketing typography, and remote-only navigation. They would add noise or contradict the durable-thread-first product model.
