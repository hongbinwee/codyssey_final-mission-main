# Decisions → LangGraph → Claude — isolated QA handoff

Current integration baseline: `feature/system-prompt-integration@b06699a` (2026-10-20).
The implementation is already integrated. Historical proposal branch: `feature/prompt-decisions-claude-converse`.
Historical proposal: PR #3. Current routing/configuration contract: [decisions-routing.md](decisions-routing.md). Never merge into `main` or `feature/brain-core` as part of QA.

## Contract

- `BRAIN_ROUTE_MODE=decisions`: every normal user message is classified by OpenAI Decisions. The existing regex router is **not** called before, after or upon Decisions failure. An absent Decisions key fails runtime startup; network, model or schema failures yield safe `UNCERTAIN` and never launch RAG.
- `CAPABILITY`, `GREETING`, `SOCIAL`, `UNCERTAIN`: the LangGraph `converse` node invokes the already configured Chat `Provider` (Claude in the approved QA environment) with **zero tools**. Response is validated and capped; provider errors return an explicit safe failure, never a fabricated product result.
- `CS_REQUEST`: deterministic existing limited CS 안내. No order/cancel execution, no extra provider call.
- `SHOPPING_SEARCH`, `SHOPPING_FOLLOWUP`: original `plan → retrieve → respond`, current RAG, Commerce, A/B ranking and saved plan untouched.
- `REVIEW_COMPARE`: original validated RAG → LLM grounded response path untouched.
- `BRAIN_ROUTE_MODE=rules` remains a compatibility switch for existing *other* QA and unit fixtures; it does not call Decisions or the new conversation responder. This is **not** a two-stage hybrid routing system.

## Independently approved QA configuration (NO secrets in Git)

Use a *separate* local Worktree, port, process, and authorized isolated QA databases, as currently provisioned by `codex/qa-prompt`. Do not copy or overwrite that local commit. Validate its unpushed changes first.

In the **independent QA server process only**, set:

```dotenv
BRAIN_ROUTE_MODE=decisions
BRAIN_DECISIONS_TIMEOUT_MS=4000
BRAIN_DECISIONS_CONFIDENCE=0.35
# OPENAI_DECISIONS_API_KEY: server-only value, never print or commit
# Existing approved LLM_PROVIDER / LLM_API_FORMAT / LLM_MODEL / LLM_API_KEY must select Claude.
```

For live Claude verification, ensure that provider is live (not the built-in stub). The Decisions API key is **independent** of the Claude provider key. No fallback to regex is permitted when Decisions is enabled. Restart only the independent QA server after an explicit local change review; keep the team's Cloudflare server and DB untouched.

## Acceptance checks

| Input | Expected intent | Tool / model behavior |
| --- | --- | --- |
| `넌 뭘 할수있어?` | CAPABILITY | Decisions request → Claude no-tools → actual capability explanation; **no RAG** |
| `너는 뭘 할 수 있어?` | CAPABILITY | Same |
| `쇼핑할 때 어떤 도움을 줄 수 있어?` | CAPABILITY | Same |
| `안녕` | GREETING | Natural Claude reply; no RAG |
| `고마워` | SOCIAL | Natural Claude reply; no RAG |
| `에센스 2만원대 추천해줘` | SHOPPING_SEARCH | Current LangGraph Shopping Plan → RAG → A/B ranking |
| `리뷰 장단점 비교해줘` with plan | REVIEW_COMPARE | Existing verified evidence → grounded review reply |
| `주문 취소해줘` | CS_REQUEST | Existing supported CS 안내; no order write |
| Malicious injected command or Decisions 429/timeout | Safe UNCERTAIN | No retrieval/write; no secret exposure |

Trace and report: `intent_kind`, `trace.routeMs`, `trace.responseMs`, Claude call count, verified RAG call count, error class, total response time, p50/p95 and real test dataset version. Mock unit tests never count as live API evidence.

## Guardrails and limits

- Never run `db:migrate`, seed, index creation or embeddings against shared QA.
- No changes to `main`, `feature/brain-core`, currently running QA Cloudflare tunnel or shared sessions.
- Validated QA improvements are already in integration baseline `b06699a`. The existing integration Worktree's 15 staged paths match that baseline byte-for-byte; preserve the staged state and do not replay the patch wholesale.
- Before any separately approved QA deployment, compare local `src/brain/runtime.ts`, `graph.ts`, and provider/intent changes. Use the existing isolated test workspace; do not reset local work or alter the running QA server as part of this documentation integration.
- Real HTTPS/browser/Claude integration remains NOT_RUN until executed in that local environment with credentials.
