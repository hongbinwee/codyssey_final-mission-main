# Shopping Brain v2 — branch-only implementation state

This document supersedes the early prototype-only gates for `feature/brain-core`. Never merge into `main` without user approval.

## Implemented (opt-in; defaults OFF)
- Existing Commerce is unchanged, except the authenticated `/api/brain/*` route hook in `src/server.ts` and the opt-in UI detection within `AgentPanel`. All storefront catalog/cart/order business logic and base migrations remain intact.
- `src/brain/page-context.ts` isolates untrusted page hints from system prompt.
- `src/brain/intent.ts` uses strict JSON plan extraction via the existing Responses API provider with NO tool calls.
- `src/brain/personalization.ts` uses user-specific preferences, shared fixed scoring axes, hard requirements, G2 verified whole-review-count gate and evidence ownership.
- `src/brain/persistent-store.ts` + `db/brain/001_brain_memory.sql` store actor-scoped conversations, user messages, pending preference proposals and confirmed long-term memories.
- `src/brain/graph.ts` is a real LangGraph StateGraph with `PostgresSaver` supplied by `src/brain/runtime.ts`; graph checkpoint persistence is separate from durable preferences.
- `src/brain/database-isolation.ts` refuses non-`brain_*` database targets, invalid connections or the exact Commerce DB target. Migrations require an explicit `BRAIN_MIGRATE_APPROVED=1` against a fresh AI-owned DB.
- `src/brain/api.ts` exposes authenticated conversation, preference, confirmation and read-only research routes; no cart/order writes.
- `src/web/components/BrainPreview.tsx` shows grounded/restricted results and two-stage user-confirmed memory saving when enabled.
- `src/brain/commerce-retriever.ts` is an HONEST fallback using existing search; without source-wide verified review count candidates remain reference-only, not actual recommendations.

## Verified
- GitHub Actions `npm ci`, full `npm run check`, `npm run build`, targeted Brain mock and real LangGraph tests PASS on previous green runs.
- Real disposable `brain_ci` PostgreSQL validates memory write/delete, one-time proof, user isolation, preference-driven rank reversal, and durable LangGraph checkpoint reload.
- HTTP route end-to-end is being separately validated; refer to the **latest** GitHub Actions run before stating PASS.
- Broad Commerce unit suites require historical private fixture files and local environment variables unavailable on GitHub clean runners. This is visible as an explicit non-gating legacy suite; it is NOT full original Commerce regression PASS.

## Blocked or not yet proven
- Actual Amazon/RAG team Retriever integration and ratings/review provenance.
- Live external LLM accuracy/latency/cost and full shopping UX browser E2E.
- Production-ready distributed rate limits, server-side multi-instance thread locking, memory retention/GDPR controls, CSRF policy behind real reverse proxy and security review.
- Commerce cart write Tool approval and safe user-facing action workflow; deliberately disabled in new Brain.
- Real-user testing and cloud deployment.

See `docs/BRAIN_V2_INTEGRATION_HANDOFF.md` for exact routes, guarded setup and RAG input/output contracts.
