# Shopping Brain — v0.7 시스템 프롬프트 통합 검토 (초안)

- 기준 브랜치: `feature/system-prompt-integration`
- Commerce 복구 기준 커밋: `441f8c459a84775b988c71fa462b64308cd5e68a` (격리 Brain CI SUCCESS)
- 작성 목적: v0.7 Agent 기본 지침, 2026-10-19 RAG 프롬프트 공유 PDF, **실제** `src/brain/*` 실행 코드를 비교한다.
- 상태: **정적 코드 대조 완료 / 정책 확정·기능 구현·실제 Claude QA 미진행**
- 금지: `main`, QA 서버, Commerce DB, Brain DB, 실사용 메모리 변경 없음. 본 문서는 승인 없이 추천 정책을 변경하지 않는다.

## 1. 출처 및 실행 경로 구분

1. 사용자 공유 `Toss Shopping Brain — Agent 기본 지침 v0.7` 및 `v0.7 앱 변경 명세`는 **Mock Agent 단독 실험용 검토 초안**으로, 앱 기능 구현을 증명하지 않는다.
2. 사용자 공유 `rag-system-prompt-share-2026-10-19.pdf`는 **별도 Backend 로컬 작업본**의 `src/agent.ts`, `src/llm.ts`, `price-policy.ts`, `rag-search.ts` 및 직접 RAG UI를 설명한 **코드 스냅샷**이다. 현재 통합 저장소의 `src/brain` 경로와 동일하다고 가정하면 안 된다.
3. 현재 사용자의 AI 패널은 `src/web/components/BrainPreview.tsx` → `/api/brain/conversations/:id/turn` → `src/brain/graph.ts` → `src/brain/intent.ts`·`read-flow.ts`·`personalization.ts`·`grounded-response.ts`이다. `src/agent.ts`의 레거시 `SHOPPING_SYSTEM`을 고쳐도 이 경로 전체에 자동 반영되지 않는다.
4. 실제 검색은 `RetrieverPort` 및 `verifiedRagRetriever`/로컬 v4 RAG 경계로 수행한다. PDF의 `search_rag` 도구 이름과 입력 계약을 이 경로에 직접 대입하지 않는다.
5. `src/brain/runtime.ts`에서 `fastResponses:true`; `src/brain/graph.ts`에서 일반 검색 응답은 결정적 생성기로 진행하고, 리뷰 비교 등 일부 경우만 실제 LLM Grounded Responder를 이용한다. **프롬프트 수정만으로 모든 사용자 응답이 달라지지 않는다.**

## 2. 확인된 규칙·계약 충돌

