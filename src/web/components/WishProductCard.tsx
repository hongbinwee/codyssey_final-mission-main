// 상품 카드 + 찜 하트 [PMQA-070] — ProductCard의 단일 <button> 안에
// 중첩 버튼을 두지 않기 위해 형제 래퍼 오버레이로 배치한다(중첩 button
// 금지). 카드 우하단 card-cart는 aria-hidden 장식, 하트는 실제 찜 Action —
// 위치·동작을 구분해 카트와 역할이 섞이지 않게 한다.
// 동작은 WishButton에 위임 — 확정 상태만 표시, 목록 미확정 시 재조회만,
// LOST/REJECTED는 인라인 안내 + 찜 복구 진입을 제공한다.
import type { ProductSummary } from "../../contracts.ts";
import { ProductCard } from "./ProductCard.tsx";
import { cardMinPriceOf } from "../display-meta.ts";
import { WishButton } from "./WishButton.tsx";

export function WishProductCard({
  p,
  userId,
  onOpen,
  onGoWish,
  variant,
  commerceEnabled = true,
}: {
  p: ProductSummary;
  userId: string | null;
  onOpen: () => void;
  onGoWish: () => void;
  variant?: "search";
  commerceEnabled?: boolean;
}) {
  return (
    <div className="wish-cell">
      <ProductCard p={p} onOpen={onOpen} variant={variant} />
      <WishButton
        className="wish-heart"
        userId={userId}
        commerceEnabled={commerceEnabled}
        product={{
          product_id: p.product_id,
          name: p.name,
          image: p.image,
          // 빈 variants는 null 스냅샷 — 가짜 가격을 저장하지 않는다 [F03]
          price_won: cardMinPriceOf(p),
        }}
        onGoWish={onGoWish}
      />
    </div>
  );
}

