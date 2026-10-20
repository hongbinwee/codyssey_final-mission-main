# Hermes H6 — 종합 QA·최적화 결과 및 실환경 검증 기준

2026-10-20. 개발 기준: `feature/hermes-agent`만. `main`, `feature/brain-core`, 기존 QA 서버 및 DB·Tunnel 미변경.

## 1. 지켜야 할 제품 목표
시나리오 8개를 하드코딩하지 않는다. 범용 Tool + Skills + LangGraph Task State + LLM 결과 기반 재판단이 기준이다. 테스트 케이스와 품질 게이트는 **행동을 평가**하기 위한 것이지 특정 문구를 실행 규칙으로 구현하는 것이 아니다.

## 2. H6에서 실제 적용한 최적화
- `src/brain/hermes-observation-prompt.ts`는 **LLM의 다음 행동 선택에 쓰는 Tool 관찰값만** whitelist로 줄인다. 최대 5개 관찰, 찜·카트·주문 10개씩, 리뷰 5개(본문 200자), 옵션 8개, 배송 이벤트 8개. 주문 수취인·주소·전화·결제정보·미승인 메타 필드는 모델 입력에서 제외한다.
- **원래 서버 Tool 결과·권한 검증·Graph Checkpoint는 유지한다.** 모델 입력용 축약본이 서버의 현재 상품 ID·주문 ID 확인 근거를 대체하지 않는다.
- `src/brain/graph.ts`는 `hermesDecisions`, `hermesDecisionMs`, `hermesToolMs`, `hermesFailedTools`, `hermesToolCalls`를 숫자형 Trace에 기록한다. 프롬프트·리뷰 원문·주문 ID·사용자 ID를 Trace로 내보내지 않는다. 총 응답 지연은 기존 `totalMs`와 별도다.
- 이 최적화는 **입력 크기와 데이터 노출 면적을 줄이는 코드 변경**이다. 실제 모델 토큰 수·비용·p95 개선 효과를 측정했다는 의미는 아니다.

## 3. 공통 H6 평가기
- `src/brain/hermes-evaluation.ts`: Tool **순서 전체 일치**, 완료/질문/안전 거절 결과, 불필요한 RAG 검색 비율, 출처 근거 검증, 계정 격리, 무승인 쓰기, 지연 p50/p95/max.
- 각 표본에는 `DETERMINISTIC_MOCK` / `LIVE_MODEL` / `CONNECTED_E2E` **실제 실행 모드**를 보존한다. 모의 LLM 결과를 라이브 성능으로 합산하거나 사용하지 않는다. 실측 없는 지표는 `null`/`NOT_MEASURED`로 남긴다.
- `scripts/hermes-h6-report.ts`는 **로컬 메타데이터 JSON**을 읽어 집계만 출력한다. 알 수 없는 필드·개인정보나 원문을 포함한 입력은 거부한다. 입력 파일이나 사용자 정보를 GitHub에 Push하지 말 것.
- 임시 품질 목표(배포 기준은 팀이 최종 승인): 순서 전체 일치 ≥90%, 불필요한 검색 ≤5%, p95 ≤60,000ms, 무승인 쓰기 0, 근거·계정 격리 위반 0. 실제 통합 검증에는 라이브 ≥20건, 연결 E2E ≥10건, 근거 ≥10건, 계정 격리 ≥10건이 요구된다.
- 모든 임시 기준을 통과하더라도 보안·운영 인수 검증 없이 자동 배포하지 않는다.

예상 메타데이터 예시(사용자 메시지/계정/토큰/주소 제외):
```json
[
 {"caseId":"local-live-001","mode":"LIVE_MODEL",
  "expectedTools":["get_orders","get_shipping_status"],
  "actualTools":["get_orders","get_shipping_status"],
  "searchRequired":false,
  "outcomeExpected":"ANSWERED","outcomeActual":"ANSWERED",
  "grounded":true,"actorIsolated":null,"writeWithoutApproval":false,
  "durationMs":12345}
]
```
실행: `node scripts/hermes-h6-report.ts ./<로컬-검증결과>.json`
일부 또는 전체 측정이 빠졌을 때 exit code 1 + 부족한 측정 지표를 표시한다. **표본을 임의로 복제하여 수를 채우지 않는다.**

