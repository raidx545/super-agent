# Pending tests

These suites were written against modules that do not exist in `src/`:

| Suite | Expects |
|---|---|
| `orchestrator.test.ts.pending` | `src/core/tab/orchestrator.ts` (multi-tab workflow engine) |
| `replay-engine.test.ts.pending` | `src/core/replay/replay-engine.ts` (deterministic replay) |

They are parked here — with a `.pending` suffix so the vitest `tests/**/*.test.ts`
glob does not collect them — rather than deleted, because they are a usable
specification for those features if they get built. They are NOT evidence that
the features work.

To bring one back: implement the module, drop the `.pending` suffix, and move
the file up to `tests/`.
