# Fast / Deep 연결 경계

현재 서비스는 FAST만 실행한다. `execution_mode` 생략 또는 `FAST`는 기존 턴을 호출하고, `DEEP`는 501로 종료한다. UI에 미구현 기능을 활성화하지 않는다.

향후 Deep 진입은 인증된 사용자·대화의 완료된 Fast 결과에 한정한다. 서버가 Plan revision, dataset version, Product/Variant ID, 검증된 Evidence ID를 고정하고 immutable snapshot ID를 발급한다. 사용자가 제출한 ID나 hash만으로 소유권을 인정하지 않는다.

`DeepHandoff`는 actor/conversation/request, Plan revision, snapshot ID, fence generation을 함께 전달한다. 결과 게시 직전 현재 canonical 결과와 일치하는지 다시 읽고 기존 DB Fencing CAS 안에서 확인해야 한다. 이전 질문·다른 사용자·바뀐 Plan의 결과는 최신 결과를 덮어쓸 수 없다. `snapshotMatches`는 비교용이며 인증이나 CAS 구현을 대신하지 않는다.

Deep LLM, 별도 Graph, snapshot 저장소와 심층 분석 엔진은 이번 범위에 없다. 향후 UI의 '꼼꼼하게 비교하기'는 이 서버 소유권 계약을 갖춘 API가 구현된 뒤 연결한다.

Fast는 명확한 단일 상품명·예산 요청을 TypeScript로 해석하고 복잡한 조건은 기존 LLM Intent로 보낸다. 일반 검색은 검증된 카드·조건의 결정적 응답을 먼저 반환하고, 리뷰/장단점/비교 요청은 기존 Claude 근거 응답을 사용한다. `candidatesReadyMs`는 내부 후보 준비 시간이며 브라우저 표시 시간이 아니다. 현재 HTTP는 턴 완료 응답이므로 비교 요청 중간 카드 스트리밍은 미구현이다.

현재 정책은 Hard Constraints / Ranking Signals / Evidence로 분리한다. 기존 v0.6 원문은 보존하되 임시 3.5점·10개 게이트를 서비스에 적용하지 않는다. 서현님 검토 프롬프트는 확인되지 않아 통합하지 않았다.
