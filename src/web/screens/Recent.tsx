// 최근 본 상품 + 찜 — Ref45의 3탭(장바구니·최근 본·찜)+2열 상품 카드
// [SCREEN_INVENTORY Observed]. 로컬 기록은 productId뿐이고 목록은 항상
// 현재 상품 API 계약으로 렌더한다 — 저장 시점 가격·이미지를 정본으로 쓰지 않는다.
//
// 탭은 route 소유 상태다 [069 MAJOR-1 정정] — initialState로만 읽던 시절은
// 클릭이 URL을 바꾸지 않아 Wish진입→Recent탭→Cart→back이 Wish를 재표시했다.
// 선택 탭과 URL을 항상 일치시키고, 실제 찜 탭(070)도 같은 원칙을 따른다.
//
// 찜 탭(070 실구현): 서버 GET /api/wishlist의 표시 정보(name/image/active/
// min_price)로 렌더한다 — 카탈로그 조회로 조립하면 비활성 보존 항목이
// 조용히 숨겨지므로 서버 목록이 정본이다. 카드는 Ref124 구조(이미지 X
// 삭제 + 항목별 bag) — X는 찜 해제(서버 확정 후 반영), bag은 상품 상세
// 진입으로 매핑한다(옵션 선택 없이 담을 수 없으므로) [Project].
import { useEffect, useState } from "react";
import type { ProductSummary } from "../../contracts.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { fmtWon } from "../api.ts";
import { productImg } from "../display-meta.ts";
import { IcCart } from "../icons.tsx";
import {
  listRecentViews,
  recentPersistence,
  removeRecentView,
} from "../recent-viewed.ts";
import {
  fetchProductsByIds,
  filterLookupRemove,
  type ProductLookup,
} from "../catalog-lookup.ts";
import { createRequestGate } from "../request-gate.ts";
import {
  ensureWishlist,
  recoverWishlistPending,
  refreshWishlist,
  retryWishlistPending,
  toggleWishlist,
  useWishlist,
} from "../wishlist.ts";
import { listWishlistPending, type PendingWrite } from "../pending.ts";

export type RecentTab = "recent" | "wish";

