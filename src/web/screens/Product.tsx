// W02 상품 상세·옵션·리뷰 — COMMERCE_UI_SPEC §7-1.
// - 진입 시 구매 가능한 첫 옵션을 자동 선택(품절 제외), 전품절만 CTA disabled/품절.
//   read 실패→재시도 성공 시에도 동일한 초기화 규칙을 적용한다.
// - 옵션 변경은 공용 BottomSheet, 조합/수량/금액 즉시 동기화.
// - 담기는 서버 재검증(expected cart/variant version + idempotency).
//   intent는 전송 전 pending 저장소에 보존하고, 응답 유실(AMBIGUOUS)은
//   결과 조회/명시 재시도로 복구한다 — 같은 actor의 미확정 cart write가
//   하나라도 있으면 새 담기·옵션·수량 변경을 잠그고 카트 복구로 안내한다.
// - 리뷰는 실제 cursor 페이지네이션(total_matching은 실제 행 수).
//
// 05 FIDELITY 보정 — Reference product-detail/04·05·20 기준 구조 [Observed]:
// - 상단 내비는 별도 backbar가 아니라 hero 위 플로팅 아이콘(← · 검색 · 카트+배지).
//   hero를 거의 지나 스크롤되면 읽기용 solid 바로 전환한다.
// - 정보 계층: 이름 → 브랜드·설명 → 할인율+정가 → 판매가 → 평점·리뷰 진입 행 → 배송 행.
//   배송 행은 Ref093 '배송정보' BottomSheet를 연다 — 실제 지원 데이터(서버
//   배송비, 부재·비정상은 '정보 없음' 구분)만 표시하고 ETA/택배사/개인
//   주소·발송 시점 데모 라벨은 배송 조건으로 확장하지 않는다(gap 명시).
//   평점은 /api/products 목록에서 product_id 정확 매칭으로만 결정 — 요청 실패/미매칭은
//   별도 안내와 재시도를 제공하며 '아직 리뷰 없어요'로 오인시키지 않는다. 리뷰 수와
//   정확히 일치하는 요약만 사용하고 부분 로드 평균은 만들지 않는다.
// - 본문 하단은 [리뷰 (n개) | 상품 정보] sticky 탭. 정렬 UI는 없다 —
//   서버 getReviews는 최신순만 지원하므로 추천순을 흉내내지 않는다.
// - 리뷰 행은 카드 대신 flat row + divider — variant id가 아니라 옵션 라벨로 표시.
// - 하단 바는 Ref04 구조 [카트 아이콘][N원 담기(보조)][구매하기(주 CTA)] —
//   옵션 진입은 본문 .optline 행이 담당하고 하단 바에 별도 옵션 버튼을 두지
//   않는다. 찜은 공용 WishButton의 서버 저장 계약을 재사용하고 뽑기는 제공하지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiSafe, fmtWon, newActionKey, shipFeeLabel, AMBIGUOUS_CODES, type ApiResult } from "../api.ts";
import type {
  CartView, MatchedVariant, ProductDetail, ProductSummary, ReviewsResult,
} from "../../contracts.ts";
import { CatalogNotice, Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { ReviewRow, Stars } from "../components/ReviewBits.tsx";
import { PRODUCT_META, SPEC_LABEL, productImg } from "../display-meta.ts";
import { stockSafeErrorMessage, variantStockLabel } from "../commerce-ui.ts";
import {
  listCartPending, putPending, removePending, lookupAction,
  type PendingWrite,
} from "../pending.ts";
import { IcBack, IcCart, IcChevronRight, IcSearch, IcStar } from "../icons.tsx";
import { WishButton } from "../components/WishButton.tsx";

import {
  resolveDetailResume,
  resolveInitialVariant,
  saveDetailResume,
  takeDetailResumeIfFresh,
} from "../detail-resume.ts";
import { recordRecentView } from "../recent-viewed.ts";
import { createReviewPager } from "../review-pager.ts";
import { fetchProductsByIds } from "../catalog-lookup.ts";

type RatingLoad =
  | { state: "loading" }
  | { state: "error" }
  | { state: "unmatched" }
  | { state: "loaded"; summary: ProductSummary };

export function Product({
  productId,
  initialVariantId,
  userId,
  onBack,
  onOpenSearch,
  onOpenCart,
  onOpenReviews,
  onCartChanged,
  cartCount,
  onBuyNow,
  onOpenWish,
  commerceEnabled,
  checkoutEnabled = commerceEnabled,
}: {
  productId: string;
  initialVariantId?: string;
  userId: string | null;
  onBack: () => void;
  onOpenSearch: () => void;
  onOpenCart: () => void;
  onOpenReviews: () => void;
  onCartChanged: (v: CartView) => void;
  cartCount: number;
  // PMQA-067 바로 구매 — 현재 선택 옵션·수량으로 카트를 거치지 않는
  // DIRECT 견적 주문서로 이동한다. 담기와 별개 동작이다.
  onBuyNow: (target: { variant_id: string; quantity: number }) => void;
  // 찜 진입 — Ref08 하단 하트 CTA와 저장 시트의 '바로가기' 목적지 [PMQA-070].
  onOpenWish: () => void;
  commerceEnabled: boolean;
  checkoutEnabled?: boolean;
}) {
  const [detail, setDetail] = useState<ApiResult<ProductDetail> | null>(null);
  const [reviews, setReviews] = useState<ApiResult<ReviewsResult> | null>(null);
  // 목록 API의 rating_summary — product_id 정확 매칭만 사용한다.
  const [summary, setSummary] = useState<RatingLoad>({ state: "loading" });
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shipOpen, setShipOpen] = useState(false);
  const [tab, setTab] = useState<"reviews" | "info">("reviews");
  const [navSolid, setNavSolid] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [addedOk, setAddedOk] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [pendings, setPendings] = useState<PendingWrite[]>(() => listCartPending());
  const [imgIdx, setImgIdx] = useState(0);
  const seq = useRef(0);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const viewerStripRef = useRef<HTMLDivElement | null>(null);
  // double-click 같은 동기 중복 호출 차단 — state 반영 전 두 번째 호출을 막는다.
  const busyRef = useRef(false);
  // F07 복귀 스냅샷의 스크롤 복원 대기값과 1회 적용 플래그.
  const pendingScrollY = useRef<number | null>(null);
  const resumeDone = useRef(false);
  // 리뷰 로드는 detail/summary와 다른 세대 — 패널 재시도가 진행 중인 평점
  // 로드를 무효화하지 않게 분리한다. 더보기 pager도 이 세대를 따른다.
  const revSeq = useRef(0);
  const reviewsRef = useRef<ApiResult<ReviewsResult> | null>(null);
  reviewsRef.current = reviews;
  const pagerRef = useRef<ReturnType<typeof createReviewPager> | null>(null);

  // pending 저장소 변경을 구독 — 같은 actor의 미확정 cart write를 전역 잠금에 쓴다.
  useEffect(() => {
    const on = () => setPendings(listCartPending());
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  const pickDefault = (d: ProductDetail) => resolveInitialVariant(d.variants).variantId;

  // 초기 로드: detail+reviews. 재시도도 같은 경로를 타야 초기화 규칙이 동일하다.
  const loadInitial = useCallback(
    async (pid: string, my: number) => {
      const r = await apiSafe<ProductDetail>("/api/products/" + pid);
      if (seq.current !== my) return;
      setDetail(r);
      if (!r.ok) return;
      // F09 — 상세 '성공' 조회만 기록한다. 실패·stale 세대(위 가드)는 제외하고,
      // 기록 대상은 서버 canonical id·명시 actor다 [C/069 Ref45].
      recordRecentView(userId, r.data.product.id);
      // F07 복귀 스냅샷 — 같은 계정·같은 상품에서만 적용하고 1회 소비한다.
      // stale 세대면 스냅샷을 소비하지 않는다(isStale 가드, Luna 지적).
      // 복원 불가·수량 감소는 조용히 교체하지 않고 안내한다.
      const plan = resolveDetailResume(
        r.data.variants,
        takeDetailResumeIfFresh(() => seq.current !== my, pid),
        userId,
      );
      if (plan.apply) {
        setVariantId(plan.variantId ?? pickDefault(r.data));
        setQty(plan.qty);
        pendingScrollY.current = plan.scrollY;
        if (plan.notice === "OPTION_UNAVAILABLE")
          setFeedback(
            "이전에 고른 옵션은 지금 구매할 수 없어요. 옵션을 다시 확인해 주세요.",
          );
        else if (plan.notice === "QTY_REDUCED")
          setFeedback("선택한 수량이 현재 재고에 맞춰 조정됐어요.");
      } else {
        const initial = resolveInitialVariant(r.data.variants, initialVariantId);
        setVariantId(initial.variantId);
        setQty(1);
        if (initial.unavailable)
          setFeedback("선택한 옵션은 지금 구매할 수 없어요. 옵션을 다시 선택해 주세요.");
      }
    },
    [userId, initialVariantId],
  );
  const loadReviews = useCallback(async (pid: string, my: number, limit = 4) => {
    const r = await apiSafe<ReviewsResult>(
      "/api/products/" + pid + "/reviews?limit=" + limit,
    );
    if (revSeq.current === my) setReviews(r);
  }, []);

  // 평점·리뷰 진입 행용 — 목록 응답에서 같은 product_id만 매칭한다.
  // 실패와 미포함은 별도 상태로 보존해 빈 리뷰와 혼동하지 않는다.
  const loadSummary = useCallback(async (pid: string, my: number) => {
    setSummary({ state: "loading" });
    const r = await fetchProductsByIds([pid]);
    if (seq.current !== my) return;
    if (!r.ok) {
      setSummary({ state: "error" });
      return;
    }
    const match = r.found.find((x) => x.product_id === pid);
    if (match) setSummary({ state: "loaded", summary: match });
    else setSummary(r.unread.includes(pid) ? { state: "error" } : { state: "unmatched" });
  }, []);

  // 플로팅 내비 → 이미지 일부와 정보 영역이 함께 보이는 시점에 solid 바로
  // 전환 [Observed 05 — 정확한 경계 픽셀은 브라우저 승인 후 검증, 지금은
  // hero 대부분이 지나기 전 전환되는 Project 임계값].
  // hero가 없는 로딩/에러 상태는 detail-null 시 nav 쪽에서 solid를 강제한다.
  useEffect(() => {
    const on = () => {
      const h = heroRef.current?.offsetHeight ?? 0;
      setNavSolid(window.scrollY > Math.max(h - 150, 8));
    };
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, [detail?.ok]);

  // F07 — 리뷰 전체보기 복귀 시 저장한 스크롤 위치로 되돌린다.
  // detail 렌더가 끝난 뒤 다음 프레임에 적용한다(이미지 디코드로 수 px
  // 밀릴 수 있음 — 정확도는 브라우저 승인 단계에서 검증).
  useEffect(() => {
    if (!detail?.ok || resumeDone.current || pendingScrollY.current == null)
      return;
    const y = pendingScrollY.current;
    pendingScrollY.current = null;
    resumeDone.current = true;
    requestAnimationFrame(() => scrollTo(0, y));
  }, [detail?.ok]);

  // 뷰어가 열린 동안 문서 뒤 스크롤과 하단 구매바를 잠근다 — 뷰어 레이어가
  // 위를 덮지만 배경 스크롤은 별도로 차단해야 한다 [Ref071 구조 보존].
  useEffect(() => {
    if (!viewerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [viewerOpen]);

  // 뷰어 오픈 시 스트립을 현재 hero 위치로 맞춘다(다중 이미지만).
  useEffect(() => {
    if (!viewerOpen || !viewerStripRef.current) return;
    const el = viewerStripRef.current;
    el.scrollTo({ left: imgIdx * el.clientWidth });
  }, [viewerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // 확정 거절 뒤 최신화: 현재 선택이 아직 구매 가능하면 유지하고,
  // 품절됐으면 첫 AVAILABLE로 다시 고른다(초기화와 규칙 통일).
  const refreshDetail = useCallback(async (pid: string) => {
    const my = seq.current;
    const r = await apiSafe<ProductDetail>("/api/products/" + pid);
    if (seq.current !== my || !r.ok) return;
    setDetail(r);
    setVariantId((cur) => {
      const still =
        cur &&
        r.data.variants.some(
          (v) => v.variant_id === cur && v.availability === "AVAILABLE",
        );
      return still ? cur : pickDefault(r.data);
    });
  }, []);

  // productId 변경 → 모든 상태 리셋 + 후행 응답 차단(stale 누출 방지)
  useEffect(() => {
    const my = ++seq.current;
    const myR = ++revSeq.current;
    setDetail(null);
    setReviews(null);
    setSummary({ state: "loading" });
    setVariantId(null);
    setQty(1);
    setImgIdx(0);
    // 열려 있던 overlay도 함께 닫는다 — 상품 전환 뒤 이전 상품의
    // 옵션/배송/이미지 시트가 새 상품 위에 누출되지 않게 한다 [PMQA-068].
    setSheetOpen(false);
    setShipOpen(false);
    setViewerOpen(false);
    setTab("reviews");
    setFeedback(null);
    setAddedOk(false);
    setMoreLoading(false);
    pendingScrollY.current = null;
    resumeDone.current = false;
    // 리뷰 더보기 실행기 — 세대별 인스턴스라 이전 잠금·요청이 새지 않는다.
    pagerRef.current = createReviewPager({
      getSeq: () => revSeq.current,
      getReviews: () => reviewsRef.current,
      fetchPage: (c) =>
        apiSafe<ReviewsResult>(
          "/api/products/" + productId + "/reviews?limit=10&cursor=" +
            encodeURIComponent(c),
        ),
      apply: setReviews,
      setBusy: setMoreLoading,
      onError: () => setFeedback("리뷰를 더 불러오지 못했어요"),
    });
    loadInitial(productId, my);
    loadReviews(productId, myR);
    loadSummary(productId, my);
    // 언마운트·productId 변경 — 늦게 도착한 응답이 화면 밖에서 복원
    // 스냅샷을 소비하거나 상태를 쓰지 못하게 두 세대를 모두 무효화한다.
    return () => {
      seq.current++;
      revSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, initialVariantId]);

  // 이 상품의 미확정 담기 + actor의 모든 미확정 cart write (전역 잠금)
  const pendingAdd =
    pendings.find(
      (p) => p.kind === "ADD_CART" && p.payload.product_id === productId,
    ) ?? null;
  const anyPending = pendings.length > 0;

  const selected: MatchedVariant | null = useMemo(
    () =>
      detail?.ok
        ? detail.data.variants.find((v) => v.variant_id === variantId) ?? null
        : null,
    [detail, variantId],
  );
  const anyAvailable = detail?.ok
    ? detail.data.variants.some((v) => v.availability === "AVAILABLE")
    : false;
  const totalWon = selected ? selected.unit_price_won * qty : 0;

  async function syncCart() {
    const c = await apiSafe<CartView>("/api/cart");
    if (c.ok) onCartChanged(c.data);
    return c;
  }

  async function add() {
    if (!commerceEnabled || !selected || adding || busyRef.current || anyPending || !detail?.ok)
      return;
    busyRef.current = true;
    setAdding(true);
    setFeedback(null);
    setAddedOk(false);
    const key = newActionKey();
    const cartRes = await apiSafe<CartView>("/api/cart");
    if (!cartRes.ok) {
      busyRef.current = false;
      setAdding(false);
      setFeedback("카트를 확인하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    const payload = {
      product_id: productId,
      variant_id: selected.variant_id,
      quantity: qty,
      expected_cart_version: cartRes.data.version,
      expected_variant_version: selected.version,
      idempotency_key: key,
    };
    // 응답 전에 intent를 보존 — 서버 commit 후 응답 유실·탭 종료 대비.
    const pw: PendingWrite = {
      uiKey: key,
      kind: "ADD_CART",
      path: "/api/cart/items",
      method: "POST",
      payload,
      label: detail.data.product.name,
      at: Date.now(),
    };
    putPending(pw);
    const r = await apiSafe<{ cart: CartView; changed_item_id: string }>(
      pw.path,
      { method: "POST", body: JSON.stringify(payload) },
    );
    busyRef.current = false;
    setAdding(false);
    if (r.ok) {
      removePending(key);
      setFeedback("장바구니에 담았어요");
      setAddedOk(true);
      // replay(저장 snapshot)면 최신 카트를 다시 읽는다 — 그 사이 다른 변경이
      // 있을 수 있어 replay 본문을 그대로 적용하지 않는다.
      if (r.replayed) await syncCart();
      else onCartChanged(r.data.cart);
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) return; // pending 유지 → 복구 UI
    // 확정 거절(VERSION_CONFLICT/OUT_OF_STOCK 등) — 자동 재실행 없이
    // 최신 상태를 다시 읽고 사용자 재확인을 요구한다.
    removePending(key);
    setFeedback("담기 실패: " + stockSafeErrorMessage(r.error.code, r.error.message));
    await refreshDetail(productId);
    await syncCart();
  }

  async function checkAddPending() {
    const p = pendingAdd;
    if (!p) return;
    const r = await lookupAction(p);
    if (!r.ok) {
      if (r.error.code === "NOT_FOUND") {
        // 서버에 기록이 없음 — 새 키 발급/자동 재전송 없이 사용자가
        // 같은 intent를 명시 재시도하도록 둔다.
        setFeedback(
          "요청 기록이 없어요. '다시 담기'로 같은 요청을 재시도할 수 있어요.",
        );
        return;
      }
      setFeedback("결과를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    const st = r.data.status;
    if (st === "SUCCEEDED") {
      removePending(p.uiKey);
      // 조회 결과는 historical snapshot일 수 있으므로 최신 카트를 다시 읽는다.
      const c = await syncCart();
      if (c.ok) {
        setFeedback("담기가 완료된 요청이었어요. 카트에 반영했습니다.");
        setAddedOk(true);
      } else {
        setFeedback(
          "처리는 완료된 요청이었어요. 최신 카트는 장바구니에서 확인해 주세요.",
        );
      }
      return;
    }
    if (st === "REJECTED") {
      removePending(p.uiKey);
      setFeedback("요청이 거절되었어요. 최신 상태를 확인해 주세요.");
      await refreshDetail(productId);
      await syncCart();
      return;
    }
    if (st === "READY") {
      setFeedback("아직 처리 중이에요. 잠시 후 다시 확인해 주세요.");
      return;
    }
    // 서버 status는 READY|SUCCEEDED|REJECTED — 예상치 못한 값이면
    // intent를 유지한 채 다음 확인에 맡긴다.
    setFeedback("결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
  }

  async function retryPendingAdd() {
    const p = pendingAdd;
    if (!p || busyRef.current) return;
    busyRef.current = true;
    setAdding(true);
    const r = await apiSafe<{ cart: CartView }>(p.path, {
      method: p.method,
      body: JSON.stringify(p.payload),
    });
    busyRef.current = false;
    setAdding(false);
    if (r.ok) {
      removePending(p.uiKey);
      // 재시도는 보통 replay — 저장 snapshot 대신 항상 최신 카트를 회수해 표시.
      await syncCart();
      setFeedback("장바구니에 담았어요");
      setAddedOk(true);
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setFeedback("아직 결과를 확인할 수 없어요. '결과 확인'으로 이어서 확인하세요.");
      return;
    }
    removePending(p.uiKey);
    setFeedback("담기 실패: " + stockSafeErrorMessage(r.error.code, r.error.message));
    await refreshDetail(productId);
    await syncCart();
  }

  // 리뷰 작성일 표기 — "26.6.22" 형태 [Observed reviews/19]
  const fmtDate = (iso: string) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t);
    return String(d.getFullYear()).slice(2) + "." + (d.getMonth() + 1) + "." + d.getDate();
  };

  // 리뷰의 variant_id를 옵션 라벨로 resolve — 서버는 active variant만 돌려주므로
  // 목록에 없으면 내부 id 대신 '옵션 정보 없음'으로 둔다.
  const variantLabel = (vid: string | null): string | null => {
    if (!vid) return null;
    const v = detail?.ok
      ? detail.data.variants.find((x) => x.variant_id === vid)
      : undefined;
    return v ? Object.values(v.option_values).join(" · ") : "옵션 정보 없음";
  };

  const goReviews = () => {
    setTab("reviews");
    const el = tabsRef.current;
    if (el)
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - 56,
        behavior: "smooth",
      });
  };

  // F07 — 전체 리뷰로 나가기 전 현재 선택·수량·스크롤을 스냅샷으로 남긴다.
  // 복원은 같은 계정·같은 상품에서 한 번만 적용되고 즉시 소비된다.
  const openReviews = () => {
    saveDetailResume(productId, {
      user: userId,
      variantId,
      qty,
      scrollY: window.scrollY,
    });
    onOpenReviews();
  };

  // hero 위 플로팅 내비 — 로딩/에러(hero 없음)와 스크롤 후엔 solid로 읽기 배경 확보.
  const navEl = (
    <nav className={"detail-nav" + (navSolid || !detail?.ok ? " solid" : "")}>
      <button className="dn-btn" aria-label="뒤로가기" onClick={onBack}>
        <IcBack size={24} />
      </button>
      <div className="dn-side">
        <button className="dn-btn" aria-label="검색" onClick={onOpenSearch}>
          <IcSearch size={20} />
        </button>
        {(
          <button className="dn-btn" aria-label="장바구니" onClick={onOpenCart}>
            <IcCart size={21} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
        )}
      </div>
    </nav>
  );

  if (!detail)
    return (
      <div className="screen detail bare">
        {navEl}
        <Loading />
      </div>
    );
  if (!detail.ok)
    return (
      <div className="screen detail bare">
        {navEl}
        <ErrorState
          text={"상품을 불러오지 못했어요 (" + detail.error.code + ")"}
          onRetry={() => {
            const my = ++seq.current;
              const myR = ++revSeq.current;
            setDetail(null);
            loadInitial(productId, my);
              loadReviews(productId, myR);
            loadSummary(productId, my);
          }}
        />
      </div>
    );
  const p = detail.data.product;
  const images = p.images?.length
    ? p.images
    : [productImg({ product_id: p.id, image: null })];
  // getProduct는 active variant만 반환 — 전부 비활성이면 variants=[]도 유효
  // 응답이다. 유효 단가가 없을 때 Math.min의 Infinity가 화면에 새지 않게
  // null로 둔다(판매 불가 상태는 soldOutAll이 표시한다).
  const unitPrices = detail.data.variants
    .map((v) => v.unit_price_won)
    .filter((x): x is number => Number.isFinite(x));
  const minWon = unitPrices.length ? Math.min(...unitPrices) : null;
  const orig = PRODUCT_META[p.id]?.original_price_won;
  // 할인율은 현재 표시 단가와 같은 기준으로 계산 — 고가 옵션(32인치 등) 선택 시
  // 최저가 기준 %와 본문 금액이 어긋나지 않게 한다.
  const shownWon = selected?.unit_price_won ?? minWon;
  const rate =
    shownWon != null && orig && orig > shownWon
      ? Math.round(((orig - shownWon) / orig) * 100)
      : 0;
  const delivery = PRODUCT_META[p.id]?.delivery;
  const soldOutAll = !anyAvailable;
  const reviewTotal = reviews?.ok ? reviews.data.total_matching : null;
  const exactRating =
    summary.state === "loaded" &&
    reviewTotal !== null &&
    summary.summary.rating_summary.count === reviewTotal &&
    summary.summary.rating_summary.avg !== null
      ? summary.summary.rating_summary.avg
      : null;
  const ratingText =
    !reviews
      ? "리뷰 정보를 확인 중이에요"
      : !reviews.ok
        ? "리뷰 정보를 확인할 수 없어요"
        : summary.state === "loading" && reviewTotal === 0
          ? "리뷰 정보를 확인 중이에요"
          : summary.state === "loaded" && summary.summary.rating_summary.count !== reviewTotal
            ? reviewTotal === 0
              ? "리뷰 정보가 일치하지 않아요"
              : "리뷰 " + reviewTotal + "개 · 평점 집계 확인 중"
            : reviewTotal === 0
              ? summary.state === "loaded"
                ? "아직 리뷰가 없어요"
                : "리뷰 0개 · 평점 요약을 확인할 수 없어요"
              : summary.state === "loading"
            ? "리뷰 " + reviewTotal + "개 · 평점 불러오는 중"
            : summary.state === "error"
              ? "리뷰 " + reviewTotal + "개 · 평점 정보를 불러오지 못했어요"
              : summary.state === "unmatched"
                ? "리뷰 " + reviewTotal + "개 · 상품 평점을 확인할 수 없어요"
                : exactRating === null
                  ? "리뷰 " + reviewTotal + "개 · 평점 집계 확인 중"
                  : null;

  return (
    <div className={"screen detail" + (anyPending ? " has-pending" : "")}>
      {navEl}
      {/* hero 탭 → 실제 이미지의 전용 확대 뷰어로 진입 [Ref071]. 이미지
          클릭이 구매 동작과 섞이지 않도록 뷰어는 별도 오버레이다. */}
      <div
        className="detail-hero tappable"
        ref={heroRef}
        role="button"
        tabIndex={0}
        aria-label="상품 이미지 확대 보기"
        onClick={() => setViewerOpen(true)}
        onKeyDown={(e) => e.key === "Enter" && setViewerOpen(true)}
      >
        {images.length > 1 ? (
          <div
            className="hero-strip"
            onScroll={(e) => {
              const el = e.currentTarget;
              setImgIdx(Math.round(el.scrollLeft / el.clientWidth));
            }}
          >
            {images.map((src, i) => (
              <img key={i} src={src} alt={p.name} />
            ))}
          </div>
        ) : (
          <img
            src={images[0]}
            alt={p.name}
            onError={(e) => {
              const el = e.currentTarget;
              el.style.display = "none";
              el.parentElement?.setAttribute("data-fallback", p.name.slice(0, 1));
            }}
          />
        )}
        {soldOutAll && <div className="soldout-cover">품절</div>}
        <span className="hero-count">
          {imgIdx + 1}|{images.length}
        </span>
      </div>

      <h2 className="detail-name">{p.name}</h2>
      {detail.data.catalog_context?.read_only && <CatalogNotice />}
      <div className="muted">
        {p.brand} · {p.description}
      </div>

      {rate > 0 && orig ? (
        <div className="price-line">
          <span className="rate">{rate}%</span>
          <s>{fmtWon(orig)}</s>
        </div>
      ) : null}
      {shownWon != null && <div className="price-main">{fmtWon(shownWon)}</div>}
      {/* Ref04의 가격 보조 행 — 서버 배송료만 표시한다 (단가·적립 등 미지원 정보는 없다). */}
      <div className="price-sub">{shipFeeLabel(detail.data.shipping_fee_won)}</div>

      <div className="info-rows">
        <button className="info-row" onClick={goReviews}>
          <span className="info-k">평점 · 리뷰</span>
          <span className="info-v">
            <span className="info-rating-main">
              {exactRating != null && reviewTotal != null ? (
                <>
                  <IcStar size={13} className="info-star" /> {exactRating}
                  <span className="muted">({reviewTotal}개)</span>
                </>
              ) : (
                <span className="muted">{ratingText}</span>
              )}
            </span>
            <small className="review-provenance-note">
              {detail.data.catalog_context?.source === "test_items" ? "합성 시연 리뷰 기준" : "수집·합성 리뷰 기준"}
            </small>
          </span>
          <IcChevronRight size={15} className="info-next" />
        </button>
        {/* Ref093 — 배송 행은 정적 표시가 아니라 '배송정보' 시트 진입이다.
            delivery meta가 없는 상품도 서버 배송비는 항상 있으므로 행은
            항상 표시하고, 데모 라벨 칩은 meta 값에만 단다 [PMQA-068]. */}
        <button className="info-row" onClick={() => setShipOpen(true)}>
          <span className="info-k">배송</span>
          <span className="info-v">
            {delivery ? (
              <>
                {delivery}
                <small className="signal-demo">데모</small>
              </>
            ) : (
              shipFeeLabel(detail.data.shipping_fee_won)
            )}
          </span>
          <IcChevronRight size={15} className="info-next" />
        </button>
      </div>
      {(summary.state === "error" || summary.state === "unmatched") && (
        <button className="link rating-retry" onClick={() => loadSummary(productId, seq.current)}>
          평점 다시 확인
        </button>
      )}

      {/* 하단 썸네일 옵션 행 [Observed product-detail/095의 상세 내 옵션 진입 행]:
          별도 '옵션' 제목·박스 대신 썸네일+선택값+파란 진입 링크 행을 둔다.
          실제 변경은 BottomSheet — 가격·재고·수량 계약은 아래 qty-row가 유지한다. */}
      {/* .option-open은 기존 계약 테스트의 선택자 훅 — 스타일은 .optline이 담당. */}
      <button
        className="optline option-open"
        onClick={() => setSheetOpen(true)}
        disabled={soldOutAll || anyPending}
      >
        <img className="optline-img" src={images[0]} alt="" />
        <span className="optline-main">
          <span className="optline-label">
            {selected
              ? Object.values(selected.option_values).join(" · ")
              : soldOutAll
                ? "구매 가능한 옵션이 없어요"
                : "옵션을 선택하세요"}
          </span>
          {selected && (
            <span className="optline-price muted">{fmtWon(selected.unit_price_won)}</span>
          )}
        </span>
        <span className="optline-cta">
          옵션 선택 <IcChevronRight size={14} />
        </span>
      </button>
      {selected && (
        <div className="qty-row">
          <span>수량</span>
          <div className="qty-ctrl">
            <button
              onClick={() => setQty(Math.max(1, qty - 1))}
              disabled={qty <= 1 || anyPending}
            >
              −
            </button>
            <b>{qty}</b>
            <button
              onClick={() => setQty(qty + 1)}
              disabled={anyPending || qty >= selected.stock_qty}
              title={qty >= selected.stock_qty ? "재고를 초과할 수 없어요" : undefined}
            >
              +
            </button>
          </div>
          <span className="muted">
            {variantStockLabel(selected.availability, selected.stock_qty, !!detail.data.catalog_context?.read_only)}
          </span>
        </div>
      )}

      <div className="detail-tabs" ref={tabsRef} role="tablist" aria-label="상품 상세 정보">
        <button
          role="tab"
          aria-selected={tab === "reviews"}
          className={tab === "reviews" ? "on" : ""}
          onClick={() => setTab("reviews")}
        >
          리뷰 ({reviewTotal ?? "…"}개)
        </button>
        <button
          role="tab"
          aria-selected={tab === "info"}
          className={tab === "info" ? "on" : ""}
          onClick={() => setTab("info")}
        >
          상품 정보
        </button>
      </div>

      {tab === "reviews" ? (
        <section className="detail-panel review-panel" role="tabpanel">
          {!reviews ? (
            <Loading text="리뷰 불러오는 중…" />
          ) : !reviews.ok ? (
            <ErrorState
              text="리뷰를 불러오지 못했어요"
              onRetry={() => {
                // 리뷰 세대만 갱신 — 진행 중인 평점/상세 로드는 무효화하지 않고,
                // 더보기의 stale 응답은 pager가 버린다.
                const myR = ++revSeq.current;
                setReviews(null);
                loadReviews(productId, myR);
              }}
            />
          ) : reviews.data.total_matching === 0 ? (
            <Empty text="아직 리뷰가 없어요. 근거로 쓸 실사용 평가가 부족합니다." />
          ) : (
            <>
              {/* 리뷰 요약 — 큰 별+평점+개수 한 묶음이 주정보 [Observed reviews/20].
                  출처 고지는 짧은 한 줄로 유지하고 제거하지 않는다(F08). */}
              <div className="review-summary-head">
                <span className="muted">이 상품의 모든 상점 리뷰</span>
              </div>
              {exactRating != null && reviewTotal != null && (
                <div className="rev-cluster">
                  <Stars rating={exactRating} size={20} />
                  <b className="rev-avg">{exactRating}</b>
                  <span className="muted">({reviewTotal}개)</span>
                </div>
              )}
              <small className="review-provenance-note">{detail.data.catalog_context?.source === "test_items" ? "합성 시연 리뷰 기준" : "수집·합성 리뷰 기준"}</small>
              <ul className="review-list">
                {reviews.data.reviews.map((rv) => (
                  <ReviewRow
                    key={rv.id}
                    rv={rv}
                    optionLabel={rv.variant_id ? variantLabel(rv.variant_id) : null}
                    dateText={fmtDate(rv.written_at)}
                  />
                ))}
              </ul>
              {reviews.data.has_more && (
                <button
                  className="link"
                  onClick={() => pagerRef.current?.loadMore()}
                  disabled={moreLoading}
                >
                  {moreLoading ? "불러오는 중…" : "리뷰 더 보기"}
                </button>
              )}
              {/* F07 — 전체 리뷰 전용 화면으로 연결 [Observed reviews/19].
                  복귀 시 선택·수량·스크롤은 detailResume 스냅샷이 복원한다. */}
              <button className="link" onClick={openReviews}>
                리뷰 {reviewTotal}개 전체 보기
              </button>
            </>
          )}
        </section>
      ) : (
        <section className="detail-panel detail-info-panel" role="tabpanel">
          <p>{p.description}</p>
          <dl>
            {Object.entries(p.specs).map(([k, v]) => (
              <div key={k} className="spec-row">
                <dt>{SPEC_LABEL[k] ?? k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {<div className={"bottom-bar" + (anyPending || !commerceEnabled || detail.data.catalog_context?.read_only ? " has-note" : "")}>
        {(!commerceEnabled || detail.data.catalog_context?.read_only) && <p className="muted sm" role="note">{detail.data.catalog_context?.read_only
          ? commerceEnabled ? "시연 상품 · 찜·장바구니 저장 가능 · 주문·결제 불가" : "테스트 상품 · 조회 전용 · 주문·결제 불가"
          : "쇼핑 기능을 확인하고 있어요"}</p>}
        {anyPending && (
          // 미확정 write가 있으면 고정 바 최상단에서 바로 복구로 진입 — 상세
          // state-box는 문서 하단이라 첫 화면에서 발견되지 않는다.
          <div className="bar-note" role="status">
            <span>결과를 확인하지 못한 요청이 있어요</span>
            <button className="link" onClick={onOpenCart}>
              장바구니에서 복구
            </button>
          </div>
        )}
        <div className="bar-row detail-actions">
          {/* Ref08 — 하트는 하단 CTA 행의 찜 Action [Observed]. 카트 버튼과
              나란한 별개 동작으로 두고, 저장 확정 시 상품 정보가 담긴
              시트를 연다 [PMQA-070]. */}
          <WishButton
            className="detail-heart"
            userId={userId}
            commerceEnabled={commerceEnabled}
            product={{
              product_id: productId,
              name: p.name,
              image: p.images?.[0] ?? null,
              price_won: minWon,
            }}
            onGoWish={onOpenWish}
          />
          <button className="detail-cart-btn" aria-label="장바구니" onClick={onOpenCart}>
            <IcCart size={21} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
          {/* Ref04 하단 구조: 아이콘 + 보조 CTA(담기) + 주 CTA(구매하기).
              옵션 변경 진입은 본문 .optline 행·시트가 담당한다 — 하단 바에
              별도 옵션 버튼을 두지 않는다 [PMQA-067 Ref04/096 정합]. */}
          <button
            className="btn ghost"
            aria-label={soldOutAll ? "품절" : adding ? "담는 중" : fmtWon(totalWon) + " 담기"}
            disabled={!commerceEnabled || !selected || adding || anyPending || soldOutAll}
            title={!commerceEnabled ? "현재 조회 전용 QA 환경에서는 장바구니에 저장할 수 없어요" : undefined}
            onClick={add}
          >
            {soldOutAll ? "품절" : adding ? "담는 중…" : fmtWon(totalWon) + " 담기"}
          </button>
          {/* 바로 구매 — 담기와 별개 동작. 카트를 거치지 않는 DIRECT 견적
              주문서로 이동한다 [PMQA-067, Ref04 구매하기 CTA 대응]. */}
          <button
            className="btn primary"
            aria-label="구매하기"
            disabled={!checkoutEnabled || !selected || adding || anyPending || soldOutAll}
            onClick={() =>
              selected &&
              onBuyNow({ variant_id: selected.variant_id, quantity: qty })
            }
          >
            구매하기
          </button>
        </div>
      </div>}

      {sheetOpen && detail.ok && (
        <BottomSheet title="옵션 한번에 보기" onClose={() => setSheetOpen(false)}>
          {/* Ref095 — 선택 옵션은 둥근 강조 카드, 미선택은 파란 옵션 텍스트.
              가격·재고·quantity/pending lock·변경 handler는 기존 계약 불변. */}
          <div className="opt-list">
            {detail.data.variants.map((v) => {
              const soldOut = v.availability !== "AVAILABLE";
              const on = v.variant_id === variantId;
              return (
                <button
                  key={v.variant_id}
                  className={"opt-item" + (on ? " sel" : "")}
                  disabled={soldOut}
                  onClick={() => {
                    setVariantId(v.variant_id);
                    setQty(1);
                    setFeedback(null);
                    setSheetOpen(false);
                  }}
                >
                  <span className="opt-name">
                    {Object.values(v.option_values).join(" · ")}
                  </span>
                  <span className="opt-price">{fmtWon(v.unit_price_won)}</span>
                  <span className="opt-sub muted">
                    {soldOut
                      ? v.availability === "SOLD_OUT"
                        ? "품절"
                        : "판매 중단"
                      : variantStockLabel(v.availability, v.stock_qty, !!detail.data.catalog_context?.read_only)}
                  </span>
                </button>
              );
            })}
          </div>
        </BottomSheet>
      )}

      {/* Ref093 '배송정보' 시트 — grabber·타이틀은 공용 BottomSheet가 담당하고
          본문은 label/value 행 + 하단 단일 확인 CTA. Backend가 실제 지원하는
          정보만 표시한다(배송비=서버값, 부재·비정상은 '정보 없음' 구분).
          PRODUCT_META의 '내일도착/오늘출발' 데모 라벨을 배송 조건으로
          확장하지 않는다 — 도착 예정일·택배사·보장 확률·개인 배송지 박스는
          데이터가 없어 복제하지 않고 gap 문구로 명시한다 [PMQA-068]. */}
      {shipOpen && detail.ok && (
        <BottomSheet
          title="배송정보"
          onClose={() => setShipOpen(false)}
          className="ship-sheet"
          lockScroll
        >
          {/* 본문만 스크롤하고 확인 CTA는 시트 하단에 고정 — 작은 화면에서도
              CTA가 문서 흐름 끝에 밀려 가려지지 않는다 [PMQA-068]. */}
          <div className="ship-scroll">
            <div className="ship-rows">
              <div className="ship-row">
                <span className="ship-k">배송비</span>
                <span className="ship-v">{shipFeeLabel(detail.data.shipping_fee_won)}</span>
              </div>
            </div>
            <p className="ship-gap muted">
              도착 예정일·택배사·배송지별 조건은 아직 제공하지 않아요.
              {delivery && " 상품 행의 '" + delivery + "' 표시는 시연용 라벨이며 실제 배송 약속이 아니에요."}
            </p>
          </div>
          <button
            className="btn primary sheet-cta"
            onClick={() => setShipOpen(false)}
          >
            확인
          </button>
        </BottomSheet>
      )}

      {pendingAdd ? (
        <div className="state-box">
          <b>담기 결과를 확인하지 못했어요</b>
          <p className="muted">
            {pendingAdd.label} — 같은 요청이 중복으로 들어가지 않게 잠겨 있어요.
          </p>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={checkAddPending}>
              결과 확인
            </button>
            <button
              className="btn primary"
              onClick={retryPendingAdd}
              disabled={adding}
            >
              다시 담기
            </button>
          </div>
          <button className="link" onClick={onOpenCart}>
            장바구니에서 확인하기
          </button>
        </div>
      ) : anyPending ? (
        // 다른 화면에서 시작된 미확정 cart write — 결과가 확정되기 전엔
        // 새 담기·옵션·수량 변경을 잠그고 카트 복구로 안내한다.
        <div className="state-box">
          <b>확인되지 않은 이전 요청이 있어요</b>
          <p className="muted">결과가 확정되기 전에는 새 변경을 할 수 없어요.</p>
          <button className="btn ghost" onClick={onOpenCart}>
            장바구니에서 결과 확인
          </button>
        </div>
      ) : null}
      {feedback && (
        <div className="toast">
          {feedback}
          {addedOk && (
            <button className="link" onClick={onOpenCart}>
              장바구니 보기
            </button>
          )}
        </div>
      )}

      {/* F32 전용 확대 뷰어 [Observed product-detail/071]: 상단 뒤로 · 중앙
          확대 이미지 · 하단 thumbnail strip. 실제 존재하는 이미지만 열고
          없는 장수를 채우지 않는다 — 1장이면 썸네일 행도 1개다. */}
      {viewerOpen && (
        <div className="viewer" role="dialog" aria-label="상품 이미지 확대 보기">
          <button
            className="viewer-back"
            aria-label="뒤로가기"
            onClick={() => setViewerOpen(false)}
          >
            <IcBack size={26} />
          </button>
          <div className="viewer-stage">
            {images.length > 1 ? (
              <div
                className="viewer-strip"
                ref={viewerStripRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  setImgIdx(Math.round(el.scrollLeft / el.clientWidth));
                }}
              >
                {images.map((src, i) => (
                  <img key={i} src={src} alt={p.name} />
                ))}
              </div>
            ) : (
              <img className="viewer-img" src={images[imgIdx]} alt={p.name} />
            )}
          </div>
          {images.length > 1 && (
            <div className="viewer-thumbs">
              {images.map((src, i) => (
                <button
                  key={i}
                  className={"viewer-thumb" + (i === imgIdx ? " on" : "")}
                  aria-label={"이미지 " + (i + 1)}
                  onClick={() => {
                    const el = viewerStripRef.current;
                    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
                    setImgIdx(i);
                  }}
                >
                  <img src={src} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
