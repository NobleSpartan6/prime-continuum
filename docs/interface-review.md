# Interface review

Verdict: **Pass for the Phase 0/Phase 1 desktop and read-only mobile-supervision foundation; not a production remote-release approval.** The workbench is coherent, accessible, and honest about inactive capabilities. Production phone control remains gated by the engineering items in `implementation-status.md`.

Review order followed the requested `make-interfaces-feel-better` workflow, with `better-layout` and `better-accessibility` applied to responsive structure and interaction semantics.

## Findings

| Priority | Area | Finding | Resolution / evidence |
| --- | --- | --- | --- |
| P1 | Accessibility | Narrow sidebar and inspector drawers initially allowed focus behind the scrim. | Resolved with overlay focus containment, Escape dismissal, and trigger focus restoration; covered by renderer tests. |
| P1 | Product honesty | Model, new-thread, search, attachment, and resident controls risked implying native operations that did not exist. | Resolved by exposing a read-only runtime model catalog, implementing real project/thread search, shipping native local resident setup through a path-private folder picker and crash-safe lifecycle transaction, and enabling Prompt/Stop only after the exact new or reattached binding is projection-ready. Remote attachment and other deferred operations remain explicit informational gates; no clickable no-op remains. |
| P1 | Product honesty | Seeded browser host data could read like live OpenSSH verification. | Resolved with `Preview sample`, `Host verification`, and an explicit statement that no live host key was checked. Native wording remains tied to the actual OpenSSH probe result. |
| P1 | Host setup | Native onboarding did not state that interactive OpenSSH prompts are outside the current UI bridge. | Resolved in the Add computer description: password, passphrase, and new host-key prompts must be completed in a terminal before retrying in this build. |
| P1 | Handoff | The completion view could rename the reviewed source after authority changed. | Resolved by retaining the plan's immutable source identity; regression-tested. Native commit is separately gated until a destination coordinator exists. |
| P2 | Layout | Sheet content could extend below its footer at the desktop QA viewport. | Resolved with a bounded grid frame and independently scrollable body. At 1278×1248, the 864 px dialog and footer end at the same 1056 px boundary. |
| P2 | Touch / input | Compact controls were smaller than a comfortable coarse-pointer target. | Resolved with 44 px minimum targets under `pointer: coarse`. |
| P2 | Motion | Frequent navigation items inherited unnecessary transitions. | Resolved. Only occasional controls and responsive drawers transition; frequent thread/project/file/tab navigation does not. |
| P1 | Mobile architecture | An interim LAN server would expose host authority and create a second security model. | Rejected. Companion Preview uses the existing projection; real control requires an outbound untrusted relay, application E2EE, device-bound scopes, and revocation. |
| P1 | Mobile honesty | A sample QR, code, phone, or approval could look like working pairing. | Resolved with a secure-relay gate, zero-device state, and informational unavailable-state callouts instead of pairing or composer controls. The preview creates no pairing or command material. |
| P1 | Mobile layout | Long thread details initially expanded the shell beyond the viewport and pushed bottom navigation out of reach. | Resolved by fixing the shell to one viewport and making only the main content region scroll. Browser geometry confirms the navigation remains at the viewport edge. |
| P1 | Projection truth | A failed A→B thread selection could temporarily label A's evidence, agents, and attention as B. | Resolved by clearing materialization while B loads, requiring an exact returned thread ID, and restoring A only when the same host/selection generation fails. Regression-tested. |
| P1 | Preview truth | Sample browser data could look like a native host projection in the mobile dialog and Companion. | Resolved with persistent `Browser preview · sample data` and `Preview simulation` labels; native uses the freshness-neutral `Native projection data` label. |
| P2 | Mobile focus | Entering/exiting Companion and replacing a thread row with detail initially lost the focused element. | Resolved with programmatic entry focus, row→heading focus, back-to-row restoration, and return to the originating Mobile or command-palette trigger. |
| P1 | Operation safety | Escape or backdrop dismissal could hide an in-flight host install or authority-changing handoff while it continued. | Resolved with dismissibility guards, busy state, and locked handoff choices; regression-tested. |
| P1 | Responsive layering | Sidebar, inspector, and palette could stack independent focus traps at narrow widths. | Resolved with mutually exclusive layer state, modal dialog semantics, inert backing content, and one full-screen scrim; regression-tested. |
| P1 | Thread layout | Simultaneous connection and refresh notices could create implicit grid rows and displace the transcript/composer. | Resolved with one permanent notice grid region that contains both messages. |
| P2 | Navigation and scroll | Companion route changes, palette keyboard movement, and transcript updates did not consistently expose the new content. | Resolved with destination heading focus/scroll reset, active-option `scrollIntoView`, thread-change reset, and near-bottom-only transcript following; regression-tested. |
| P1 | Runtime truth | Infrastructure concepts risked becoming global product destinations or implying fleet-wide health. | Resolved by keeping them scoped to the active thread and organizing the contextual Runtime panel around Status, Reported work, Delivery, and Usage. Cached and unreported states remain explicit. |
| P1 | Upstream trust | Prime Agent installation could be confused with Continuim host installation or sandboxing. | Resolved with the official macOS/Linux installer as terminal-only help, a separately named Continuim host service, and an explicit user-permissions / not-a-security-sandbox warning. |
| P1 | Keyboard and high contrast | Corrected Add computer fields could retain stale alerts, and forced-colors mode could suppress composer and palette focus. | Resolved by clearing field-local errors on correction and restoring 2 px `Highlight` outlines under forced colors; regression-tested. |
| P2 | Drawer operation | The narrow project drawer relied on Escape or the scrim for dismissal. | Resolved with an in-drawer Close action that participates in the focus loop and restores the opener. |
| P2 | Visual hierarchy | The persistent header and mobile preview competed with the active thread. | Resolved by demoting Companion Preview to the sidebar, removing duplicate evidence counts from the header, flattening nested cards, and framing the desktop Companion Preview at phone width. |

