# Shopping Brain evaluation v1 — reproducible offline + opt-in live

**Branch-only:** `feature/brain-core`. Do not merge into `main` or mutate protected Commerce/AI databases.

## Purpose and evidence labels

1. **Gold replay** (CI): verifies that versioned, human-authored expected intent JSON parses and resolves to the expected shopping plan. This measures **contract / regression correctness, not LLM accuracy**.
2. **Live model** (opt-in): calls the already configured OpenAI-compatible Responses Provider for exactly the same fixed queries, then scores final Shopping Plan against held-out human gold labels. It is the first mode capable of measuring model intent accuracy. It must never be silently enabled in CI.
3. **Grounded explanation** (CI): deterministic assertions on candidate eligibility, evidence/product-ID ownership, synthetic-vs-real review separation, top-3 limit, and verified-vs-reference-only claims. This does **not** establish whether real product claims are true: source-grounding requires the RAG team's audited actual review corpus.
4. **Multi-turn recovery** (CI): pre-existing PostgreSQL LangGraph checkpoint tests exercise plan retention/restart/replay; Chromium E2E simulates RAG HTTP 503, checks that a failed turn is not displayed as a successful answer, input is preserved, and user retry succeeds. A separate Chromium test now injects a transient LLM Responses HTTP 503, checks that the last completed plan is preserved and that user retry succeeds. Actual timeout/429 across a new server process remains an additional test goal.

## Dataset and rubric

File: `eval/brain/intent-v1.json` (versioned `brain-intent-eval-v1`).

Each case includes user utterance, previous Shopping Plan or null, the intended structured LLM output `goldOutput`, and associated expected final `query`, `maxTotalWon`, `requiredConditions`, `currentPreferences`. It includes first turns, budget carryover/change/clear, requirement add/replace/clear, new category, explicit preference override, and non-hallucination.

**Exact Plan Accuracy** = count of cases with *all four final fields correct* / evaluated cases. Report per-field accuracy separately when investigating failures. An unparsable model output or timeout is a failed case, never a silently skipped record. Preserve goldset version for model-to-model comparison. A sample of 12 hand-written cases is useful for smoke testing, **not statistically representative** of users, products, domains or adversarial traffic.

## Commands

Deterministic CI mode — no API key, no external model spend:

```sh
node --experimental-strip-types scripts/brain-intent-eval.ts --gold-replay
```

Explicit opt-in model mode — use only when model, spend, privacy, and endpoint are confirmed. Do not commit .env or logs containing secrets:

```sh
BRAIN_LIVE_EVAL_APPROVED=1 \
LLM_API_KEY='<provided-through-private-environment>' \
LLM_MODEL='<approved-model>' \
LLM_PROVIDER=live \
BRAIN_EVAL_REPORT_PATH=/tmp/brain-live-eval.json \
node --experimental-strip-types scripts/brain-intent-eval.ts --live
```

The script uses the existing `providerIntentModel(..., 45000)` (tool-free planning) and reports per-case success/failure and latency; it exits nonzero on any failed case. **Do not use a green gold-replay as evidence that the model achieved 100%.** When comparing models, run each in the same environment with the same fixture version and comparable reasoning/budget controls. The built-in live evaluator does not yet capture token usage or cost; report these as *not measured*.

## Acceptance thresholds (proposed, not yet achieved)

| Category | P0 target | Meaning |
|---|---:|---|
| 12-case gold replay | 100% | Parser/plan contract smoke |
| Live intent exact plan accuracy | >=90% on a future >=50-case balanced independent set | Actual LLM quality; current 12 cases insufficient |
| Critical safety failures | 0 | Unsupported hard spec, budget violation, memory cross-user leakage, fake review grounds |
| Deterministic explanation ID ownership | 100% | All cited evidence IDs belong to candidate product and variant |
| RAG failure retry | 100% of scripted cases | Failed turn never becomes successful and retry retains task state |
| p50 / p95 | Report both without a hard threshold until real model baseline established | Separate model, graph, network and rendering time |

**No release readiness assertion** is justified by this test suite alone. RAG's real evaluation, actual external LLM traces, authenticated multi-user browser checks, security review and 5+ real-user feedback remain release gates.

## Explicit exclusions

- No fabricated Amazon catalog or reviews; this goldset is shopping-language-only synthetic examples.
- No third-party LLM API key or actual model timing is available inside CI.
- No changing `Commerce` schema/business rules or protected database connections.
- No automatic merge into `main`.

## Verification record (2026-10-16)

[GitHub Actions #38905510181](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/38905510181): **PASS** on `feature/brain-core`. Brain unit/contract regression 54/54, gold-replay 12/12, disposable PostgreSQL/checkpoint, authenticated Mock RAG HTTP and Chromium UI with both RAG and LLM 503 retry PASS. Historical Commerce non-gating unit audit 615 passed, 6 failed due missing historical fixtures/environment; this is not full Commerce QA clearance.

**Mock-only latency**: five successful Graph wall-time observations, p50 35.68ms, p95 64.07ms in CI; not live model or complete client experience. No external LLM quality or latency results yet.
