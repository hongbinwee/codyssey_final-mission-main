// 찜 하트 버튼 공용체 [PMQA-070] — 카드 오버레이(.wish-heart)·상세 하단
// CTA(.detail-heart) 등 className으로 배치하고 동작은 공유한다.
//
// [동작 계약]
// - 확정 상태만 표시한다 — 낙관적 채움 금지(useWishToggle이 서버 ok만
//   반영). 목록 미확정이면 토글 대신 명시 재조회만 수행한다.
// - LOST/PENDING_EXISTS는 '찜에서 확인' 복구 진입을, REJECTED/BUSY는
//   인라인 안내로 표면화한다 — 결과를 조용히 무시하지 않는다.
// - 저장 확정 시 Ref06 구조(상품 표시 + 바로가기 + 닫기)의 시트를 연다.
// - 계정 전환 시 이전 계정의 시트·메시지는 useWishToggle 안에서 닫힌다.
import { IcHeart, IcHeartFill } from "../icons.tsx";
import { useWishToggle } from "../wishlist.ts";
import { WishSavedSheet, type WishSheetProduct } from "./WishSavedSheet.tsx";

export function WishButton({
  userId,
  product,
  onGoWish,
  className,
  commerceEnabled = true,
}: {
  userId: string | null;
  // 시트 표시용 — 카드/상세가 이미 가진 상품 정보를 그대로 넘긴다.
  product: WishSheetProduct;
  onGoWish: () => void;
  className: string;
  commerceEnabled?: boolean;
}) {
  const t = useWishToggle(commerceEnabled ? userId : null, product.product_id);
  return (
    <>
      <button
        className={className + (t.saved ? " on" : "")}
        disabled={!commerceEnabled || t.busy || !userId}
        title={!commerceEnabled ? "현재 조회 전용 QA 환경에서는 찜을 저장할 수 없어요" : undefined}
        aria-pressed={t.saved}
        aria-label={t.saved ? product.name + " 찜 해제" : product.name + " 찜하기"}
        onClick={(e) => {
          e.stopPropagation();
          void t.toggle();
        }}
      >
        {t.saved ? <IcHeartFill size={16} /> : <IcHeart size={16} />}
      </button>
      {t.fb && (
        <span className="wish-fb" role="status">
          {t.fb.msg}
          {t.fb.goWish && (
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                onGoWish();
              }}
            >
              찜에서 확인
            </button>
          )}
        </span>
      )}
      {t.savedOpen && (
        <WishSavedSheet
          product={product}
          onClose={t.closeSaved}
          onGoWish={() => {
            t.closeSaved();
            onGoWish();
          }}
        />
      )}
    </>
  );
}

