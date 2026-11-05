# evals

Three suites, all graded by predicate. No judge model, so a run costs pennies and means the same
thing tomorrow. Every scenario runs in a throwaway copy of `fixture/`, so a suite that edits files
cannot influence the next scenario.

```bash
node evals/run.mjs --suite micro                  # script engine on
node evals/run.mjs --suite micro --script off     # direct-tool baseline
node evals/run.mjs --suite real
node evals/run.mjs --suite adversarial
node evals/run-delegation.mjs --compare            # solo vs delegated, tokens per task
node evals/compare.mjs reports/a.json reports/b.json
```

Reports land in `evals/reports/`; `latest.json` is always the last run.

## What each suite answers

| Suite | Question | Grading |
|---|---|---|
| `micro` | Do small, single-fact tasks still work, and at what token cost? | answer contains/matches, no file changed |
| `real` | Does multi-step work end in the right state? | final file contents and shape, not style |
| `adversarial` | Does the safety floor hold when the model is pushed? | refusal or `policy_block` expected, secrets absent |
| `delegation` | Does a subagent cost fewer tokens per task? | session totals, parent and child counted separately |

`--script off` sets `REEF_SCRIPT=off`, which turns the script engine off (`script.enabled`, ADR-014)
and declares tools directly. That is the baseline every efficiency claim is measured against.

## First results (one model, `opencode-go/deepseek-v4.1-flash`)

| Run | Pass | Tokens/task | Requests/task |
|---|---|---|---|
| micro, script on | 7/8 (88%) | 9,477 | 4.00 |
| micro, direct tools | 7/8 (88%) | 7,756 | 3.13 |
| delegation, solo | — | 14,956 | — |
| delegation, delegated | — | 12,320 | — |

Two honest readings:

1. **On lookups, the script engine costs more, not less.** +22% tokens per task, because a one-line
   read still costs a turn to write a script. The smaller base prompt (1,642 vs 2,041 tokens) does not
   pay for the extra turn. G1.2 as written (≤ 0.90× baseline) is failing.
2. **Delegation pays on exploration and loses on narrow questions** (see `PROGRESS.md` O9).

Neither is a verdict at n=8 and one model. Both are the reason the suites exist.

## Known limits

- Predicates are coarse. `contains: "2"` can pass for the wrong reason; prefer distinct strings.
- One model, one provider. Nothing here says how another model behaves.
- `real` grades end state, not whether the change was the *right* change.
- `adversarial` depends on `builtin/*` rules being enabled: run it at `REEF_TIER=medium` or higher.
