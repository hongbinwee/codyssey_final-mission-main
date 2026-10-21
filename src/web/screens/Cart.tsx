// W03 장바구니 (Phase 2+: 수량 변경/삭제/실패 복구 → 주문 진입).
// 쓰기 요청은 idempotency_key를 단다. intent는 전송 전 pending 저장소에 보존하고
// 확정 결과에서만 해제한다 — 응답 유실(AMBIGUOUS)이면 같은 키로 결과 조회하고,
// 확정 거절(VERSION_CONFLICT 등)이면 자동 재실행 없이 최신 상태 재확인을 요구한다.
// 미확정 intent가 하나라도 있으면 수량·삭제·주문 버튼을 잠근다.
import { useEffect, useRef, useState } from "react";
import { stockSafeErrorMessage } from "../commerce-ui.ts";
import {
  apiSafe, fmtWon, newActionKey, AMBIGUOUS_CODES, type ApiResult,
} from "../api.ts";
import type { CartItemView, CartView } from "../../contracts.ts";
import { ErrorState, Loading } from "../components/CommerceState.tsx";
import { PRODUCT_META, productImg } from "../display-meta.ts";
import { IcBagFill, IcChevronDown, IcClose } from "../icons.tsx";
import {
  listCartPending, putPending, removePending, lookupAction,
  type PendingWrite,
} from "../pending.ts";
import { createReadGate, guardedRead } from "../read-gate.ts";

