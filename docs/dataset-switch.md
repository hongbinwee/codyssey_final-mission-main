# 로컬 QA 데이터셋 교체

현재 활성 버전은 Manifest의 `datasetVersion`으로 식별한다. ID에 들어 있는 과거 버전 문자열로 데이터셋을 판정하지 않는다.

- Commerce 상품·옵션·리뷰는 격리 DB에 원본 ID로 복원하고 FK를 확인한다. 사용자 상태는 별도 보존하며 정확히 일치하는 참조만 이관한다.
- RAG는 같은 버전의 `indexed_products.jsonl`, `evidence_chunks.jsonl`만 사용한다. 평가셋은 제외하고 제공된 벡터를 재사용한다.
- `BRAIN_RAG_MANIFEST_PATH`: 버전·카테고리·모델·차원·질의 모델 revision·두 JSONL의 SHA-256을 담은 로컬 Manifest 절대 경로.
- `BRAIN_RAG_DATA_DIR`, `BRAIN_RAG_DATASET_VERSION`, `BRAIN_RAG_CATEGORIES`: 새 원천 경로·버전·검색 카테고리로 함께 교체한다. 단일 카테고리 고정이 필요하지 않으면 `BRAIN_RAG_CATEGORY`는 비운다.
- `BRAIN_RAG_PYTHON`, `BRAIN_RAG_MODEL_CACHE`, `BRAIN_RAG_MODEL_REVISION`: 문서 임베딩과 호환되는 질의 인코더 설정. 문서 모델 revision을 모르면 Manifest에서 `null`로 유지한다.
- `DATABASE_URL`, `COMMERCE_CATALOG_SOURCE`: 새 격리 Commerce DB와 승인된 조회 스키마를 지정한다. `src/qa-commerce.ts`의 DB·역할 allowlist는 의도적인 배포 안전 경계이므로 새 DB/역할을 승인할 때만 갱신한다. 새 스키마 식별자는 `src/catalog.ts`의 고정 allowlist도 검토한다.
- `BRAIN_DATABASE_URL`, `QA_REUSE_EXISTING_BRAIN=1`, `SESSION_SECRET`, `QA_AUTH_FILE`: 기존 Brain DB·세션·6계정 인증을 유지한다. 원문 Secret과 데이터 파일은 Git에 넣지 않는다.
- `BRAIN_ENABLED=1`, `AI_LIVE_DEMO=0`, `BRAIN_RAG_MODE=local`, `BRAIN_RAG_CONTRACT=v4`, `QA_AUTH_ENABLED=1`, `QA_COMMERCE_ENABLED=1` 및 기존 기관 LLM 설정을 사용한다. `v4`는 API 형식 이름이며 활성 데이터 버전이 아니다.
- 서버 전용 Git 제외 env 파일을 준비한 뒤 `node --env-file=<절대 경로> src/server.ts`로 실행한다. 공개 QA는 기존 HTTPS origin을 `BRAIN_PUBLIC_ORIGIN`에 지정하고 기존 터널 대상 포트를 유지한다.
- 버전 변경 시 `dataset-state.ts`가 이전 receipt/Checkpoint의 상품·근거를 현재 추천에서 제외한다. 대화·Plan·확정 Memory 원본은 삭제하지 않는다.

전환 전 별도 포트에서 로그인·검색·상품 상세·찜·카트·기존 대화 복귀를 검증한다. 이전 DB·원천·실행 설정은 보존하고, 공개 전환 실패 시 이전 연결로 복구한다. 이후 데이터셋을 현재 데이터와 합치거나 DB를 초기화하지 않는다.
