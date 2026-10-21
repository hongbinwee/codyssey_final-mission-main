// F16 내 쇼핑 — Ref078 대시보드 [PM 관측]: '내 쇼핑' 제목 → 최근 본 상품
// thumb rail + 전체보기(→Recent) → '주문 목록' + 전체보기(→Orders) →
// 최근 주문 가로 카드(실제 상태·일자·상품 이미지·주문 상세 CTA).
// limit=3의 첫 페이지 결과를 전체 주문 수로 표기하지 않는다 — 총 개수 표기 없이
// '전체보기'로만 진입한다. 포인트·쿠폰·문의 등 미지원 항목은 만들지 않는다.
// orders/products 로드는 독립 게이트 — 한쪽 재시도가 다른 쪽 응답을
// 무효화하지 않는다 [C/069 선제 검수].
import { useEffect, useState } from "react";
import { apiSafe, type ApiResult } from "../api.ts";
import type { OrderListItem, ProductSummary } from "../../contracts.ts";
import { productImg } from "../display-meta.ts";
import { cardHead, koShortDate } from "../../order-display.ts";
import { listRecentViews } from "../recent-viewed.ts";
import { fetchProductsByIds, type ProductLookup } from "../catalog-lookup.ts";
import { createRequestGate } from "../request-gate.ts";
import { useWishlist } from "../wishlist.ts";
import { IcChevronRight } from "../icons.tsx";

type OrdersPage = {
  orders: OrderListItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export function MyShop({
  userId,
  onOpenRecent,
  onOpenWish,
  onOpenOrders,
  onOpenOrder,
  onOpenProduct,
  onOpenShop,
  commerceEnabled,
}: {
  userId: string | null;
  onOpenRecent: () => void;
  onOpenWish: () => void; // 준비중 찜 표면(recent?tab=wish)의 단일 진입
  onOpenOrders: () => void;
  onOpenOrder: (orderId: string) => void;
  onOpenProduct: (productId: string) => void;
  onOpenShop: () => void;
  commerceEnabled: boolean;
}) {
  const [orders, setOrders] = useState<ApiResult<OrdersPage> | null>(null);
  const [lookup, setLookup] = useState<ProductLookup | null>(null);
  // 리소스별 독립 게이트 — 같은 seq를 공유하면 후행 begin이 선행 응답을 죽인다.
  const [ordGate] = useState(createRequestGate);
  const [prodGate] = useState(createRequestGate);
  // 로컬 기록은 명시 actor로 읽는다 — 전역 scope가 없어 다른 계정 버킷을
  // 읽을 경로가 없다. 렌더는 현재 상품 API 데이터로만 한다.
  const recentIds = listRecentViews(userId);
  // 찜 건수는 서버 확정 목록 기준 — useWishlist 내부가 scope 확정 후
  // 적재를 보장한다(미확정이면 0으로 표시하지 않고 칩을 숨긴다).
  const wishCount = useWishlist(commerceEnabled ? userId : null).count;

  async function loadOrders() {
    const live = ordGate.begin();
    const r = await apiSafe<OrdersPage>("/api/orders?limit=3");
    if (!live()) return;
    setOrders(r);
  }
  async function loadProducts() {
    const live = prodGate.begin();
    const r = await fetchProductsByIds(listRecentViews(userId));
    if (!live()) return;
    setLookup(r);
  }
  useEffect(() => {
    loadOrders();
    loadProducts();
    // unmount/계정 전환 시 두 채널의 후행 응답을 모두 차단한다.
    return () => {
      ordGate.kill();
      prodGate.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const found: ProductSummary[] = lookup?.ok ? lookup.found : [];
  const hidden = lookup?.ok ? lookup.missing.length + lookup.unread.length : 0;

  return (
    <div className="screen">
      <h2 className="section-title myshop-title">내 쇼핑</h2>

      <div className="myshop-sec-head">
        <h3>최근 본 상품</h3>
        <button className="link" onClick={onOpenRecent}>
          전체보기
        </button>
      </div>
      {recentIds.length === 0 ? (
        <div className="myshop-empty muted sm">최근 본 상품이 없어요</div>
      ) : !lookup ? (
        <div className="muted sm">불러오는 중…</div>
      ) : !lookup.ok ? (
        <div className="muted sm">
          상품 정보를 불러오지 못했어요{" "}
          <button className="link" onClick={() => loadProducts()}>
            다시 시도
          </button>
        </div>
      ) : (
        <>
          <div className="hscroll recent-rail">
            {found.slice(0, 12).map((p) => (
              <button
                key={p.product_id}
                className="recent-thumb"
                onClick={() => onOpenProduct(p.product_id)}
                aria-label={p.name}
              >
                <img
                  src={productImg(p)}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              </button>
            ))}
          </div>
          {hidden > 0 && (
            <div className="muted sm recent-note">
              확인할 수 없는 상품 {hidden}개는 전체보기에서 확인할 수 있어요
            </div>
          )}
        </>
      )}

      {/* 찜 — 서버 SET_WISHLIST 실구현 [PMQA-070]. 건수는 확정 목록 기준
          (미확정이면 숨김 — 합성 수치 금지), recent?tab=wish로 연결한다. */}
      <button className="myshop-menu-row" onClick={onOpenWish}>
        찜{wishCount > 0 && <span className="menu-cnt">{wishCount}</span>}
        <IcChevronRight size={15} className="menu-chevron" />
      </button>

      <div className="myshop-sec-head">
        <h3>주문 목록</h3>
        <button className="link" onClick={onOpenOrders}>
          전체보기
        </button>
      </div>
      {!orders ? (
        <div className="muted sm">불러오는 중…</div>
      ) : !orders.ok ? (
        <div className="muted sm">
          주문 내역을 불러오지 못했어요{" "}
          <button className="link" onClick={() => loadOrders()}>
            다시 시도
          </button>
        </div>
      ) : orders.data.orders.length === 0 ? (
        <div className="myshop-empty muted sm">
          주문 내역이 없어요{" "}
          <button className="link" onClick={onOpenShop}>
            쇼핑하러 가기
          </button>
        </div>
      ) : (
        <div className="hscroll myshop-orders">
          {orders.data.orders.map((o) => {
            const head = cardHead(o);
            const fi = o.first_item;
            return (
              <button
                key={o.id}
                className="mini-order"
                onClick={() => onOpenOrder(o.id)}
              >
                <span className="cart-thumb mini-thumb">
                  {fi && (
                    <img
                      src={productImg({
                        product_id: fi.product_id ?? o.id,
                        image: fi.image,
                      })}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                </span>
                <b className={head.tone === "muted" ? "muted" : ""}>
                  {head.label}
                </b>
                <span className="muted sm">
                  {koShortDate(o.paid_at ?? o.created_at)}
                </span>
                <span className="mini-order-name">
                  {fi?.product_name ?? o.item_summary}
                  {fi && (o.item_count ?? 0) > 1
                    ? " 외 " + ((o.item_count ?? 0) - 1) + "건"
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