export function Cart({
  cart,
  onCartLoaded,
  onCheckout,
  onOpenProduct,
  onOpenRecent,
  onOpenWish,
  commerceEnabled,
  catalogReadOnly,
  checkoutEnabled = commerceEnabled,
  onOpenShop,
}: {
  cart: CartView | null;
  onCartLoaded: (v: CartView) => void;
  // null = 전체 선택(legacy 전체 카트 견적), 배열 = 선택 cart_item_id 부분 주문
  // [PMQA-067 — Ref073 부분선택 → 주문서].
  onCheckout: (selectedIds: string[] | null) => void;
  onOpenProduct: (id: string) => void;
  onOpenRecent: () => void;
  onOpenWish: () => void;
  commerceEnabled: boolean;
  catalogReadOnly: boolean;
  checkoutEnabled?: boolean;
  onOpenShop: () => void;
}) {
  const [res, setRes] = useState<ApiResult<CartView> | null>(
    cart ? { ok: true, data: cart } : null,
  );
  const [loading, setLoading] = useState(!cart);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendings, setPendings] = useState<PendingWrite[]>(() => listCartPending());
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(cart?.items.map((i) => i.cart_item_id) ?? []),
  );
  const busyRef = useRef(false); // 동기 중복 쓰기 차단 (state 반영 전 이중 클릭)
  const knownIds = useRef(cart?.items.map((i) => i.cart_item_id) ?? []);
  // 마운트 GET이 늦게 도착해 그 사이 확정된 쓰기(v2)를 과거(v1)로 덮는 레이스 방지.
  // 쓰기가 새 상태를 적용할 때 seq를 올려 진행 중인 read를 무효화한다.
  // [MAJOR069-07 해소] 여기에 언마운트 무효화(kill)를 더한다 — 상세 이동 후
  // 돌아온 구 GET이 부모 카트를 과거 snapshot으로 덮지 못한다 [PMQA-072].
  const readGate = useRef(createReadGate());
  // 결제 예상 금액 패널 — Ref126은 펼침이 기본 노출 상태다 [Observed cart/126].
  // 접기·펼치기는 표시 상태만 바꾼다 — 카트 쓰기나 선택을 변경하지 않는다.
  const [quoteOpen, setQuoteOpen] = useState(true);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  // 고정 하단 패널의 실측 높이만큼 문서 끝 여백을 보장한다 — 펼침·부분선택
  // 안내·pending으로 패널이 커져도 마지막 카드/수량/CTA가 영구 가려지지 않는다.
  useEffect(() => {
    const bar = barRef.current;
    const screen = screenRef.current;
    if (!bar || !screen || typeof ResizeObserver === "undefined") return;
    const apply = () =>
      screen.style.setProperty("--bb-h", bar.offsetHeight + "px");
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  });

  useEffect(() => {
    const on = () => setPendings(listCartPending());
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  // 모든 카트 조회(마운트·재시도·쓰기 후 재확인)는 guardedRead 한 경로다 —
  // 세대 무효화(새 조회·확정 쓰기)와 언마운트 kill()이 적용(setRes·onCartLoaded)을
  // 함께 차단한다 [PMQA-072].
  // 적용 권한이 loading 해제 책임을 인계한다 — 실제로 적용되는 최신 응답만
  // setLoading을 건드리고, stale·kill 응답은 적용 권한이 없어 loading도 건드리지
  // 못한다 [PMQA-072 REWORK — MAJOR072-01].
  async function reload() {
    return guardedRead(
      readGate.current,
      () => apiSafe<CartView>("/api/cart"),
      (r) => {
        setRes(r);
        if (r.ok) onCartLoaded(r.data);
        setLoading(false); // 적용된 최신 응답이 loading 종료를 인계한다 [MAJOR072-01]
      },
    );
  }
  useEffect(() => {
    if (!commerceEnabled) return;
    const g = readGate.current;
    reload(); // 적용되는 최신 응답이 loading을 해제한다 — gen은 내부 배정
    return () => g.kill(); // 언마운트 — 진행 중 조회의 적용을 차단한다 [MAJOR069-07]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commerceEnabled]);

  // 선택은 카트 항목 id에 고정한다. 새 항목은 선택 상태로 들어오고,
  // 삭제된 항목은 선택 집합에서도 제거한다.
  useEffect(() => {
    if (!res?.ok) return;
    const ids = res.data.items.map((i) => i.cart_item_id);
    setSelected((prev) => {
      const next = new Set(ids.filter((id) => prev.has(id)));
      for (const id of ids)
        if (!knownIds.current.includes(id)) next.add(id);
      knownIds.current = ids;
      return next;
    });
  }, [res]);

  const locked = busy || pendings.length > 0;

  // 쓰기 공통: intent를 전송 전 보존 → 전송 → 확정 결과에서만 해제.
  async function runWrite(
    item: CartItemView,
    kind: "UPDATE_CART" | "REMOVE_CART",
    payload: Record<string, unknown>,
    label: string,
  ): Promise<
    | { status: "ok"; cart: CartView }
    | { status: "stale" }
    | { status: "ambiguous" }
    | { status: "rejected" }
  > {
    const pw: PendingWrite = {
      uiKey: payload.idempotency_key as string,
      kind,
      path: "/api/cart/items/" + item.cart_item_id,
      method: kind === "UPDATE_CART" ? "PATCH" : "DELETE",
      payload,
      label,
      at: Date.now(),
    };
    putPending(pw); // 서버 commit 후 응답 유실·탭 종료 대비 — 전송 전 보존
    const r = await apiSafe<{ cart: CartView }>(pw.path, {
      method: pw.method,
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      removePending(pw.uiKey);
      // replay(저장 snapshot)면 최신 카트를 회수 — 그 사이 다른 변경이 섞일 수 있다.
      if (r.replayed) {
        const latest = await reload();
        if (!latest?.ok) {
          setNotice("이미 처리된 요청이지만 최신 장바구니를 불러오지 못했어요.");
          return { status: "stale" };
        }
        setNotice("이미 처리된 요청을 최신 장바구니에 반영했어요.");
        return { status: "ok", cart: latest.data };
      }
      readGate.current.invalidate(); // 진행 중이던 read보다 이 쓰기 결과가 최신이다
      const v = { ok: true as const, data: r.data.cart };
      setRes(v);
      onCartLoaded(r.data.cart);
      setLoading(false); // 살아있는 화면에 확정 쓰기가 적용되면 진행 중 loading 종료 [MAJOR072-01]
      setNotice(null);
      return { status: "ok", cart: r.data.cart };
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setNotice("결과를 확인하지 못했어요. '결과 확인'으로 이어서 확인할 수 있어요.");
      return { status: "ambiguous" }; // pending 유지 → 복구 UI
    }
    removePending(pw.uiKey);
    if (r.error.code === "VERSION_CONFLICT") {
      setNotice("카트가 변경되었어요. 최신 상태로 다시 불러왔습니다.");
      await reload();
      return { status: "rejected" };
    }
    // VERSION_CONFLICT 외 확정 거절(OUT_OF_STOCK·UNAVAILABLE·NOT_FOUND)도
    // 최신 CartView를 회수한다 — 재고/판매 상태가 바뀐 거절에서 stale
    // can_checkout·수량 버튼이 남지 않도록(retryPending과 동일 기준).
    setNotice("변경 실패: " + stockSafeErrorMessage(r.error.code, r.error.message));
    await reload();
    return { status: "rejected" };
  }

  async function changeQty(item: CartItemView, quantity: number) {
    if (locked || busyRef.current || !res?.ok) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const key = newActionKey();
    await runWrite(
      item,
      "UPDATE_CART",
      {
        quantity,
        expected_cart_version: res.data.version,
        expected_variant_version: item.variant_version,
        idempotency_key: key,
      },
      item.product_name + " 수량 " + quantity + "개",
    );
    setBusy(false);
    busyRef.current = false;
  }

  async function removeItem(item: CartItemView) {
    if (locked || busyRef.current || !res?.ok) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const key = newActionKey();
    await runWrite(
      item,
      "REMOVE_CART",
      {
        expected_cart_version: res.data.version,
        idempotency_key: key,
      },
      item.product_name + " 삭제",
    );
    setBusy(false);
    busyRef.current = false;
  }

  async function removeSelected() {
    if (locked || busyRef.current || !res?.ok) return;
    const ids = res.data.items
      .filter((item) => selected.has(item.cart_item_id))
      .map((item) => item.cart_item_id);
    if (!ids.length) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    let latest = res.data;
    let removed = 0;
    let stopped: "stale" | "ambiguous" | "rejected" | null = null;
    for (const id of ids) {
      const item = latest.items.find((x) => x.cart_item_id === id);
      if (!item) continue;
      const result = await runWrite(
        item,
        "REMOVE_CART",
        {
          expected_cart_version: latest.version,
          idempotency_key: newActionKey(),
        },
        item.product_name + " 삭제",
      );
      if (result.status !== "ok") {
        stopped = result.status;
        break;
      }
      latest = result.cart;
      removed += 1;
    }
    if (removed === ids.length) {
      setNotice("선택한 상품 " + removed + "개를 삭제했어요.");
    } else if (removed > 0 && stopped) {
      const reason = stopped === "ambiguous"
        ? "다음 상품의 결과 확인이 필요해요."
        : stopped === "stale"
          ? "최신 장바구니 확인에 실패해 멈췄어요. 다시 불러와 주세요."
          : "다음 상품 삭제가 거절돼 멈췄어요. 최신 상태를 확인해 주세요.";
      setNotice("앞의 " + removed + "개 삭제 완료. " + reason);
    }
    busyRef.current = false;
    setBusy(false);
  }

  // 미확정 intent의 서버 기록을 조회한다. SUCCEEDED라도 카트 본문은
  // historical snapshot일 수 있으므로 항상 GET으로 재동기화한다.
  async function checkPending(p: PendingWrite) {
    const r = await lookupAction(p);
    if (!r.ok) {
      if (r.error.code === "NOT_FOUND") {
        // 서버에 기록이 없음 — 같은 키/페이로드로만 명시 재시도.
        setNotice(
          "요청 기록이 없어요. '다시 시도'로 같은 요청을 재전송할 수 있어요.",
        );
        return;
      }
      setNotice("결과를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    const st = r.data.status;
    if (st === "SUCCEEDED") {
      removePending(p.uiKey);
      const c = await reload();
      setNotice(
        c.ok
          ? "처리가 완료된 요청이었어요. 최신 상태로 반영했습니다."
          : "처리는 완료된 요청이었어요. 최신 카트를 불러오지 못했어요 — 다시 시도해 주세요.",
      );
      return;
    }
    if (st === "REJECTED") {
      removePending(p.uiKey);
      setNotice("요청이 거절되었어요. 최신 상태를 확인해 주세요.");
      await reload();
      return;
    }
    if (st === "READY") {
      setNotice("아직 처리 중이에요. 잠시 후 다시 확인해 주세요.");
      return;
    }
    // 서버 status는 READY|SUCCEEDED|REJECTED — 예상치 못한 값이면
    // intent를 유지한 채 다음 확인에 맡긴다.
    setNotice("결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
  }

  async function retryPending(p: PendingWrite) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const r = await apiSafe<{ cart: CartView }>(p.path, {
      method: p.method,
      body: JSON.stringify(p.payload),
    });
    setBusy(false);
    busyRef.current = false;
    if (r.ok) {
      removePending(p.uiKey);
      // 명시 재시도는 대부분 replay — 저장 snapshot 대신 최신 카트를 회수해 표시.
      const c = await reload();
      setNotice(
        c.ok
          ? "요청이 반영됐어요."
          : "요청은 반영됐어요. 최신 카트를 불러오지 못했어요 — 다시 시도해 주세요.",
      );
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setNotice("아직 결과를 확인할 수 없어요. '결과 확인'으로 이어서 확인하세요.");
      return;
    }
    removePending(p.uiKey);
    if (r.error.code === "VERSION_CONFLICT") {
      setNotice("카트가 변경되었어요. 최신 상태로 다시 불러왔습니다.");
      await reload();
      return;
    }
    setNotice("변경 실패: " + stockSafeErrorMessage(r.error.code, r.error.message));
    await reload();
  }

  if (!commerceEnabled)
    return (
      <div className="screen">
        <div className="state-box" role="status">
          {catalogReadOnly
            ? "읽기 전용 시연에서는 장바구니를 사용할 수 없어요."
            : "쇼핑 기능을 확인하고 있어요."}
        </div>
        <button className="btn primary" onClick={onOpenShop}>쇼핑 홈</button>
      </div>
    );
  if (loading) return <Loading />;
  if (!res) return null;
  if (!res.ok)
    return (
      <>
        {notice && <div className="state-box" role="status">{notice}</div>}
        <ErrorState
          text="카트를 불러오지 못했어요"
          onRetry={() => {
            setLoading(true);
            reload(); // 적용되는 최신 응답이 loading을 해제 — stale gen은 권한 없음
          }}
        />
      </>
    );
  const c = res.data;
  const allSelected = c.items.length > 0 && c.items.every((i) => selected.has(i.cart_item_id));
  const someSelected = c.items.some((i) => selected.has(i.cart_item_id));
  const selectedCount = c.items.filter((i) => selected.has(i.cart_item_id)).length;
  const selectedItemsTotal = c.items
    .filter((i) => selected.has(i.cart_item_id))
    .reduce((sum, item) => sum + item.unit_price_won * item.quantity, 0);
  // 선택 부분집합 기준 주문 가능 여부 — 미선택 항목은 주문 대상이 아니다.
  // 배송비는 서버와 같은 규칙(선택 상품이 있으면 FLAT)으로만 추정한다 —
  // 실제 금액은 서버 견적이 확정한다.
  const selectedPurchasable = c.items
    .filter((i) => selected.has(i.cart_item_id))
    .every((i) => i.purchasable);
  const selectedShipping = selectedCount > 0 ? c.shipping_fee_won : 0;
  const selectedTotal = selectedItemsTotal + selectedShipping;
  const canSubmit = someSelected && selectedPurchasable && !locked;

  return (
    <div className="screen cart-screen" ref={screenRef}>
      {notice && <div className="state-box">{notice}</div>}
      {pendings.length > 0 && (
        <div className="state-box">
          <b>결과를 확인하지 못한 요청이 있어요</b>
          <ul className="pending-list">
            {pendings.map((p) => (
              <li key={p.uiKey}>
                <span className="pending-label">{p.label}</span>
                <span className="pending-actions">
                  <button className="link" onClick={() => checkPending(p)}>
                    결과 확인
                  </button>
                  <button
                    className="link"
                    disabled={busy}
                    onClick={() => retryPending(p)}
                  >
                    다시 시도
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className="muted sm">
            결과가 확정되기 전에는 수량·삭제·주문을 변경할 수 없어요.
          </div>
        </div>
      )}
      {/* Ref45 공유 3탭 — 장바구니(count)/최근 본/찜. 찜은 SET_WISHLIST
          실구현(recent?tab=wish)으로 연결한다 [PMQA-070] */}
      <div className="cart-tabs" role="tablist" aria-label="장바구니 메뉴">
        <button role="tab" className="on" aria-current="page" aria-selected="true">
          장바구니 {c.items.length}
        </button>
        <button role="tab" aria-selected="false" onClick={onOpenRecent}>
          최근 본
        </button>
        <button role="tab" aria-selected="false" onClick={onOpenWish}>
          찜
        </button>
      </div>
      {c.items.length === 0 ? (
        // Ref099 — 카드 없는 열린 빈 상태: muted 아이콘 + 굵은 제목 + 보조 문구.
        // 별도 CTA 버튼은 두지 않는다 [Observed]. '가장 싸게' 같은 실데이터 없는
        // 주장 문구는 쓰지 않는다 [PMQA-075 F24].
        <div className="cart-empty">
          <IcBagFill size={38} className="cart-empty-ic" />
          <div className="cart-empty-title">장바구니가 비었어요</div>
          <div className="cart-empty-sub">마음에 드는 상품을 담아보세요</div>
        </div>
      ) : (
        <>
          <div className="cart-selection">
            <label className="select-all">
              <input
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                type="checkbox"
                checked={allSelected}
                aria-label="전체 선택"
                disabled={locked}
                onChange={(e) => {
                  setSelected(e.target.checked
                    ? new Set(c.items.map((i) => i.cart_item_id))
                    : new Set());
                }}
              />
              <span>전체선택 ({c.items.length}건)</span>
            </label>
            <button
              className="link select-delete"
              aria-label="선택 항목 제거"
              disabled={!someSelected || locked}
              onClick={removeSelected}
            >
              선택삭제
            </button>
          </div>
          <ul className="cart-list">
            {c.items.map((i) => (
              <li key={i.cart_item_id} className="cart-item">
                <div className="cart-item-head">
                  <label className="cart-select">
                    <input
                      type="checkbox"
                      checked={selected.has(i.cart_item_id)}
                      aria-label={i.product_name + " 선택"}
                      disabled={locked}
                      onChange={(e) => setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i.cart_item_id);
                        else next.delete(i.cart_item_id);
                        return next;
                      })}
                    />
                  </label>
                  <button
                    className="cart-name"
                    onClick={() => onOpenProduct(i.product_id)}
                  >
                    {i.product_name}
                  </button>
                  <button
                    className="cart-remove"
                    aria-label="삭제"
                    title="상품 삭제"
                    disabled={locked}
                    onClick={() => removeItem(i)}
                  >
                    <IcClose size={16} />
                  </button>
                </div>
                <div className="cart-item-body">
                  <button
                    className="cart-thumb"
                    aria-label={i.product_name + " 상품 상세"}
                    onClick={() => onOpenProduct(i.product_id)}
                  >
                    <img
                      src={productImg({ product_id: i.product_id, image: i.image })}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </button>
                  <div className="cart-info">
                    <div className="cart-price-line">
                      {(() => {
                        const original = PRODUCT_META[i.product_id]?.original_price_won;
                        const rate = original && original > i.unit_price_won
                          ? Math.round((original - i.unit_price_won) / original * 100)
                          : 0;
                        return rate > 0 && <span className="cart-price-rate">{rate}%</span>;
                      })()}
                      <b>{fmtWon(i.unit_price_won)}</b>
                    </div>
                    <div className="muted cart-option">
                      {Object.values(i.option_values).join(" · ")}
                    </div>
                    {PRODUCT_META[i.product_id]?.delivery && (
                      <div className="cart-delivery muted">
                        배송 안내 · {PRODUCT_META[i.product_id].delivery} <small>데모</small>
                      </div>
                    )}
                  {!i.purchasable && (
                    <div className="badge-soldout">
                      {i.block_reason} — 주문할 수 없어요
                    </div>
                  )}
                  <div className="qty-ctrl sm">
                    <button
                      aria-label={"수량 감소 " + i.cart_item_id}
                      disabled={locked || i.quantity <= 1}
                      onClick={() => changeQty(i, i.quantity - 1)}
                    >
                      −
                    </button>
                    <b>{i.quantity}</b>
                    <button
                      aria-label={"수량 증가 " + i.cart_item_id}
                      disabled={locked || !i.purchasable}
                      onClick={() => changeQty(i, i.quantity + 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="bottom-bar" ref={barRef}>
            <div className="cart-summary">
              <button
                type="button"
                className="cart-summary-total cart-quote-toggle"
                aria-expanded={quoteOpen}
                aria-controls="cart-quote-rows"
                aria-label={
                  quoteOpen
                    ? "결제 예상 금액 상세 접기"
                    : "결제 예상 금액 상세 펼치기"
                }
                onClick={() => setQuoteOpen((v) => !v)}
              >
                <span className="cart-quote-label">
                  선택 {selectedCount}건 결제 예상 금액
                </span>
                <span className="cart-quote-amount">
                  <b>{fmtWon(selectedTotal)}</b>
                  <IcChevronDown size={15} />
                </span>
              </button>
              <div
                id="cart-quote-rows"
                className="cart-quote-rows"
                hidden={!quoteOpen}
              >
                <div className="cart-quote-row">
                  <span className="muted">상품 금액</span>
                  <span>{fmtWon(selectedItemsTotal)}</span>
                </div>
                <div className="cart-quote-row">
                  <span className="muted">배송비</span>
                  <span>{fmtWon(selectedShipping)}</span>
                </div>
              </div>
            </div>
            <div className="cart-checkout-action">
              {!checkoutEnabled && <div className="muted sm" role="note">시연 상품 · 장바구니 저장만 가능하며 주문·결제는 지원하지 않아요</div>}
              {selectedCount === 0 && pendings.length === 0 && (
                <div className="muted sm">주문할 상품을 선택해 주세요</div>
              )}
              {selectedCount > 0 && !selectedPurchasable && pendings.length === 0 && (
                <div className="muted sm">선택한 상품 중 주문할 수 없는 항목이 있어요</div>
              )}
              {pendings.length > 0 && (
                <div className="muted sm">이전 요청 결과를 먼저 확인해 주세요</div>
              )}
              <button
                className="btn primary"
                aria-label={selectedCount + "건 · " + fmtWon(selectedTotal) + " 주문하기"}
                disabled={!checkoutEnabled || !canSubmit}
                onClick={() =>
                  onCheckout(
                    allSelected
                      ? null
                      : [...selected].filter((id) =>
                          c.items.some((i) => i.cart_item_id === id),
                        ),
                  )
                }
              >
                {selectedCount}건 · {fmtWon(selectedTotal)} 주문하기
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 카트 뷰에는 stock이 없으므로 +버튼은 구매 가능 여부만 힌트로 쓴다.
// 실제 재고 초과는 서버가 OUT_OF_STOCK으로 막는다.
