# Phase 0 acceptance

## Discovery and connection

- Concrete aliases from SSH config and included files appear automatically.
- Wildcard-only and negated hosts are excluded.
- Effective user, hostname, port, proxy jump, and identity references come from `ssh -G`.
- Probe and connect use argument arrays with fixed remote commands.
- Authentication and host-key failures remain structured and actionable.

## Durable use

- The same UI opens a local or SSH-backed project.
- The cached thread is visible before host reconciliation completes.
- Closing the desktop window does not own or terminate `hostd`.
- Reconnect uses a generation-aware cursor and command IDs.
- Snapshot replacement is atomic and produces no duplicate blocks.
- A prompt is not blindly resent after an ambiguous disconnect.

## Interface

- Run location is a compact secondary control, not a mode switch.
- Offline content remains readable and task state remains intact.
- Add computer is one reviewable sheet with technical detail disclosed on demand.
- Move thread names the source, destination, repository state, transfer size, and runtime losses.
- Every workflow is keyboard operable with visible focus and restored modal focus.
- Status is expressed with text and announced without relying on color or motion.

## Explicitly deferred

- Installing a signed production `hostd` package on arbitrary remote distributions.
- Verified resident Prime Agent daemon execution beyond the host-only compatibility contract and Phase 0 harness.
- End-to-end relay, device pairing/revocation, mobile projection, and managed compute.
- Git object negotiation for production-scale handoff; the milestone preserves the transactional state machine and receipt contract.
