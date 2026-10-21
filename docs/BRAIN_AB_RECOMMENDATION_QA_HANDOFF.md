# Shopping Brain A/B 추천 통합 — 로컬 QA 인계 (2026-10-19)

작업 브랜치: `feature/system-prompt-integration`.
기준점: Commerce 복구가 완료된 `feature/brain-core@441f8c4`.
별도 실행 브랜치에서만 수정했다. **운영/공개 QA 서버·DB·메인 브랜치 변경 없음.** PR은 Draft로 유지한다.

## 제품 결정과 구현 의도

**최대 3개를 추천한다.**
1. B 개인화 우선: 현재 구매 의도/검증된 조건과 근거를 우선하고, 로그인 사용자의 찜·카트 기록은 강한 관심 신호로 순위를 조정한다. 과거 신호는 현재 명시적 필수 조건을 뒤집지 못한다.
2. A 후기 검증형: 개인화 1위와 중복되지 않는 후보 중 검증된 **상품 전체** 리뷰 수 >=10, 평점 >3.5/5인 상품을 수치 내림차순으로 선정한다. 메타데이터 미확인이라면 후기가 검증된 척하지 않는다.
3. 적합한 비교 대안: 다른 상품 중 근거 확인을 통과한 선택지. 세 개를 채우려고 조건 부적합 상품을 추가하지 않는다.

**LLM 두 벌이 아니라 공유 RAG 한 번 + 서버 내부 Ranking 큐레이션 한 번 + 공통 Grounded Response**로 처리한다. 과거 사용자 신호는 카탈로그/Commerce 접근을 통과한 후보에만 순위 가산을 제공한다.

## 파일별 구현

- `src/brain/recommendation-strategies.ts`: A/B 선정, 상품 ID 중복 제거, 유형/이력 신호 부착.
- `src/brain/commerce-signals.ts`: 인증된 actor의 찜·장바구니 읽기, 역할별 권한 확인 후에만 확정된 주문 이력 읽기. 쓰기 없음.
- `src/brain/read-flow.ts`: 검색 결과를 기존 rankProducts/근거 검증에 통과시킨 뒤 위 두 전략 결합; 대화별 사용자 제외 및 직전 표시 ID 추적.
- `src/brain/shopping-plan.ts`: minTotalWon, task-local excludedProductIds, lastDisplayedProductIds; 장기 Memory는 변경하지 않는다.
- `src/brain/price-band.ts`: '2만원대' [20,000,29,999] 및 '10만원대' [100,000,199,999]를 명시적 범위로 해석.
- `src/brain/personalization.ts`: 가격 최솟값도 서버 후보에서 검증.
- `src/brain/runtime.ts`: 특정 QA Commerce 전용 role/DB 연결에서만 해당 사용자의 Commerce 이력 조회. 기존 LangGraph/Checkpoint/Fencing 및 RAG 계약 유지.
- `src/brain/policy.ts`: 공유받은 v0.7과 RAG 문서의 페르소나·근거·보안·질문·오류 원칙을 현재 Brain의 Intent/Responder 프롬프트로 통합. G2는 전역 컷오프가 아니라 후기 검증형 슬롯 전용.
- `src/web/components/BrainPreview.tsx`: 추천 유형 표시, 실제 후기 수치, 사용자 관심 근거, 후보 가격에서 생성한 예산 선택 버튼, 에센스 사용 목적 버튼, 선택 상품 제외, 다른 제품 보기. 기존 새 대화/장기 선호 관리 UI 보존.

## 검증

- 신규 Unit: `tests/unit/brain-recommendation-strategies.test.ts`, `tests/unit/brain-price-band.test.ts`, `tests/unit/brain-task-exclusion.test.ts`.
- GitHub Actions `Brain core isolated QA`에서 Typecheck, Build, Brain mock/API, PostgreSQL tenant/checkpoint, HTTP/RAG mock, Browser 회귀 검증을 수행한다.
- 실제 Claude 모델의 추천·응답 지연, Cloudflare 배포, 실제 로그인 실사용 QA는 **이번 커밋만으로 증명되지 않음**. CI 종료 상태/커밋을 반드시 확인할 것.

