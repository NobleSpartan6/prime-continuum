# Interface review

Verdict: **Pass for the Phase 0/Phase 1 desktop and read-only mobile-supervision foundation; not a production remote-release approval.** The workbench is coherent, accessible, and honest about inactive capabilities. Production phone control remains gated by the engineering items in `implementation-status.md`.

Review order followed the requested `better-interface` workflow: accessibility → layout → writing → typography → colors → UI polish, followed by the animation standards review.

## Findings

| Priority | Area | Finding | Resolution / evidence |
| --- | --- | --- | --- |
| P1 | Accessibility | Narrow sidebar and inspector drawers initially allowed focus behind the scrim. | Resolved with overlay focus containment, Escape dismissal, and trigger focus restoration; covered by renderer tests. |
| P1 | Product honesty | Model, new-thread, search, start, attachment, and stop controls had no native operations. | Resolved by removing the model control, implementing real project/thread search plus available commands, and disabling only the unsupported controls with concise explanations. No clickable no-op remains. |
| P1 | Product honesty | Seeded browser host data could read like live OpenSSH verification. | Resolved with `Preview sample`, `Host verification`, and an explicit statement that no live host key was checked. Native wording remains tied to the actual OpenSSH probe result. |
| P1 | Host setup | Native onboarding did not state that interactive OpenSSH prompts are outside the current UI bridge. | Resolved in the Add computer description: password, passphrase, and new host-key prompts must be completed in a terminal before retrying in this build. |
| P1 | Handoff | The completion view could rename the reviewed source after authority changed. | Resolved by retaining the plan's immutable source identity; regression-tested. Native commit is separately gated until a destination coordinator exists. |
| P2 | Layout | Sheet content could extend below its footer at the desktop QA viewport. | Resolved with a bounded grid frame and independently scrollable body. At 1278×1248, the 864 px dialog and footer end at the same 1056 px boundary. |
| P2 | Touch / input | Compact controls were smaller than a comfortable coarse-pointer target. | Resolved with 44 px minimum targets under `pointer: coarse`. |
| P2 | Motion | Frequent navigation items inherited unnecessary transitions. | Resolved. Only occasional controls and responsive drawers transition; frequent thread/project/file/tab navigation does not. |
| P1 | Mobile architecture | An interim LAN server would expose host authority and create a second security model. | Rejected. Companion Preview uses the existing projection; real control requires an outbound untrusted relay, application E2EE, device-bound scopes, and revocation. |
| P1 | Mobile honesty | A sample QR, code, phone, or approval could look like working pairing. | Resolved with a secure-relay gate, zero-device state, and disabled pairing/composer controls. The preview creates no pairing or command material. |
| P1 | Mobile layout | Long thread details initially expanded the shell beyond the viewport and pushed bottom navigation out of reach. | Resolved by fixing the shell to one viewport and making only the main content region scroll. Browser geometry confirms the navigation remains at the viewport edge. |
| P1 | Projection truth | A failed A→B thread selection could temporarily label A's evidence, agents, and attention as B. | Resolved by clearing materialization while B loads, requiring an exact returned thread ID, and restoring A only when the same host/selection generation fails. Regression-tested. |
| P1 | Preview truth | Seeded browser data could look like a native host projection in the mobile dialog and Companion. | Resolved with persistent `Browser preview · seeded data` labels; native uses the freshness-neutral `Native projection data` label. |
| P2 | Mobile focus | Entering/exiting Companion and replacing a thread row with detail initially lost the focused element. | Resolved with programmatic entry focus, row→heading focus, back-to-row restoration, and return to the originating Mobile or command-palette trigger. |
| P1 | Operation safety | Escape or backdrop dismissal could hide an in-flight host install or authority-changing handoff while it continued. | Resolved with dismissibility guards, busy state, and locked handoff choices; regression-tested. |
| P1 | Responsive layering | Sidebar, inspector, and palette could stack independent focus traps at narrow widths. | Resolved with mutually exclusive layer state, modal dialog semantics, inert backing content, and one full-screen scrim; regression-tested. |
| P1 | Thread layout | Simultaneous connection and refresh notices could create implicit grid rows and displace the transcript/composer. | Resolved with one permanent notice grid region that contains both messages. |
| P2 | Navigation and scroll | Companion route changes, palette keyboard movement, and transcript updates did not consistently expose the new content. | Resolved with destination heading focus/scroll reset, active-option `scrollIntoView`, thread-change reset, and near-bottom-only transcript following; regression-tested. |

## Research basis and information architecture

The implementation follows durable patterns from primary platform guidance:

- [VS Code's workbench model](https://code.visualstudio.com/docs/editing/userinterface) informed one dominant editor/thread surface, secondary navigation, and contextual evidence rather than three equally weighted panes.
- [VS Code command-palette guidance](https://code.visualstudio.com/api/ux-guidelines/command-palette) informed a keyboard-first `Ctrl/Cmd+K` path that exposes only real navigation and supported actions.
- [Material 3 adaptive layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) informed a separate compact supervision projection rather than shrinking the complete desktop workbench onto a phone.
- [WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) and [focus-appearance guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance) informed coarse-pointer hit areas, visible focus, and keyboard operation.
- [Apple's Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) reinforced clear hierarchy, platform-familiar controls, and safe-area-aware mobile navigation.

The resulting desktop defaults to navigation plus the active durable thread. The inspector is closed until evidence or context is requested. Mobile is a bounded supervision workflow: **Attention** for exceptional decisions, **Threads** for status/recaps/results, and **Hosts** for reachability. Execution location stays metadata instead of becoming a separate product mode.

GPT Pro was used as a read-only architecture, taste, and ship reviewer. Its final scope-separated verdict was **GO** for the honest desktop/Companion Preview foundation, **conditional GO** for the inert Phase 3A and isolated relay foundation, and **NO-GO** for production phone control. It specifically rejected a LAN listener and simulated pairing artifacts, and retained real Linux/macOS process integration as a release condition. GPT Pro also stated that its visual and source claims were based only on supplied evidence; Codex independently inspected the current source, projection path, authorization checks, tests, DOM, browser geometry, and console before acting on the review.

## Accessibility and interaction coverage

- Semantic banner, main, complementary regions, named navigation, transcript region, form, tablist/tabpanels, dialogs, and live status regions.
- Skip link targets the main thread; modal and drawer focus is restored to its trigger.
- Inspector tabs support arrow-key activation; sheets and the composer are keyboard operable.
- The command palette is a labeled combobox/listbox with arrow, Enter, and Escape handling; its results are real threads, projects, and supported commands.
- Companion Preview has a skip link, named Attention/Threads/Hosts navigation, concise reading order, explicit disabled-control reasons, and safe-area-aware bottom navigation.
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
| Press feedback | `scale: 0.98` |
| Expensive animated properties | None; transitions use scale, translate, color, background, border, shadow, and visibility |
| `transition: all` | None |
| Reduced motion | All transitions and spinners are inside `prefers-reduced-motion: no-preference` |
| Continuous animation | Only meaningful in-progress spinners, using linear rotation |

Considered but rejected: decorative entrance sequences, list-item motion, spring/bounce easing, gradient-heavy surfaces, oversized marketing typography, and remote-only navigation. They would add noise or contradict the durable-thread-first product model.