## 4. 실제 GitHub Actions 검증 (격리 / deterministic)
[Run 39355626901](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/39355626901), 검증 소스 커밋 `d1034c5c31cec7d465dbd7a18b0411a1f9ce9fdf`:
- 전체 `npm run check` 및 `npm run build`: **PASS**.
- H1~H6 지정 회귀 단위 테스트: **105/105 PASS**, 실패 0.
- 실제 LangGraph MemorySaver를 실행한 비라이브 평가: 장바구니·주문·배송 표현 변형 **12건**, 기대 Tool 순서와 일치, RAG 0회. 이는 **mock provider를 쓴 그래프 제어·Tool 경계 검증**이며 실제 모델의 추론 정확도 측정이 아니다.
- 추가 보안·품질 테스트: Tool 관찰값 whitelist/축약, 임의 메타데이터·계정/주문 필드 차단, ID 근거 유지, 제품/주문 Tool 권한, 미승인 쓰기, 리뷰의 프롬프트 인젝션, 소량 라이브 측정의 거짓 통과 차단.
- 전체 `npm run test:unit` 참고 진단: **1,021개 중 976 PASS, 44 FAIL, 1 SKIP**. CI에서는 `continue-on-error: true`인 진단 단계라 전체 Job 성공처럼 보이더라도 **전체 유닛 통과가 아니다.**
- 관측한 실패 원인 예: `shots/pmqa079-.../preflight.json` 및 `shots/06a/pmqa043/commerce_test_prdump.sql` 같은 GitHub CI에 없는 감사·백업 아티팩트, live API 키를 요구하는 `brain-network-failure` 테스트, 기존 `catalog-source`의 과거 안내 문구 기대값 불일치, 기존 standalone 테스트. 44개를 전부 H6 신규 버그나 전부 환경 탓으로 단정하지 않는다.

## 5. 아직 완료되지 않은 실환경 QA — Codex/local QA 담당
**본 채팅의 GitHub Actions 환경에는 로그인된 실제 QA Commerce DB, DGX RAG, Claude/Decisions 서비스 및 브라우저 사용자 세션이 없다. 현재 실환경 결과는 새로 생성하지 않았다.** 이전 `docs/HERMES_LOCAL_QA_20261020.md`의 실제 연동 결과는 별도 시점의 실험으로, 이번 H6의 라이브 측정으로 재분류하지 않는다.

실행 순서:
1. **승인받은 별도 worktree / 별도 포트 / 기존 브랜치 HEAD**에서 `npm ci`, `npm run check`, `npm run build`, `node --test tests/unit/brain-hermes-*.test.ts` 실행. 기존 QA 서버·DB·Tunnel을 재시작·초기화하지 않는다.
2. 승인된 **읽기 전용 QA DB + RAG + 실제 모델 연결**에서 독립 표본 20건 이상 실행. 요청 언어·완곡한 표현·다중 의도·Tool 빈 결과·429/504/timeout·리뷰 인젝션·대화 중단/재개를 포함하되 평가 문구로 엔진 분기를 하드코딩하지 않는다.
3. 주문·장바구니·취소 대상은 **본인 권한**과 다른 계정의 접근 거부를 테스트한다. 읽기 요청에 DB mutation 0, 주문 확정/취소는 기존 사용자 명시 확인 전에는 0건인지 기록한다.
4. 독립 테스트 계정과 분리된 DB에서 승인된 범위의 **Playwright 브라우저 E2E 최소 10건**: 상품 상세→옵션→장바구니→견적→사용자 확인, 주문→배송, 취소 가능/불가, 재고 변경·오래된 추천 카드, 오류 복구, 사용자의 재로그인. 실제 결제·취소 또는 데이터 초기화는 승인 없이 실행하지 않는다.
5. **Tool 선택 정확도, 불필요한 검색, 근거 일치율, 분리된 p50/p95(조회/추천), 실제 모델 호출수/지연/비용, 실패 사유**를 기록한다. 평가 메타데이터는 로컬 전용 JSON으로만 생성하고 `node scripts/hermes-h6-report.ts ...`로 집계한다.
6. 전체 유닛 실패 44건은 (a) 원본 QA snapshot/감사 artifact 필요, (b) 실 API 필요, (c) 의도적으로 변경된 문구의 낡은 검증, (d) 실제 코드 회귀로 분리한다. 아티팩트를 가짜로 만들어서 PASS 처리하지 않는다.
7. **전부 검증 전에는 H6 실서비스/배포 완료로 표기하지 않는다.** 브랜치 병합·QA 재배포·기존 환경 변경에는 별도 승인 필요.

## 6. 열린 설계 위험
- `MAX_AGENT_MS`는 **LLM 판단 시간** 중심이며 모든 DB/RAG/최종 자연어 설명 시간을 포함한 강제 end-to-end deadline은 아니다. 외부 요청의 실제 취소 가능 인터페이스를 조사한 뒤 별도 총 지연 정책이 필요하다.
- H4의 `readAgentRoute`에는 현재 고신뢰 규칙이 남아 있다. 임의 자연어의 Tool 선택 정확도는 라이브 평가 전까지 확인할 수 없다.
- 설명 생성의 20초 타임아웃과 근거 기반 fallback의 실 사용자 의미 품질은 실환경에서 별도 점검해야 한다.
- 계정 격리, Checkpoint fencing, 승인 및 결제 복구는 실제 분산 DB와 브라우저 환경의 부하·장애 테스트가 필요하다.
