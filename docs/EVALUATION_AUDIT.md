# Shopping Brain evaluation independent-code audit — 2026-10-16

Branch `feature/brain-core`; base `main` must not be modified or merged.

## Scope / independence limitations

This is a **separate-pass code and test audit** of the previously authored implementation, NOT an external human blind annotation, production security audit or verified real-data review. Auditor examined the existing `eval/brain/intent-v1.json`, evaluator, Shopping Plan, Personalization, Grounding, RAG and Memory code independently of prior reported PASS statuses. Human reviewer approval is still pending.

| ID | Severity | Finding | Evidence | Required action |
| --- | --- | --- | --- | --- |
| AUD-01 | Critical (evaluation) | v1 goldOutput and expected Shopping Plan were created together for only 12 hand-authored examples. Gold replay replays its own labels, so 12/12 does not measure LLM generalization or independently validated truth. | `eval/brain/intent-v1.json`, `scripts/brain-intent-eval.ts` | Preserve v1 as contract smoke; add v2 with written scenario source, independently reviewable expected result, locked holdout and no training/serving contamination. |
| AUD-02 | Major (logic) | Switching to a new product category with `requirementsMode=ADD` can append old-category requirements because the ADD branch runs before `newTask` exclusion. | `src/brain/shopping-plan.ts` | Reset old category requirements on query SET, regardless of ADD/REPLACE. Add fail-first regression. |
| AUD-03 | Major (provenance) | Mock E2E product/review records label synthetic CI fixtures as `sourceKind=REAL` and self-reported audit ID match can pass G2. A test fixture can therefore resemble actual independently audited Amazon evidence. | `tests/brain-db/brain-rag-http.test.mjs`, `src/brain/rag-adapter.ts` | Keep all fixtures confined to disposable CI DB and separate provenance from eligibility. Require explicit trusted audit manifest/reconciliation for future real use; forbid copying CI fixture into real corpus. |
| AUD-04 | Major (isolation) | There is no explicit machine-readable policy or CI gate preventing synthetic/evaluation files from being copied into future real-product ingestion. | Current `eval/brain`, `tests/brain-db`, RAG handoff | Add provenance policy, manifest and automated boundary tests. Do not concatenate synthetic v4/v5 and real source records. |
| AUD-05 | Major (recovery) | Current graph uses an in-process Set for single-thread concurrency and only replays a completed **latest** action. Concurrent multi-replica replay, crash during node execution, stale checkpoint, 429 and hard timeouts are not fully verified. | `src/brain/graph.ts`, browser E2E | Add dedicated negative/recovery coverage; mark distributed concurrency a release blocker. |
| AUD-06 | Major (quality) | Personalization weights and normalized aspect signals are experimental. Mock ranking reversal is not evidence of relevance or fairness; source-wide review counts are not independently verified by code. | `src/brain/personalization.ts`, `src/brain/rag-adapter.ts` | Evaluate baseline vs Memory ON/OFF, missing evidence and budget hard gates. Real-data quality awaits actual audited corpus. |
| AUD-07 | Major (answer quality) | Current explanation reports aspect numbers and evidence IDs; it does not verify the meaning of actual review text, so semantic review conclusions cannot be claimed as validated. | `src/brain/grounded-response.ts` | Grounding structural QA now; semantic/factual user review QA later. |
| AUD-08 | Moderate (measurement) | Gold-replay p50/p95 measures the local parser and fixture replay, not external LLM latency; 12 cases are too few for meaningful p95. | `scripts/brain-intent-eval.ts` | Label modes, denominators, dataset version and cost explicitly. Never compare gold replay time with live model latency. |
| AUD-09 | Moderate (privacy) | Deleting a preference from canonical Memory does not itself erase user words stored in conversation transcripts or LangGraph checkpoints. | `src/brain/persistent-store.ts`, `src/brain/graph.ts` | Add retention/erasure design and test before storing actual user secrets in production. |

## Go/no-go criteria

1. Correct AUD-02, add regression that fails on original code and passes on the fix.
2. Create an explicit synthetic/real/evaluation isolation policy; add a CI check and source manifest; human approval required for classifying a REAL dataset.
3. Extend fixed v2 plan scenarios beyond v1 with unambiguous expected outputs, group labels, annotations, provenance and locked holdout. Explicitly exclude ambiguous cases from exact accuracy until adjudicated.
4. Run deterministic tests and disposable PostgreSQL/HTTP/Chromium regressions. Separate PASS, FAIL, NOT_RUN and blocked items in the report.
5. No live LLM/real RAG QA claim without a separate execution. Do not merge to `main`.

**Status:** initial code-audit findings substantiated. Independent second human or agent blind label adjudication NOT_YET_PERFORMED.

## Follow-up disposition

See [EVALUATION_REPORT.md](./EVALUATION_REPORT.md) for the verified CI run, case counts and current block/no-go decision. AUD-02 is fixed and tested; AUD-01/AUD-04/AUD-08 are partially addressed; AUD-03/AUD-05/AUD-06/AUD-07/AUD-09 remain unresolved release blockers. The blind independent reviewer has not supplied or signed off on labels.