## Research basis and information architecture

The implementation follows durable patterns from primary platform guidance:

- [VS Code's workbench model](https://code.visualstudio.com/docs/editing/userinterface) informed one dominant editor/thread surface, secondary navigation, and contextual evidence rather than three equally weighted panes.
- [VS Code command-palette guidance](https://code.visualstudio.com/api/ux-guidelines/command-palette) informed a keyboard-first `Ctrl/Cmd+K` path that exposes only real navigation and supported actions.
- [Material 3 adaptive layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) informed a separate compact supervision projection rather than shrinking the complete desktop workbench onto a phone.
- [WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) and [focus-appearance guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance) informed coarse-pointer hit areas, visible focus, and keyboard operation.
- [Apple's Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) reinforced clear hierarchy, platform-familiar controls, and safe-area-aware mobile navigation.
- [Hermes Desktop's design notes](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/DESIGN.md) reinforced chat as home, flat composition, non-focus-stealing background updates, persistent expensive panes, and explicit keyboard ownership.
- [Prime Agent's architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md) and [RPC reference](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md) informed truthful client/runtime ownership, steering, recovery snapshots, schedules, and reported usage.

The resulting desktop defaults to navigation plus the active durable thread. The inspector is closed until evidence or context is requested. Mobile is a bounded supervision workflow: **Attention** for exceptional decisions, **Threads** for status/recaps/results, and **Hosts** for reachability. Execution location stays metadata instead of becoming a separate product mode.

An earlier GPT Pro review was used as a read-only architecture, taste, and ship review for the desktop/Companion foundation. Its scope-separated verdict was **GO** for that honest foundation and **NO-GO** for production remote/mobile positioning. It specifically rejected a LAN listener, simulated pairing artifacts, invented infrastructure telemetry, and treating terminal installer guidance as provisioning. That historical review predates the resident continuity checkpoint; the current executable boundary and verification evidence live in `implementation-status.md` and the repository's automated gates.

## Accessibility and interaction coverage

- Semantic banner, main, complementary regions, named navigation, transcript region, form, tablist/tabpanels, dialogs, and live status regions.
- Skip link targets the main thread; modal and drawer focus is restored to its trigger.
- Inspector tabs support arrow-key activation; sheets and the composer are keyboard operable.
- The command palette is a labeled combobox/listbox with arrow, Enter, and Escape handling; its results are real threads, projects, and supported commands.
- Companion Preview has a skip link, named Attention/Threads/Hosts navigation, concise reading order, explicit unavailable-state guidance, and safe-area-aware bottom navigation.
- Companion Attention contains only actionable questions, approvals, failures/offline hosts, and derived uncertain command receipts; ordinary completions and already-read events are filtered out.
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
