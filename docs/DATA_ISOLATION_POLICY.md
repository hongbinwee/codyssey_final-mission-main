# DATA_ISOLATION_POLICY — Shopping Brain

**Hard rule:** Synthetic product/review datasets v4/v5, evaluation goldsets and CI fixtures must NEVER be combined with real product/review records into one unlabeled corpus, ingestion batch, similarity index, fine-tuning input, QA benchmark or production data feed.

## Four disjoint data classes

| Data class | Permitted paths | Purpose | Forbid |
| --- | --- | --- | --- |
| `SYNTHETIC_PRODUCT` | team v4/v5 packages in a separately named synthetic dataset, database/schema/index | Isolated recommendation/RAG demonstration | Treating invented reviews as verified REAL Amazon sources; real-index import |
| `EVALUATION_ONLY` | `eval/brain/**` | Frozen questions, expectations, blind holdout / reports | Training/fine-tuning; product ingestion; generating real recommendations |
| `CI_FIXTURE` | `tests/brain-*/**` and disposable `brain_ci`, `commerce_brain_*_ci` | Reproducible security/HTTP/UI failure tests | Cloud production DB, real user rankings or verified source attribution |
| `AUDITED_REAL` | separate explicitly approved ingestion and real-only vector collection | Genuine products/reviews with legal source, licensing, ID mapping and external provenance | Unapproved synthetic test rows, labels or goldset |

This repository does NOT yet contain the actual v4/v5 ZIP package or real Amazon/RAG source. A mention in this policy is not evidence the package has been inspected.

## Hardening contract

- Every future dataset package must ship a manifest with `dataset_id`, `version`, `data_class`, `source_kind`, record counts, schema version, provenance, and SHA-256 checksums.
- Only immutable reviewer-approved manifests may carry `AUDITED_REAL`; an upstream response that self-declares `REAL` or matches an audit-ID string is not sufficient provenance evidence.
- Use distinct namespaces, credentials, staging tables and vector indices. Never UNION or silently concatenate synthetic and real records. No production path may access CI fixtures or `eval/brain/**`.
- RAG adapter must fail closed when provenance is missing. Demo synthetic products can be displayed as explicitly labeled demo/reference-only, never quietly converted into real-user recommendations.
- Training/dev split and fixed holdout are evaluation-only; do not expose holdout labels to the prompt, retrieval system or tuning loop. Every pass/fail report needs dataset version and mode label.
- Data erasure must cover app memory and checkpoint/transcript retention; deleting one canonical preference alone does not prove full user data erasure.
- Any transition from test to live service requires independent manifest audit, isolated DB credentials, source review and explicit team approval.

## Automated enforcement

`tests/unit/brain-data-isolation.test.ts` and `src/brain/data-isolation.ts` reject unknown/mixed data-class manifests and disallow `AUDITED_REAL` imports into synthetic/evaluation paths. This guards loader contracts; it does NOT yet police all future ETL scripts, remote RAG endpoints or third-party provider data.

**Do not label a synthetic CI fixture `REAL` in a production-serving ingestion manifest.** Existing integration tests that use `REAL`-shaped mock records are solely simulations of upstream protocol and are never a real review provenance audit.
