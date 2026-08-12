# Contributing to Prime Continuim

Prime Continuim is an early desktop agent project. Small, tested changes are easier to review and safer to ship than broad rewrites.

## Before you start

- Search existing issues and pull requests.
- Use a discussion or feature request for changes to the authority, protocol, provider, or security model.
- Use [private vulnerability reporting](SECURITY.md) for security-sensitive findings.
- Never include credentials, OAuth material, private workspace paths, transcripts, or retained runtime fixtures in an issue or commit.

## Local setup

Requirements: Git, Node.js 24, and Corepack.

```bash
git clone https://github.com/NobleSpartan6/prime-continuum.git
cd prime-continuum
corepack pnpm install
corepack pnpm dev
```

The first run may download the checksummed runtime assets pinned by this repository.

## Make a focused change

1. Create a branch from the latest `main`.
2. Keep renderer, desktop-control, host-service, and protocol responsibilities separate.
3. Add a regression test for behavior changes.
4. Update the release boundary when a capability changes.
5. Run the narrowest relevant tests while iterating, then run the required gates.

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Use `corepack pnpm self-build` only when making a build-readiness claim. See [self-build evidence](docs/self-build-evidence.md) for what the receipt does and does not prove.

## Pull requests

A good pull request:

- explains the user-visible problem and the smallest complete fix;
- separates verified behavior from assumptions and future work;
- includes exact reproduction and verification steps;
- avoids generated output, local runtime state, and unrelated formatting churn; and
- keeps failure states path-free and free of provider or workspace secrets.

Screenshots are useful for interface changes, but they do not replace keyboard, narrow-width, reduced-motion, and functional tests.

## Project language

Use **task** for the user-facing unit of work, **resident session** for the host-owned Prime Agent lifecycle, and **RLM child** for a native delegated child. Do not present deferred remote, mobile, signing, or sandbox capabilities as available.

Contributions are licensed under the repository's [MIT License](LICENSE). By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
