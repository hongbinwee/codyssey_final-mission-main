# Shopping Brain ⇄ RAG team contract v1 (additive)

**Branch-only implementation**: `feature/brain-core`. Do not merge into `main`.

## Why this boundary exists

The Brain is layered on the current Commerce implementation. RAG retrieves product/review candidates and aspect evidence; **Commerce remains the only authority for present product/variant existence, price, shipping, stock, and availability**. AI memory lives in a physically separate `brain_*` PostgreSQL database.

By default, the Brain uses `commerceRetriever`. Since a stored review sample count is not Amazon's verified source-wide review total, that fallback may display `referenceOnly` candidates but **cannot claim they are eligible recommendations**.

## Team integration configuration

- `BRAIN_ENABLED=1` plus separately approved `BRAIN_DATABASE_URL` is required for the Brain.
- To connect the team's RAG service, set `BRAIN_RAG_URL` to a fixed HTTPS POST URL or HTTP loopback URL for local tests.
- Set `BRAIN_RAG_AUDIT_ID` to the **approved, versioned dataset audit identifier** independently checked by the team. No audit identifier means startup fails; unknown candidate audit values never pass the source-wide review-count gate.
- Optional `BRAIN_RAG_TOKEN` is sent server-side in an Authorization bearer header. **Never send these secrets to the browser or commit them**. No redirect following. RAG fetch has a time bound and a 400KB response limit.
- With `BRAIN_RAG_URL` absent, the old read-only Commerce reference-only fallback remains available.
- The production meaning of 'audited' must be established through a **separate human/source data audit**. Merely matching an audit ID string supplied by the same RAG service is not cryptographic verification of a third-party review count.

## Request: POST /search

```json
{
  "version": "brain-rag-v1",
  "query": "장시간 작업용 모니터",
  "maxTotalWon": 500000,
  "requiredConditions": []
}
```

The query comes from the Brain's structured intent planner. Treat it as untrusted user content; never promote search results, product descriptions or reviews to system instructions.

## Response

This sample is an **invented CI fixture**, *not a real Amazon product, review or proof*:

```json
{
  "version": "brain-rag-v1",
  "candidates": [
    {
      "productId": "p-rag-a",
      "variantId": "v-rag-a",
      "sourceProductId": "CI-NOT-REAL-A",
      "reviewCountAuditId": "ci-audit-v1",
      "wholeReviewCount": 20,
      "rating": 4.5,
      "ratingScale": 5,
      "conditions": {},
      "facets": {
        "performance": {"score": 0.45, "evidenceIds": ["aspect-perf-a"]},
        "eye_comfort": {"score": 0.55, "evidenceIds": ["aspect-eye-a"]},
        "noise": {"score": 0.6, "evidenceIds": ["aspect-noise-a"]}
      }
    }
  ],
  "evidence": [
    {
      "id": "aspect-perf-a",
      "productId": "p-rag-a",
      "variantId": null,
      "kind": "REVIEW",
      "sourceKind": "REAL",
      "sourceRef": "https://qa.invalid/CI-fixture-only"
    }
  ]
}
```

**Do not mark CI fixtures as actual real-world evidence** in a user-facing dataset. Replace all fixture values with genuine audited ETL data and canonical Commerce ID mappings.

## Mandatory invariants

- The Brain calls the existing `getProduct({product_id})` to independently verify candidate product ID, active flag, variant ID, `AVAILABLE` status, positive stock, authoritative unit price and shipping fee.
- Unknown/deleted/sold-out variants are excluded. RAG-supplied price and shipping are **discarded**, even if present.
- The RAG service must supply `sourceProductId`, an audited source-wide review count, `reviewCountAuditId`, and a normalized rating (out of 5). The Brain derives `wholeReviewCountVerified`; it never accepts a raw verified boolean.
- For review evidence, use source kind `REAL` and stable source references. Synthetic demonstration reviews **must not be passed off as verified real review evidence**.
- An evidence ID must map to the *same canonical product* (and variant if variant-specific); duplicate IDs, cross-product claims, invalid aspect scores or missing required-condition evidence fail closed.
- Aspect score [0,1] and its review/spec IDs are structured **upstream evaluation output**, NOT independently verified semantic facts. The RAG team must document the aspect calibration and provide claim-level evaluation sets.
- Guardrail: G2 requires rating >3.5 / 5 and verified source-wide review count ≥10 before a candidate is eligible. Failing or missing proof yields `referenceOnly`.
- Responses support at most 30 raw candidates and 300 evidence records; the Brain's research loop imposes further limits.