## QA 시나리오

1. 테스터 05로 로그인 후 에센스/키보드 등 검색 → 실제 후보 가격대 버튼이 나오는가?
2. '2만원대' 선택 → 배송 포함 20,000~29,999원 외 후보가 추천으로 확정되지 않는가? '10만원대'는 100,000~199,999원인가?
3. 같은 상품을 찜/카트에 담은 뒤 새 추천 → 인증된 본인의 관심 이력만 강한 개인화 신호가 되는가? 타 테스터 이력이 섞이지 않는가?
4. 검증된 평점 >3.5 및 상품 전체 리뷰 >=10인 후보가 있는 경우 **개인화 1순위와 다른 상품**을 후기 검증형 대안으로 표기하는가? 검증된 값이 없으면 오표기하지 않는가?
5. 추천 카드 '이 상품 제외' → 해당 상품이 다음 추천에 다시 등장하지 않는가? '다른 제품 보기' → 직전 표시 전체가 제외되는가?
6. '새 대화 시작' → 이번 대화 제외 목록은 새 대화에서 재사용하지 않고, 장기 Memory·이전 대화 기록은 남는가?
7. 재추천, 오류 재시도, 다른 카테고리 전환, 실제 상품 상세 연결 시 가격/옵션/찜/장바구니가 기존처럼 작동하는가?
8. 응답 지연(p50/p95), 빈 후보, 잘못된 리뷰 인용, 실제 Claude 실패를 별도 계측한다. 모델 품질이 PASS됐다고 추측 금지.

## 알려진 한계

- 이력 신호는 우선 **같은 product_id와의 직접 관심 관계**를 반영한다. 관심 상품과 다른 브랜드·특성의 유사 상품을 찾아 선호를 일반화하는 단계는 추후 확장할 수 있다.
- 구매 기록 신호는 연결된 DB 계정이 해당 테이블을 읽을 권한이 있고 취소되지 않은 주문이 있을 때만 제공된다. 새 권한은 부여하지 않는다.
- 버튼 기반 인터뷰는 **후보 가격대 + 에센스 사용 목적**부터 구현한 버전이다. 모든 카테고리에 대한 맞춤 질문/옵션 스키마 완성본은 아니다.
- 상품별 제외와 직전 추천 전체 제외는 지원하지만, 임의 과거 질문/답변을 수정하는 별도 UI는 아직 구현하지 않았다.
- 기존 RetrieverPort의 후보 폭에 제한이 있으므로, 사용자가 이전 후보를 전부 제외하면 더 큰 카탈로그에 대안이 있어도 이번 검색 결과에서 후보가 부족할 수 있다. 없는 후보 생성 금지.
- 실제 모델 평가·실제 Cloudflare QA 배포 없음. CI mock PASS와 구분한다.
- 차후 로컬 QA에서는 기존 DB 자격 증명을 파일에 포함하거나 공개하지 말고, 노출된 Brain DB 비밀번호는 환경 소유자가 별도로 교체할 것.

## 체크아웃 및 회귀 명령 (PowerShell)

```powershell
git fetch origin
git worktree add -b qa/system-prompt-review ../system-prompt-review origin/feature/system-prompt-integration
cd ../system-prompt-review
npm ci
npm run check
npm run build
node --experimental-strip-types --test tests/unit/brain-recommendation-strategies.test.ts tests/unit/brain-price-band.test.ts tests/unit/brain-task-exclusion.test.ts
```

**원칙:** 지금 실행 중인 공개 QA 서버 또는 팀원 계정을 덮어쓰지 않는다. 로컬 QA가 끝나기 전까지 Draft PR은 병합하지 않는다.
