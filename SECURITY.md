# Security policy

## Supported versions

Prime Continuim is a development preview. Security fixes are applied to the latest `main` branch; no stable binary release is supported yet.

## Report a vulnerability

Use GitHub's **Report a vulnerability** flow on this repository when it is available. Do not open a public issue for a finding that includes an exploit, credential, private workspace path, OAuth material, transcript, or retained fixture.

If private vulnerability reporting is unavailable, open a minimal public issue asking the maintainers to provide a private channel. Include no sensitive details in that issue.

In a private report, include:

- the affected commit and platform;
- the trust boundary and impact;
- minimal reproduction steps;
- whether provider credentials or model-generated commands are involved; and
- any safe mitigation you have already tested.

The maintainers will acknowledge a complete report as soon as practical, keep the reporter informed while the issue is assessed, and coordinate disclosure after a fix is available.

## Security boundary

Prime Continuim runs Prime Agent and model-generated commands with the selected host user's permissions. Worker and kernel lifecycle isolation is not a security sandbox. Use an external sandbox for untrusted code.

The renderer receives bounded, secret-free projections. Runtime credentials remain host-only, but Prime Agent v0.7.1 stores OAuth material as plaintext in a private directory rather than a platform keychain. Software running as the same operating-system user or an administrator remains in the trust boundary.

The current artifacts are unsigned development builds. Checksums and self-build receipts detect correlated byte changes; they do not authenticate a publisher or replace platform signing.