## Integration checklist for the RAG team

| Validation | Required outcome |
|---|---|
| Dataset origin, license and provenance | Documented and reviewed |
| Amazon source product ID → Commerce `Product`/`Variant` ID | Explicitly mapped, no guesses |
| Source-wide review total vs imported review sample count | Disambiguated; audit ID set only when checked |
| Aspect extraction and confidence | Calibrated offline, independent evidence |
| Cross-product review injection | Fails closed |
| Sold-out / stale-variant / injected prices | Commerce final values win |
| Memory ON vs OFF using the same retrieved candidates | Personalized ranking changes for the right reasons |
| Missing RAG or invalid audit | Failure or reference-only, never silently fabricate recommendations |

## Test entry points

- `tests/unit/brain-rag.test.ts`: strict contract, Commerce price ownership, actor-independent retrieval, pref-sensitive ranking, invalid source rejection and security.
- `tests/brain-db/brain-rag-http.test.mjs`: disposable two-database integration + session cookie auth + mock Responses + mock RAG + persisted memory rank reversal; **not a production model or external dataset test**.
- Existing `tests/brain-db/brain-pg.test.mjs`: PostgreSQL state/checkpoint recovery, tenant isolation and one-shot confirmation.

**Note:** This integration intentionally keeps all new Brain Tool actions read-only. Cart updates/checkout/cancellation remain under the existing Commerce action/approval policy.

## Temporary v4 test_items catalog (2026-10-17)

This is a separate opt-in path, not a change to the legacy contract above.
`COMMERCE_CATALOG_SOURCE=test_items` makes the dedicated QA server use explicitly
qualified `test_items.products`, `test_items.product_variants`, and `test_items.reviews`.
No global search_path change, public copy, migration, seed or fallback is performed.
The same catalog is injected into Brain retrieval and the existing product HTTP routes.
Original product/variant/review IDs are preserved and matched; review excerpts must
also match the source row. All prices, stock and options in this catalog are simulated.
API metadata, UI notices and grounded answers identify this; Commerce cart/wishlist,
order/payment/cancel APIs and the legacy Agent endpoint are blocked in this mode.
Normal `public` mode keeps its existing purchase flow.

DB team prerequisites (not executed by this change):
- Dedicated non-superuser LOGIN role, no CREATEDB/CREATEROLE/BYPASSRLS or administrative memberships.
- CONNECT on `toss`; USAGE on `test_items` and `public`.
- SELECT on only the three test_items tables; SELECT(id, display_name, auth_subject)
  on public.users for existing session login/validation. No business-table writes, DDL or RAG grants.
- Approved Tailscale/TLS path and a narrowly scoped pg_hba rule. The previously
  rejected server-observed client address was 172.20.0.1; the DB owner must verify
  that routing/NAT scope before authorizing it. Do not disable TLS certificate checks.
- Separate `brain_*` DB/service role and approved Brain migrations/checkpointer setup.
  Ordinary startup checks prepared checkpoint tables and never calls setup/DDL.
  Provisioning remains separate; never grant the Commerce read role admin privileges.

Current evidence: RAG API search/version checks passed previously. The catalog/ID,
simulated-price and write-denial paths are tested with mocks; direct DB ID matching,
browser E2E and deployment remain NOT_RUN pending the service role/network setup.

## Swapping a local search dataset

`BRAIN_RAG_MANIFEST_PATH` optionally selects an absolute, server-owned JSON file;
omitting it preserves the existing v4 encoder settings. See `SearchDatasetManifest`
in `src/brain/dataset-manifest.ts` for the versioned shape. Declare dataset ID/version,
catalog source, categories, both corpus SHA-256 values and the offline encoder's model,
dimensions and pinned revision. Unknown document-model revision stays `null`, never
an assertion that query/document provenance was verified. Known revisions must match.
Startup rejects mismatched version/category/catalog/model/dimensions/corpus and injected
search/encoder bypasses. Runtime downloads no models and rebuilds no document embeddings.
The current local transport still supports synthetic-review datasets with the existing
`test_items` Commerce mapping and ID contract; audited-real sources and arbitrary schemas
need their own approved mapping. Keep evaluation files outside the two search JSONL files.
Replacing data/DB mappings requires separate approval; this code does not perform imports.