| 항목 | v0.7 / PDF 주장 | 현재 실행 코드 | 판정 및 최소 조치 |
|---|---|---|---|
| G2 일반 추천 자격 | v0.7은 평점 **>3.5**, 전체 리뷰 수 **>=10** 필수; 일반 0건일 때만 수치 미달의 조건부 추천 | `src/brain/policy.ts`는 3.5/10을 **필수 컷오프 아님**이라고 명시. `personalization.ts`는 가격·개인화·근거 점수 랭킹 | **정책 결정 필수**. 기존 기준을 무단 반전시키면 회귀. v0.7은 검증된 메타데이터를 가진 독립 Mock/격리 환경에서 우선 평가 |
| 정렬 | v0.7 평점↓ → 전체 리뷰 수↓ → 입력 순서 | 현재 `rankProducts`는 복합 score↓ | **정책 결정 필수**. 개인화 기능 훼손 여부 평가 없이 정렬 덮어쓰기 금지 |
| 리뷰 메타의 정본 | v0.7 전체 리뷰 수와 검색된 리뷰 조각 수 구분, 누락/무효면 조건부 추천에도 불가 | `wholeReviewCountVerified`가 분리되어 있고 QA 합성 검색 표본 평점은 전체 평점이 아님 | **기존 검증 보존**. 조회된 리뷰 N개를 전체 리뷰 수로 보정 금지 |
| 조건부 추천 표현 | v0.7 일반 0건에만 조건부, 각 후보에 실측 평점·리뷰 수·미달 기준 모두 표시 | `RankingResult`는 ranked/referenceOnly/rejected뿐; UI/응답에 공식 CONDITIONAL 분류와 사유 없음 | 프롬프트 붙여넣기만으로 구현 불가. 정책 확정 후 최소 서버 판정 및 UI/테스트 연결 |
| 예산·용도 질문 | PDF는 둘 다 없으면 검색 금지; 가격 TARGET/MAX/RANGE. v0.7은 불필요한 반복 질문 금지·예산 미정이면 숫자 상한 강요 안 함 | 현재 `maxTotalWon:number|null`, `requiredConditions`; TARGET/RANGE를 그대로 표현하지 못함 | **계약 결정 필수**. 미정 예산을 0원이나 임의 숫자로 바꾸지 않음. PDF 슬롯 가드를 곧바로 이식하지 않음 |
| 배송비 | PDF는 단일 배송비 3,000원 | 현재 후보 `shippingFeeWon` 및 Commerce 검증이 정본 | **Commerce 실값 우선**. 프롬프트에 고정 3,000원을 권한 있는 데이터처럼 주입 금지 |
| 상품 검색 | PDF `search_rag`만 허용, 최대 20개 | Brain은 `RetrieverPort`를 통해 검색하며 UI 최대 3개 표시 | 기존 Retriever 계약 유지; 레거시 Agent 도구 이름·인자를 Brain에 새로 만들지 않음 |
| G8 불만족·제외 | 직전 **실제로 표시한** product_id 누적 제외, 재추천 시 복귀 금지 | `ShoppingPlan`에는 제외 목록/마지막 표시 ID 없음 | **상태·서버 검증 필요**. LLM 기억에 의존하거나 존재하지 않는 검색 필드를 추가하지 않음 |
| G9 답변 수정·초기화 | 특정 조건만 갱신, 새 탐색에서 과거 조건 재사용 금지, 느린 응답 무시 | Plan은 query/budget/requirements/preferences/category/revision 중심; 명시적 전체 탐색 epoch와 별도 제외/수정 대상 없음 | **상태·UI·동시성 테스트 필요**. 대화/Memory/Checkpoint 삭제와 초기화를 혼동하지 않음 |
| G10 무의미 입력 | 잡음은 검색 금지, 의미 있는 자모/오타는 구분 | `routing.ts`에 일부 휴리스틱 검사 | 부분 구현. A21~A24 등으로 실제 Route·Plan 보존 검증 |
| 상품 중복 | 동일 product_id는 전체 추천에서 1개; 수치 충돌 시 임의 선택 금지 | `grounded-response.ts`와 `BrainPreview.tsx`는 **표시 단계** 중복 제거; ranking·데이터 계약은 별도 | 서버 후보 정합성 검증이 선행돼야 함. 화면 제거만으로 수치 충돌 해결이라고 하지 않음 |
| 인용 ID | v0.7 `source_id`, PDF `review_id` | Brain `evidence.id`/`sourceId`, Product/Variant ID 구분 및 Dataset Version 검증 | Adapter에 **실제 ID 매핑** 필요. 없는 리뷰 인용 만들지 않음 |
| 오류 | v0.7 Tool/입력/LLM 오류 분리, 프롬프트가 API 실패를 처리한 척하지 않음 | `src/brain/api.ts`는 출력 오류·타임아웃·429·인증 등을 구분, UI에 오류 메시지 처리 | 기존 에러 경계 유지, 필요한 표시/재시도만 회귀 테스트 |
| 보안·권한 | v0.7 S1~S3, 상품/리뷰 명령 무시, 구매·개인정보 무단 실행 금지 | Brain 조회 중심 + 명시적 선호 승인 + 인증·Fencing 존재 | 프롬프트 강화는 보조 수단. 기존 서버 검증·권한·행 잠금·멱등성 보존 |
| CS | PDF에 `CS_SYSTEM` 있지만 CS 브레인 UI/API 비활성 | 새 Brain도 read-only이며 CS 요청은 라우팅 안내 | CS Agent 활성화/주문·결제 API 해제를 이번 프롬프트 작업에 포함하지 않음 |

## 3. 권장 통합 원칙 (미확정 정책을 사실처럼 배포하지 않음)

- 강한 페르소나, 보안/권한, 근거·가드레일, 추천 정책, 답변 스타일을 **파일·역할별 명시적 절**로 분리한다. 동일 규칙을 Intent, Ranking, Responder, UI에 무조건 중복 하드코딩하지 않는다.
- 서버가 확정해야 할 것: 권한, 사용자 소유권, 가격·재고·예산 경계, 필수 조건, 제외/상태/중복/추천 판정, 근거 ID·데이터셋 버전, 실패 시 안전한 오류, 최대 표시 수.
- LLM의 역할: 질문 이해, 필수/선호 구분, 대화 요약, 검증된 인용에 근거한 장단점 한국어 표현. LLM 단독 문장을 저장 성공·추천 자격 통과의 증거로 사용하지 않는다.
- v0.7과 현행 `shopping-service-v2`의 G2·정렬은 **명백한 제품 정책 충돌**이므로 결정을 기록하기 전에는 QA 서버 동작을 변경하지 않는다.
- 현재 평가·데이터셋에서 전체 리뷰 수가 검증되지 않았다면 v0.7의 엄격한 G2를 자동 활성화해 '후보 0개'를 양산하지 않는다. 테스트 시에는 수치를 검증된 독립 Fixture로 명시한다.
- PDF의 별도 Backend 실험 내용을 현재 `src/agent.ts` 또는 `src/brain`에 무비판적으로 병합하지 않는다.
- v0.7의 G8/G9는 별도 **탐색 상태 계약**과 테스트가 갖춰질 때 기능 완료라고 보고한다.
- API 토큰·비밀번호는 프롬프트나 저장소 문서에 기재하지 않는다.

