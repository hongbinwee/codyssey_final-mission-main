export function Loading({ text = "불러오는 중…" }: { text?: string }) {
  return <div className="state-box">{text}</div>;
}
export function CatalogNotice({ checkoutEnabled = false }: { checkoutEnabled?: boolean }) {
  return <div className="state-box" role="note">검증 중인 데이터셋 테스트
    <p>가격·재고·옵션은 시연용입니다. {checkoutEnabled ? "테스트용 모의 구매만 가능하며 실제 결제는 발생하지 않아요." : "실제 판매 정보가 아니며 주문·결제할 수 없어요."}</p>
  </div>;
}
export function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="state-box">
      <p>{text}</p>
      {action}
    </div>
  );
}
export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="state-box error">
      <p>{text}</p>
      {onRetry && (
        <button className="btn ghost" onClick={onRetry}>다시 시도</button>
      )}
    </div>
  );
}

