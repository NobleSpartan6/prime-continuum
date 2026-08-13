# React improvement plans

Audit baseline: React Doctor 0.9.11 against commit `f2f6ba8` and the current
working-tree candidate. The raw score is dominated by backend Zod migration
and deliberately packaged runtime files; it is not a useful renderer score.
These plans retain only findings on the interactive renderer path.

| Order | Plan | Status | Why now |
| --- | --- | --- | --- |
| 1 | [001-localize-composer-draft-rendering.md](001-localize-composer-draft-rendering.md) | DONE | Ordinary prompt typing now stays inside the Composer boundary. |
| 2 | [002-commit-authority-refs-after-render.md](002-commit-authority-refs-after-render.md) | DONE | Async authority refs now update only after commit. |
| 3 | [003-isolate-resident-provision-state.md](003-isolate-resident-provision-state.md) | DONE | Each one-use selection now owns one explicit setup state machine. |
| 4 | [004-index-native-snapshot-lookups.md](004-index-native-snapshot-lookups.md) | DONE | Exact uncertainty correlation now uses one per-publication index. |
| 5 | [005-streamline-first-run-model-setup.md](005-streamline-first-run-model-setup.md) | DONE | ChatGPT → Sol is now the clear setup path while the complete catalog stays one click away. |
| 6 | [006-contain-composer-submit-rejections.md](006-contain-composer-submit-rejections.md) | DONE | Unexpected async rejection is contained without clearing or replaying the prompt. |

All six bounded renderer plans are implemented and verified.
