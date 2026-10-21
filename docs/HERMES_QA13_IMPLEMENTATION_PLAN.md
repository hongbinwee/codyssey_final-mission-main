# Hermes QA13 — Contextual Review Analysis Implementation Plan

## Goal and scope

A follow-up such as “이 중 촉촉하다는 리뷰가 제일 많은 거?” must operate **only on the products actually displayed** by the preceding recommendation, using their canonical Commerce product/variant IDs and original display order. The request must not silently become a new product search or a price-based ranking.

This plan applies to `feature/hermes-agent`; `feature/brain-core` QA13-A is reference material, **not** a branch to merge. Existing Hermes H1–H6, QA09–11, memory, checkout, order and shipping behavior must be preserved.

**Live RAG constraint (2026-10-21):** Current remote v4 RAG accepted baseline search, but `product_ids`/`productIds` at top level and under `filters`, and `source_type=review`, returned HTTP 422. Do not guess another key or treat 200 as proof of filtering. Scoped semantic review RAG is BLOCKED until the RAG team provides an exact contract and live server-side scope test. Do not fall back to unrestricted product search.

## Architecture

User request → LangGraph route/agent decision → server-owned displayed-product snapshot → `analyze_product_reviews` (read-only port) → Commerce product/variant validation → cursor-paginated review reads → source/identity checks, duplicate handling and conservative classification → deterministic evidence-linked response → existing fencing and checkpoint publication.

The new capability must be accessible both through a **fast explicit-review route** and through the existing Hermes decision loop for ambiguous multi-step requests; there must be exactly one analysis engine and no nested agent loop. Never let a model-supplied product ID act as authorization.

### Separate three distinct tasks

| Task | Data source | Contract |
| --- | --- | --- |
| First recommendation / new search | existing v4 product RAG + Commerce verification | Preserve QA09 ranking semantics; do not restrict to prior products |
| Review evidence for *previous displayed* products | Commerce bounded full-corpus read (QA13-A) | Snapshot-locked targets, complete/partial status, conservative counts |
| Semantic-only phrases e.g. “처음엔 촉촉하지만 오후엔 건조해져” | Future **scoped review RAG** (QA13-B) | Require server-enforced product IDs, review-only filter and cited Commerce-review IDs; no unrestricted fallback |

`get_product_reviews` (existing bounded observations) and named `REVIEW_SUMMARY` (existing up-to-20 review summary) remain intact. `REVIEW_ANALYSIS` is a separate multi-product task; do not redefine “review count” as “attribute-positive review count.”

## Checkpoint ownership and snapshot lifecycle

Snapshot fields: `displayIndex` (1..3), `productId`, `variantId`, `name`, verified visibility, `datasetVersion` from surrounding server-owned result. Align snapshot exactly with displayed UI cards, including a reference card only if explicitly visible and safely identifiable. Never select from raw RAG candidates that the UI did not show.

- Prior context is scoped by authenticated actor, conversation and dataset version. Validate all snapshot fields, distinct indexes and products; verify variants again in Commerce before reading reviews.
- The original recommendation snapshot survives review summaries, analysis, clarification and social turns. New discovery replaces it; explicit reset clears it. It must not accidentally become a user-level persistent preference.
- Keep the original display order even if a derived comparison table sorts by positive opinion count. `2번` continues to refer to the original second displayed product.
- In a conversation without a valid snapshot, return a target-clarification outcome, not a guessed search.
- Existing `FencedTurns` must explicitly validate the new result kind and typed evidence before canonical publication/replay.

## Commerce analysis contract

Proposed port shape:
```ts
type ReviewAnalysisInput = {
  targets: {displayIndex:number; productId:string; variantId:string}[];
  aspect: string;
  operation: "EVIDENCE"|"COMPARE"|"CONS";
};
type ReviewAnalysisOutput = {
  status: "COMPLETE"|"PARTIAL"|"UNAVAILABLE"|"NEEDS_TARGET";
  products: unknown[]; // finalized as a bounded typed, validated summary before integration
};
```
The port performs read-only, bounded cursor pagination with explicit overall timeout, fixed max pages/records and no unbounded LLM context. It checks actual `getProduct` product/variant ownership; review ID, source ref, source type, option scope, duplicate ID/conflicting records, cursor continuity and coverage. Reviews with `variant_id=null` are product-wide; other variants must not leak into the selected variant. Classification is `POSITIVE|NEGATIVE|MIXED|UNRELATED|UNCERTAIN`. A partial read **must not** claim a full-count or definitive comparison rank. A verified zero, missing data and query failure are separate outcomes.

Treat REAL/SYNTHETIC provenance separately in computation; **never invent or hide provenance when this would misrepresent real-customer evidence**. UI wording should be restrained and user-relevant. Show original, sanitized evidence excerpts with source review IDs, and ensure citations match the same product and variant. LLM timeout must not discard Commerce-backed counts or claim unsupported semantics.

## Implementation milestones

1. **P1 Snapshot**: add server-owned displayed product/variant/order snapshot with tests; check QA10 review-summary continuation and new-search reset. (GitHub commit `f38e55f` includes an initial implementation; independently test, do not assume live behavior.)
2. **P2 Analysis core**: adapt only review-specific semantics from Brain QA13-A, including bounded page reads, verification, deduplication, classification, response schema and focused fixtures. Minimize overlap with QA09/QA10.
3. **P3 Agent integration**: add `REVIEW_ANALYSIS` route/Tool registry/Graph node and server-authorized target resolution; ensure fast path and agent decision share the same analysis port. Extend canonical receipt and history validators. Do not increase arbitrary model permissions.
4. **P4 UI**: grounded count/comparison/evidence presentation, clear partial/insufficient states; do not re-render new recommendation cards or falsely imply a full review search.
5. **P5 QA and release**: typecheck, build, focused unit and real isolated Commerce/Brain tests, CI; then Codex fetches and compares GitHub/local HEAD, tree and builds. Only on approval does Codex switch the standalone QA Node while preserving DB, auth/session and Cloudflare tunnel. User performs final scenario QA.

## Required regression conversations

- “수분크림 3개 추천” → “이 중 촉촉하다는 긍정 리뷰 제일 많은 건?” (same three IDs; no fresh RAG discovery).
- “2번 상품 단점” → “그럼 아까 추천했던 세 개 비교” (original three and original display order retained).
- “1번 리뷰 보여줘” with only 2 displayed items, missing context, new category, new conversation, dataset switch and reset.
- Partial pagination, zero reviews, duplicate IDs, source conflicts, variant-only reviews, review-injected instructions and unknown classification.
- LLM 429/504/timeout after Commerce results; Fencing replay/stale generation/concurrent requests.
- QA09 sorting cancellation, QA10 named-product summary, QA11 preferences, H1–H6 other tools and 320px UI remain unchanged.

## Work boundaries

**GitHub worker (ChatGPT):** design, code changes on `feature/hermes-agent` only, scoped deterministic tests, commits and CI audit. Before any write, re-read HEAD and never overwrite another worker's concurrent changes.

**Local Codex:** inspect DGX/Commerce read-only runtime identity and real corpus, exercise isolated Postgres and live network, run browser against candidate, confirm hashes, prepare approved deployment/rollback. Do not modify the same files concurrently or restart the current QA server without approval.

**RAG team:** publish exact product-ID-constrained review-search request/response examples and rejection semantics, plus evidence that restriction happens **before retrieval**, not by filtering the results afterwards.

A milestone is *implemented* only with code and focused tests, *integrated* only with live DGX/Commerce results, and *released* only when the actual QA process runs the verified GitHub commit.