## 4. 범위를 제한한 구현·QA 단계

### A. 프롬프트·계약 정렬 (Commerce 영향 0)

1. 코드에서 실제 사용 중인 System Prompt 조립 경로와 버전 값을 한눈에 식별하도록 문서화하고, 안전한 공통 페르소나/G1/S1~S3/오류 규칙을 `src/brain` 경로에만 통합한다.
2. 현행 `Intent`의 JSON Schema, `GroundedResponder`의 claims Schema, RetrieverPort, 데이터셋 근거 검증은 깨지지 않도록 유지한다.
3. 위 G2/정렬/가격 정책은 결정 전 원래 코드를 유지하고, 별도 v0.7 정책 Fixture에서만 기대값 테스트한다.

### B. 합의된 정책의 서버 적용

1. G2/정렬을 최종 결정한 후, **프롬프트가 아니라 서버 Ranking 함수**에 적용하고 REFERENCE_ONLY/CONDITIONAL 구별 근거를 검증한다.
2. G8/G9를 적용한다면 제외한 Product ID·실제 표시 순서·탐색 epoch를 기존 Plan/Checkpoint 구조에 최소 확장한다. 기존 인증·Canonical Fencing을 우회하지 않는다.
3. 필요한 경우에만 TARGET/RANGE 계약 확장을 설계·검증한다. 현행 숫자 상한을 다른 의미로 재활용하지 않는다.
4. 사용자 UI·실제 모델에 모두 반영된 뒤에만 완료로 표시한다.

### C. QA 수용 기준

- v0.7 A01~A30을 개발용 평가 사례로 이식, 최소: 경계 3.5/10, 일반 0건 조건부, 입력 순서 및 중복, 누락값, 예산 초과, 제외한 상품의 재등장 방지, 초기화 직후 늦은 응답 무시, 인젝션, LLM 타임아웃.
- 추가: 다중 턴 기존 조건 보존, Memory보다 현재 요청 우선, source_id와 Product/Variant ID 일치, 잘못 연결된 리뷰 거부, 공개 QA의 기존 Commerce 찜·카트 성공 유지.
- 모델/프롬프트를 한꺼번에 바꾸지 않고 동일 입력·모델·데이터셋으로 v0.6/서비스-v2 대비 새 정책을 평가한다. 정확도/지연 p50·p95/오류율은 실측만.
- 실 DB/Cloudflare QA는 tester_05만 사용하고 사용자 1~4·6 계정, Memory, 거래 데이터·체크포인트를 건드리지 않는다.
- 구현과 CI·실모델 QA를 실행하지 않았다면 PASS로 주장하지 않는다.

## 5. 정책 결정 2건

**D1 — v0.7 엄격 G2를 실서비스 추천 자격으로 강제할 것인가?**
- 옵션 A: v0.7 그대로 (평점 >3.5, 검증된 전체 리뷰 수 >=10, 일반 0건일 때 조건부). 데이터가 검증되지 않으면 빈 결과가 많아질 수 있음.
- 옵션 B: 기존 서비스-v2의 필수 조건+근거 중심 자격을 유지하고 평점·리뷰 수를 개인화 Ranking의 보조 신호로 사용. 이는 v0.7 G2를 적용한 것으로 표기할 수 없음.
- **권장 임시 처리: 옵션 B를 QA 서버에 유지하면서 A/B 독립 평가 후 사용자 승인을 받는다.**

**D2 — 검색 전 예산·사용 목적 강제 확인/가격 범위 정책은 무엇인가?**
- PDF는 두 슬롯이 반드시 있어야 검색하며 TARGET/RANGE/MAX로 구분한다.
- v0.7은 조건의 중요성에 따라 질문하며 예산이 미정일 때 임의 상한을 만들지 않는다.
- **권장 임시 처리: 현행 Retriever 계약에 없는 TARGET/RANGE를 무리하게 이식하지 않고 현재 명시 조건으로 검색한다.** 명시 상한은 지키고 '대략'을 임의 MAX로 변환하지 않는다. 필요성이 검증되면 별도 계약 제안.

본 문서는 코드 구현 승인 또는 QA 배포 승인이 아니며, 두 결정 전에도 비충돌 공통 프롬프트·평가 Fixture 정비는 진행할 수 있다.
