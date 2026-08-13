# 005 — Streamline first-run model setup

- **Status**: DONE
- **Baseline**: f2f6ba8
- **Severity**: HIGH
- **Category**: Maintainability & architecture
- **Rule**: Beyond the scan
- **Estimated scope**: 3 files, about 140 lines including focused tests

## Problem

A Prime Agent session without a configured ChatGPT account opens the correct
provider, but still renders the full provider rail plus search/filter controls and
a second empty-model state. The only useful first-run action is Connect ChatGPT;
the rest of the catalog competes with it and makes setup feel like infrastructure
configuration instead of starting an agent.

    // src/renderer/src/ModelsDialog.tsx — current
    <button>All providers</button>
    {catalog.providers.map((provider) => <button key={provider.providerId}>…</button>)}
    …
    <div className="model-catalog__controls">…</div>
    <div className="model-list__empty">No available models match</div>

## Target

When ChatGPT is not configured and Prime Agent advertises the exact supported
OAuth provider:

- show ChatGPT as the single recommended provider;
- keep the complete runtime catalog behind one explicit “Browse all providers”
  disclosure;
- keep the security disclosure and Connect ChatGPT action fully visible;
- suppress redundant search/filter/empty-model UI until the account is
  configured;
- after OAuth refreshes the exact catalog, reveal models in place and keep exact
  GPT-5.6 Sol sorted first with an “RLM recommended” badge.

No provider is selected or connected automatically.

## Repo conventions to follow

- Preserve the existing exact host authority and OAuth request fencing in
  `src/renderer/src/ModelsDialog.tsx`.
- Preserve the native toolbar keyboard pattern and responsive horizontal rail.
- Keep the current security disclosure about host-only plaintext `auth.json`.

## Steps

1. Derive a first-run/recommended-provider presentation from the authoritative
   catalog; do not create a second catalog model.
2. Add one local disclosure state and ensure the roving-focus provider list is
   built from exactly the visible buttons.
3. Hide only redundant model-browsing controls while the recommended account is
   unconfigured; expose them immediately after catalog refresh.
4. Add focused keyboard, disclosure, OAuth-refresh, and Sol-label tests.

## Boundaries

- Do NOT auto-start OAuth or auto-select a model.
- Do NOT hide configured providers or make non-ChatGPT providers unreachable.
- Do NOT weaken exact host/thread/generation authority checks.
- Do NOT add a component library or state dependency.

## Verification

- **Mechanical**: web typecheck, focused App/Models tests, production renderer
  build, and startup budget.
- **Behavior check**: open Models & accounts with zero configured providers;
  Connect ChatGPT is the visual primary path, all providers remain one click
  away, and a refreshed configured catalog reveals exact model selection.
- **Done when**: first-run setup has one clear action without removing catalog
  escape hatches or authority evidence.

## Result

- An unconfigured ChatGPT provider opens directly on the Sol/RLM setup path,
  even when another runtime provider is already usable.
- The full catalog remains behind one native disclosure; redundant provider,
  search, filter, and empty-result controls stay out of the first-run path.
- OAuth completion reveals the authoritative refreshed catalog in place and
  labels exact GPT-5.6 Sol as `RLM recommended`.
- Full renderer interaction suite: 173/173 passed. All 29 visual targets pass
  at 320–1600 CSS pixels with no horizontal overflow.
- Eager renderer startup is 147,772 gzip bytes against the 204,800-byte budget.