export function Recent({
  userId,
  tab,
  onSelectTab,
  cartCount,
  onOpenCart,
  onOpenProduct,
  onOpenShop,
  commerceEnabled,
  catalogReadOnly,
}: {
  userId: string | null;
  // route 소유 탭 — 클릭은 setState가 아니라 부모의 route 갱신을 부른다.
  tab: RecentTab;
  onSelectTab: (t: RecentTab) => void;
  cartCount: number;
  onOpenCart: () => void;
  onOpenProduct: (id: string) => void;
  onOpenShop: () => void;
  commerceEnabled: boolean;
  catalogReadOnly: boolean;
}) {
  // 기록 id는 호출 시점의 명시 actor로 읽는다 — 전역 scope가 없어 계정 전환/
  // 복원 타이밍에 다른 버킷을 읽을 경로가 없다 [C/069 선제 검수].
  const [ids, setIds] = useState<string[]>(() => listRecentViews(userId));
  const [lookup, setLookup] = useState<ProductLookup | null>(null);
  const [gate] = useState(createRequestGate);
  const [wishBusy, setWishBusy] = useState<string | null>(null);
  const [wishMsg, setWishMsg] = useState<string | null>(null);
  const [pendings, setPendings] = useState<PendingWrite[]>(() => listWishlistPending());
  const persistence = recentPersistence(userId);
  const wish = useWishlist(commerceEnabled ? userId : null);

  async function load() {
    const live = gate.begin();
    const r = await fetchProductsByIds(listRecentViews(userId));
    if (!live()) return;
    setLookup(r);
  }
  useEffect(() => {
    load();
    // unmount/계정 전환 시 이후 응답 적용 차단 [C/069]
    return () => gate.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 찜 탭 진입·계정 확정 시 서버 목록을 적재한다(명시 userId 버킷).
  useEffect(() => {
    if (commerceEnabled && tab === "wish") void ensureWishlist(userId);
  }, [tab, userId, commerceEnabled]);

  // 찜 pending 변경 구독 — 복구 표면 노출용.
  useEffect(() => {
    const on = () => setPendings(listWishlistPending());
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  const found: ProductSummary[] = lookup?.ok ? lookup.found : [];
  const missing = lookup?.ok ? lookup.missing.length : 0;
  const unread = lookup?.ok ? lookup.unread.length : 0;

  // 개별 삭제 — 로컬 기록만 지우고 서버 데이터는 건드리지 않는다 [Project].
  // 카트와 무관한 별개 Action이다(인벤토리 상 최근본 삭제≠카트 삭제).
  const removeId = (id: string) => {
    gate.begin();
    removeRecentView(userId, id);
    const next = listRecentViews(userId);
    setIds(next);
    setLookup((cur) => (cur ? filterLookupRemove(cur, id) : cur));
  };

  const wishItems = [...wish.saved.entries()].map(([product_id, saved_at]) => ({
    product_id,
    saved_at,
    ...(wish.display?.get(product_id) ?? {}),
  }));

  async function unsave(productId: string) {
    setWishBusy(productId);
    setWishMsg(null);
    const r = await toggleWishlist(userId, productId, false);
    setWishBusy(null);
    if (r.kind === "REJECTED") setWishMsg(r.message);
    else if (r.kind === "LOST")
      setWishMsg("찜 해제 결과를 확인할 수 없어요. '결과 확인'으로 확인하세요.");
    else if (r.kind === "PENDING_EXISTS")
      setWishMsg("이전 찜 요청 결과를 먼저 확인해 주세요.");
  }

  async function recoverPending(pw: PendingWrite) {
    setWishBusy(pw.uiKey);
    setWishMsg(null);
    const r = await recoverWishlistPending(userId, pw);
    setWishBusy(null);
    if (r.kind === "DONE") setWishMsg("처리가 완료된 요청이었어요. 목록에 반영했습니다.");
    else if (r.kind === "RETRYABLE")
      setWishMsg("요청 기록이 없어요. '다시 시도'로 같은 요청을 재시도할 수 있어요.");
    else if (r.kind === "REJECTED") setWishMsg(r.message);
    else if (r.kind === "UNKNOWN_KEEP")
      setWishMsg("아직 결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
  }

  async function retryPending(pw: PendingWrite) {
    setWishBusy(pw.uiKey);
    setWishMsg(null);
    const r = await retryWishlistPending(userId, pw);
    setWishBusy(null);
    if (r.kind === "DONE") setWishMsg("찜에 반영했어요.");
    else if (r.kind === "LOST")
      setWishMsg("아직 결과를 확인할 수 없어요. '결과 확인'으로 이어서 확인하세요.");
    else if (r.kind === "REJECTED") setWishMsg(r.message);
    else if (r.kind === "BUSY") setWishMsg("같은 상품의 요청이 진행 중이에요.");
  }

  return (
    <div className="screen">
      {/* Ref45 상단 3탭 — '최근 본' 라벨 [Observed]. 장바구니는 별도 화면 진입,
          최근 본/찜 전환은 route 소유 상태로 URL과 일치시킨다 */}
      <div className="cart-tabs" role="tablist">
        {(
          <button role="tab" aria-selected="false" onClick={onOpenCart}>
            장바구니 {cartCount}
          </button>
        )}
        <button
          role="tab"
          className={tab === "recent" ? "on" : ""}
          aria-selected={tab === "recent"}
          onClick={() => onSelectTab("recent")}
        >
          최근 본
        </button>
        {(
          <button
            role="tab"
            className={tab === "wish" ? "on" : ""}
            aria-selected={tab === "wish"}
            onClick={() => onSelectTab("wish")}
          >
            찜
          </button>
        )}
      </div>

      {tab === "wish" && !commerceEnabled ? (
        <div className="state-box" role="status">
          {catalogReadOnly
            ? "읽기 전용 시연에서는 찜을 사용할 수 없어요."
            : "쇼핑 기능을 확인하고 있어요."}
          <button className="btn primary" onClick={onOpenShop}>쇼핑 홈</button>
        </div>
      ) : tab === "wish" ? (
        <>
          {/* 미해결 intent 복구는 목록 GET 실패 상태에서도 접근 가능해야 한다 [PM070] */}
          {pendings.length > 0 && (
              <div className="state-box">
                <b>찜 요청 결과를 확인하지 못했어요</b>
                <p className="muted">
                  {pendings[0].label} — 같은 요청이 중복으로 들어가지 않게
                  잠겨 있어요.
                </p>
                <div className="sheet-actions">
                  <button
                    className="btn ghost"
                    disabled={wishBusy === pendings[0].uiKey}
                    onClick={() => void recoverPending(pendings[0])}
                  >
                    결과 확인
                  </button>
                  <button
                    className="btn primary"
                    disabled={wishBusy === pendings[0].uiKey}
                    onClick={() => void retryPending(pendings[0])}
                  >
                    다시 시도
                  </button>
                </div>
              </div>
            )}
          {wishMsg && <div className="muted sm recent-note">{wishMsg}</div>}
          {wish.status === "idle" || wish.status === "loading" ? (
            <Loading text="찜 목록을 불러오는 중…" />
          ) : wish.status === "error" ? (
            <ErrorState
              text="찜 목록을 불러오지 못했어요"
              onRetry={() => void refreshWishlist(userId)}
            />
          ) : wishItems.length === 0 && pendings.length === 0 ? (
              <Empty
                text="찜한 상품이 없어요"
                action={
                  <button className="btn primary" onClick={onOpenShop}>
                    쇼핑하러 가기
                  </button>
                }
              />
            ) : (
              <div className="product-grid">
                {wishItems.map((it) => (
                  <div key={it.product_id} className="wish-cell">
                    {/* Ref124 — 카드 본문은 상세 진입, 이미지 위 X는 찜 해제,
                        항목별 bag 아이콘도 상세 진입(옵션 선택이 필요해 즉시
                        담기는 지원하지 않는다) [Project 매핑] */}
                    <button
                      className="wish-item"
                      onClick={() => onOpenProduct(it.product_id)}
                    >
                      <span className="wish-thumb">
                        <img
                          src={productImg({
                            product_id: it.product_id,
                            image: it.image ?? null,
                          })}
                          alt={it.name ?? ""}
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                        {it.active === false && (
                          <span className="wish-inactive">판매 중단</span>
                        )}
                      </span>
                      <span className="wish-info">
                        <span className="product-name">{it.name}</span>
                        {it.min_price_won != null && (
                          <span className="product-price">
                            {fmtWon(it.min_price_won)}
                          </span>
                        )}
                      </span>
                    </button>
                    {/* X/bag는 이미지(aspect-ratio 1) 영역만 덮는 overlay 박스 —
                        셀 전체 기준 bottom이면 bag이 상품명·가격을 가린다
                        [PM070 Ref124 재검수]. 형제 버튼이라 nested button 없음 */}
                    <div className="wish-visual">
                      <button
                        className="wish-x"
                        aria-label={(it.name ?? it.product_id) + " 찜 해제"}
                        disabled={wishBusy === it.product_id || wish.busy.has(it.product_id)}
                        onClick={() => void unsave(it.product_id)}
                      >
                        ×
                      </button>
                      <button
                        className="wish-bag"
                        aria-label={(it.name ?? it.product_id) + " 상품 보기"}
                        onClick={() => onOpenProduct(it.product_id)}
                      >
                        <IcCart size={19} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      ) : !lookup ? (
        <Loading text="최근 본 상품을 불러오는 중…" />
      ) : !lookup.ok ? (
        <ErrorState text="상품 정보를 불러오지 못했어요" onRetry={() => load()} />
      ) : ids.length === 0 ? (
        <Empty
          text="최근 본 상품이 없어요"
          action={
            <button className="btn primary" onClick={onOpenShop}>
              쇼핑하러 가기
            </button>
          }
        />
      ) : (
        <>
          {persistence !== "local" && (
            <div className="muted sm recent-note">
              이 브라우저에서는 새로고침 후 목록이 사라질 수 있어요
            </div>
          )}
          {missing > 0 && (
            <div className="muted sm recent-note">
              판매 중단 등으로 확인할 수 없는 상품 {missing}개는 표시하지 않아요
            </div>
          )}
          {unread > 0 && (
            <div className="muted sm recent-note">
              {unread}개 상품을 아직 불러오지 못했어요{" "}
              <button className="link" onClick={() => load()}>
                다시 시도
              </button>
            </div>
          )}
          <div className="product-grid">
            {found.map((p) => (
              <div key={p.product_id} className="recent-cell">
                <ProductCard
                  p={p}
                  onOpen={() => onOpenProduct(p.product_id)}
                />
                <button
                  className="recent-x"
                  aria-label={p.name + " 최근 본 상품에서 삭제"}
                  onClick={() => removeId(p.product_id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
