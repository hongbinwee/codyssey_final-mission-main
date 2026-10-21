import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiSafe } from "./api.ts";
import type { CartView, CheckoutTarget } from "../contracts.ts";
import { bindPendingUser } from "./pending.ts";
import { takeDetailResume } from "./detail-resume.ts";
import { CatalogNotice } from "./components/CommerceState.tsx";
import { isCommerceEnabled, isCheckoutEnabled, type CatalogUiContext } from "./commerce-ui.ts";
import { activeBottomNavSlot } from "./bottom-nav-state.ts";
import { visibleCart, type OwnedCart } from "./cart-scope.ts";
import { Shopping } from "./screens/Shopping.tsx";
import { Search } from "./screens/Search.tsx";
import { Product } from "./screens/Product.tsx";
import { Reviews } from "./screens/Reviews.tsx";
import { Cart } from "./screens/Cart.tsx";
import { Checkout } from "./screens/Checkout.tsx";
import { OrderComplete } from "./screens/OrderComplete.tsx";
import { Orders } from "./screens/Orders.tsx";
import { OrderDetail } from "./screens/OrderDetail.tsx";
import { Recent } from "./screens/Recent.tsx";
import { MyShop } from "./screens/MyShop.tsx";
import { AgentPanel, type AgentReply } from "./components/AgentPanel.tsx";
import { AGENT_TURN_ENABLED } from "./agent-gate.ts";
import type { AgentBrain } from "./api.ts";
import { IcBack, IcBagFill, IcCart, IcChevronDown, IcHome, IcMenu, IcReceipt, IcSearch, IcSparkle, IcTag, IcUser } from "./icons.tsx";
import { CONTENT_TABS, groupLabel, groupOf } from "./display-meta.ts";

type Route =
  | { name: "shop"; category: string; sub: string }
  | { name: "search"; query: string }
  | { name: "product"; id: string; variantId?: string }
  | { name: "reviews"; id: string }
  | { name: "cart" }
  // target 없음 = 전체 카트(legacy), INVALID = 파싱 실패(견적 미발급) [PMQA-067]
  | { name: "checkout"; target?: CheckoutTarget | { kind: "INVALID" } }
  | { name: "orders" }
  | { name: "order"; id: string; focus?: "shipping" }
  | { name: "orderComplete"; id: string }
  // tab='wish'는 준비중 찜 표면의 단일 진입 — Cart/MyShop의 찜 진입도
  // 이 경로로 모아 준비중 상태가 두 곳에 갈리지 않게 한다 [C/069]
  | { name: "recent"; tab?: "wish" }
  | { name: "myshop" };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "");
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (path === "/search") return { name: "search", query: params.get("q") ?? "" };
  // '/p/:id/reviews'는 '/p/' 접두 매칭보다 먼저 파싱한다 [F07 전체 리뷰].
  if (path.startsWith("/p/") && path.endsWith("/reviews"))
    return { name: "reviews", id: decodeURIComponent(path.slice(3, -8)) };
  if (path.startsWith("/p/")) {
    const id = decodeURIComponent(path.slice(3));
    const variantId = params.get("v");
    return { name: "product", id, ...(variantId ? { variantId } : {}) };
  }
  if (path === "/cart") return { name: "cart" };
  if (path === "/checkout") {
    // 구매 대상 파라미터 — src=sel(선택 주문)·src=direct(바로 구매) [PMQA-067].
    const src = params.get("src");
    if (src === "sel") {
      const ids = (params.get("items") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        name: "checkout",
        target: ids.length ? { kind: "CART_SELECTED", cart_item_ids: ids } : { kind: "INVALID" },
      };
    }
    if (src === "direct") {
      const v = params.get("v") ?? "";
      const qty = Number(params.get("q"));
      if (v && Number.isInteger(qty) && qty > 0)
        return {
          name: "checkout",
          target: {
            kind: "DIRECT",
            variant_id: v,
            quantity: qty,
            product_id: params.get("p") ?? undefined,
          },
        };
      return { name: "checkout", target: { kind: "INVALID" } };
    }
    // src 없음 = 명시적 전체 카트(legacy). 알 수 없는 src는 INVALID — 잘못된
    // 대상을 전체 카트로 대체하지 않는다.
    if (src) return { name: "checkout", target: { kind: "INVALID" } };
    return { name: "checkout" };
  }
  if (path === "/orders") return { name: "orders" };
  if (path === "/recent")
    return {
      name: "recent",
      tab: params.get("tab") === "wish" ? "wish" : undefined,
    };
  if (path === "/myshop") return { name: "myshop" };
  // '/orders/:id/complete'는 '/orders/' 접두 매칭보다 먼저 파싱한다.
  if (path.startsWith("/orders/") && path.endsWith("/complete"))
    return { name: "orderComplete", id: decodeURIComponent(path.slice(8, -9)) };
  // 목록 '배송 조회' 칩 → 상세의 배송 섹션 앵커 [PMQA-048-A 소유 범위 내 최소 라우팅].
  if (path.startsWith("/orders/") && path.endsWith("/shipping"))
    return { name: "order", id: decodeURIComponent(path.slice(8, -9)), focus: "shipping" };
  if (path.startsWith("/orders/")) return { name: "order", id: decodeURIComponent(path.slice(8)) };
  return { name: "shop", category: params.get("cat") ?? "", sub: params.get("sub") ?? "" };
}

// 앱 내부 해시 이력은 history.state 마커로 추적한다.
// pushState로 만든 엔트리는 {app:1, internal:1} — 직전 엔트리가 앱 내부 화면임을 보장한다.
// 외부/직접 해시 진입 엔트리는 mount·hashchange 시 {app:1}로만 마킹(internal 없음).
// 뒤로가기: internal 플래그가 있으면 history.back(), 없으면 커머스 parent로
// **replace** fallback — 일반 push로 대체하면 parent→back이 원 화면으로 되돌아가는
// 루프(directCheckout→cart→back→checkout)가 생긴다. replace면 back마다 상위로 올라간다.
// URL 문자열 비교나 global history.length로 내부 이력을 추정하지 않는다 [PM 지침, Project]
const markCurrent = (internal: boolean) =>
  history.replaceState(
    internal ? { app: 1, internal: 1 } : { app: 1 },
    "",
    location.hash || "#/",
  );

const toHash = (r: Route) =>
  r.name === "search" ? "#/search" + (r.query ? "?q=" + encodeURIComponent(r.query) : "")
  : r.name === "product" ? "#/p/" + encodeURIComponent(r.id) + (r.variantId ? "?v=" + encodeURIComponent(r.variantId) : "")
  : r.name === "reviews" ? "#/p/" + encodeURIComponent(r.id) + "/reviews"
  : r.name === "cart" ? "#/cart"
  : r.name === "checkout"
    ? "#/checkout" +
      (r.target?.kind === "CART_SELECTED"
        ? "?src=sel&items=" + encodeURIComponent(r.target.cart_item_ids.join(","))
        : r.target?.kind === "DIRECT"
          ? "?src=direct&v=" + encodeURIComponent(r.target.variant_id) +
            "&q=" + r.target.quantity +
            (r.target.product_id ? "&p=" + encodeURIComponent(r.target.product_id) : "")
          : r.target?.kind === "INVALID" ? "?src=invalid" : "")
  : r.name === "orders" ? "#/orders"
  : r.name === "recent" ? "#/recent" + (r.tab === "wish" ? "?tab=wish" : "")
  : r.name === "myshop" ? "#/myshop"
  : r.name === "orderComplete" ? "#/orders/" + encodeURIComponent(r.id) + "/complete"
  : r.name === "order" ? "#/orders/" + encodeURIComponent(r.id) + (r.focus === "shipping" ? "/shipping" : "")
  : "#/" + (r.category
      ? "?cat=" + encodeURIComponent(r.category) + (r.sub ? "&sub=" + encodeURIComponent(r.sub) : "")
      : "");

// pushState/replaceState는 hashchange를 발생시키지 않으므로 라우트 갱신은 직접 알린다.
const emitRoute = () => dispatchEvent(new Event("hashchange"));

const goto = (r: Route) => {
  history.pushState({ app: 1, internal: 1 }, "", toHash(r));
  emitRoute();
  // 새 화면 진입은 스크롤을 초기화한다 — 딥스크롤에서 네비 탭 전환해도
  // 이전 스크롤 위치가 남지 않게 한다 [Project]. 뒤로가기(pop)는 브라우저의
  // 자동 스크롤 복원에 맡겨 건드리지 않는다.
  scrollTo(0, 0);
};

const gotoReplace = (r: Route) => {
  history.replaceState({ app: 1 }, "", toHash(r));
  emitRoute();
  scrollTo(0, 0);
};

function Login({ onLogin }: { onLogin: (id: string, name: string) => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const j = await r.json();
    if (j.ok) onLogin(j.user.id, j.user.display_name);
    else setErr(j.error?.message ?? "로그인 실패");
  }
  return (
    <div className="login">
      <h1>AI Commerce</h1>
      <p className="muted">테스트 접근 코드를 입력하세요</p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="접근 코드"
      />
      <button className="btn primary" onClick={submit}>시작하기</button>
      {err && <p className="error-text">{err}</p>}
    </div>
  );
}

// 하단 네비는 홈(탭 루트)에만 표시한다 — 카트/주문/상세는 푸시 화면이며
// 자체 고정 CTA(.bottom-bar)가 있어 겹치지 않게 한다.
const NAV_ROUTES = new Set(["shop"]);
// 뒤로가기 바를 붙이는 푸시 화면
const BACK_ROUTES = new Set(["cart", "checkout", "orders", "order", "orderComplete", "recent", "myshop"]);

// 내부 이동 이력이 없을 때 뒤로가기 fallback 목적지 [Project]
const BACK_PARENT: Record<string, Route> = {
  product: { name: "shop", category: "", sub: "" },
  cart: { name: "shop", category: "", sub: "" },
  checkout: { name: "cart" },
  orders: { name: "shop", category: "", sub: "" },
  order: { name: "orders" },
  orderComplete: { name: "shop", category: "", sub: "" },
  // 최근본은 내 쇼핑에서 진입한다 — 직접 해시 진입의 뒤로가기 fallback [C/069]
  recent: { name: "myshop" },
  myshop: { name: "shop", category: "", sub: "" },
};

function App() {
  const [user, setUser] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [catalogContext, setCatalogContext] = useState<CatalogUiContext | null>(null);
  const [catalogContextError, setCatalogContextError] = useState(false);
  const [loggingOut,setLoggingOut]=useState(false);
  const [logoutError,setLogoutError]=useState("");
  const [route, setRoute] = useState<Route>(parseHash());
  const [rootNavSlot, setRootNavSlot] = useState<"home" | "shop">("home");
  const [agentOpen, setAgentOpen] = useState<AgentBrain | null>(null);
  // Brain별 대화를 따로 유지한다 (서버도 user:brain 단위로 히스토리를 나눈다).
  const [agentMsgs, setAgentMsgs] = useState<Record<AgentBrain, AgentReply[]>>({
    shopping: [],
    cs: [],
  });
  const [cartState, setCartState] = useState<OwnedCart | null>(null);
  const [search, setSearch] = useState("");
  // 쇼핑 홈 스크롤 시 검색 필드가 사라지고 플로팅 아이콘만 남는다 [Observed home/02]
  const [miniTop, setMiniTop] = useState(false);
  // 딥스크롤에서 하단 네비가 사라진다 [Observed home/02]. 복귀 트리거는 미관측이라
  // 내릴 때 숨기고 올릴 때 복귀하는 방향 인식 패턴을 채택한다 [Inferred→Project]
  const [navHidden, setNavHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const lastY = useRef(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const allBtnRef = useRef<HTMLButtonElement | null>(null);
  const commerceEnabled = isCommerceEnabled(catalogContext);
  const checkoutEnabled = isCheckoutEnabled(catalogContext);
  const catalogReadOnly =
    catalogContext?.read_only === true && catalogContext.is_simulated;
  const commerceEnabledRef = useRef(commerceEnabled);
  commerceEnabledRef.current = commerceEnabled;
  useEffect(() => {
    let active = true;
    setCatalogContext(null);
    setCatalogContextError(false);
    if (userId)
      void apiSafe<CatalogUiContext>("/api/catalog/context").then((r) => {
        if (!active) return;
        if (r.ok) setCatalogContext(r.data);
        else setCatalogContextError(true);
      });
    return () => { active = false; };
  }, [userId]);
  // '전체' 메뉴 시트 — 열 때 첫 항목 포커스, ESC로 닫기, 닫을 때 전체 버튼으로 포커스 복귀 [Project]
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>(".menu-item")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      allBtnRef.current?.focus();
    };
  }, [menuOpen]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setMiniTop(y > 72);
      setNavHidden(y > 120 && y > lastY.current);
      lastY.current = y;
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // GET /api/session은 ToolResult 봉투가 아니라 {ok, user}를 최상위로 반환한다 —
    // api() 봉투의 data.user로 읽으면 undefined에서 throw하고 setChecked가 실행되지
    // 않아 세션 복원(reload)이 blank가 된다 [Observed 계약, PM 발견 결함 수정]
    fetch("/api/session")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && j?.user?.id) {
          setUser(j.user.display_name);
          setUserId(j.user.id);
        }
        setChecked(true);
      })
      .catch(() => setChecked(true));
    // 최초 진입 엔트리를 앱 소유로 마킹 — 직접 해시 진입(#/cart 등)은
    // internal 없음으로 두어 뒤로가기가 커머스 parent로 fallback하게 한다.
    // 복원된 세션(reload·browser back 복귀)의 앱 마커는 보존한다.
    if (!(history.state as { app?: number } | null)?.app) markCurrent(false);
    const onHash = () => {
      // 수동 해시 편집·마커 없는 구세대 엔트리는 내부 이력 없음으로 간주해 마킹
      if (!(history.state as { app?: number } | null)?.app) markCurrent(false);
      setRoute(parseHash());
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // 미확정 쓰기 intent는 세션으로 검증된 user.id로 namespace를 나눈다 —
  // 계정 전환 시 타인 intent가 보이지도 실행되지도 않는다.
  useEffect(() => {
    bindPendingUser(userId);
  }, [userId]);

  // 카트는 actor 소유 상태다 [069 MAJOR-2/069-06 정정] — 스냅샷을
  // {owner, view}로 보관하고 렌더 시점 owner 필터로만 자식·배지에 노출해
  // 첫 렌더에도 이전 actor 카트가 새지 않는다. userIdRef는 effect가 아니라
  // 렌더에서 즉시 갱신해 늦은 callback의 owner 비교가 현재 actor를 본다.
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;
  const cartReadSeq = useRef(0);
  const refreshCart = useCallback(() => {
    const owner = userIdRef.current;
    if (!owner || !commerceEnabledRef.current) return;
    const my = ++cartReadSeq.current;
    apiSafe<CartView>("/api/cart").then(
      (r) =>
        r.ok &&
        cartReadSeq.current === my &&
        userIdRef.current === owner &&
        setCartState({ owner, v: r.data }),
    );
  }, []);
  // 자식 화면이 직접 확정한 최신 CartView 적용 — owner는 호출 시점의 actor.
  const applyCart = useCallback((v: CartView, owner: string | null) => {
    if (!commerceEnabledRef.current || userIdRef.current !== owner) return;
    cartReadSeq.current++;
    setCartState({ owner, v });
  }, []);
  useEffect(() => {
    cartReadSeq.current++; // 진행 중 이전 actor read 무효화
    setCartState(null);    // 이전 actor 카트 스냅샷 제거(첫 렌더는 owner 필터가 차단)
    if (userId && commerceEnabled) refreshCart();
  }, [userId, refreshCart, commerceEnabled]);

  // 렌더 시점 owner 필터 — 스냅샷의 owner가 현재 actor와 다르면 어떤
  // 자식·배지에도 이전 계정 카트를 노출하지 않는다 [069-06].
  const cart = visibleCart(cartState, userId);

  if (!checked) return null;
  if (!user) return <Login onLogin={(id, name) => { setUserId(id); setUser(name); }} />;

  const pageContext = {
    screen: route.name,
    product_id: route.name === "product" || route.name === "reviews" ? route.id : undefined,
    order_id: route.name === "order" ? route.id : undefined,
  };
  const cartCount = commerceEnabled ? cart?.items.length ?? 0 : 0;
  const showNav = NAV_ROUTES.has(route.name);
  const activeNavSlot = activeBottomNavSlot(
    route.name,
    route.name === "shop" ? route.category : "",
    agentOpen,
    menuOpen,
    rootNavSlot,
  );
  // 쇼핑/검색 화면은 Toss 기준 좁은 좌우 여백을 쓴다 [Observed ~10px]
  const shopPad = route.name === "shop" || route.name === "search";
  // 리스트 뷰(그룹/서브카테고리)는 글로벌 검색 헤더 대신 전용 헤더를 쓴다
  // [Observed 100 / F31]. Shopping의 view 판정과 같은 조건을 미러한다.
  const shopList =
    route.name === "shop" &&
    !!route.category &&
    route.category !== "sale" &&
    route.category !== "season" &&
    route.category !== "category" &&
    (!!route.sub || !CONTENT_TABS.has(groupOf(route.category)));
  const goBack = () => {
    const st = history.state as { internal?: number } | null;
    if (st?.internal) history.back();
    else {
      // 전체 리뷰는 내부 이력이 없을 때 같은 상품 상세로 되돌린다 [F07].
      // 바로 구매 주문서는 출발 상품 상세로 되돌린다 — 카트를 거치지 않는
      // DIRECT 흐름이므로 cart fallback이 아니다 [PMQA-067].
      const parent =
        route.name === "reviews"
          ? { name: "product" as const, id: route.id }
          : route.name === "checkout" &&
              route.target?.kind === "DIRECT" &&
              route.target.product_id
            ? { name: "product" as const, id: route.target.product_id }
            // 리스트 뷰 직접 진입 fallback — 서브는 그룹 리스트/홈으로,
            // 그룹 최상위는 카테고리 브라우저로 올라간다 [Project]
            : route.name === "shop"
              ? route.sub
                ? { name: "shop" as const, category: route.category, sub: "" }
                : { name: "shop" as const, category: "category", sub: "" }
            : BACK_PARENT[route.name];
      gotoReplace(parent);
    }
  };

  return (
    <div className={"shell" + (showNav ? " has-nav" : "") + (shopPad ? " shop-pad" : "")}>
      {route.name === "shop" && !shopList && (
        <header className={"top" + (miniTop ? " mini" : "")}>
          <form
            className="search-field"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) goto({ name: "search", query: search.trim() });
            }}
          >
            <span className="field-ico"><IcSearch size={18} /></span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="상품 검색"
            />
          </form>
          <button
            className="icon-btn"
            aria-label="내 쇼핑"
            onClick={() => goto({ name: "myshop" })}
          >
            <IcUser size={23} />
          </button>
          {(
            <button
              className="icon-btn"
              aria-label="장바구니"
              onClick={() => goto({ name: "cart" })}
            >
              <IcCart size={23} />
              {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
            </button>
          )}
        </header>
      )}
      {/* 리스트 뷰 전용 헤더 — ← · 그룹명▾ · 검색 · 장바구니 [Observed 100].
          그룹명 chevron의 실제 동작은 미관측이라 카테고리 브라우저 진입으로 둔다 [Project] */}
      {route.name === "shop" && shopList && (
        <header className="list-head">
          <button className="icon-btn" aria-label="뒤로가기" onClick={goBack}>
            <IcBack size={24} />
          </button>
          <button
            className="list-title"
            onClick={() => goto({ name: "shop", category: "category", sub: "" })}
          >
            {groupLabel(groupOf(route.category))}
            <IcChevronDown size={16} />
          </button>
          <span className="list-spacer" />
          <button
            className="icon-btn"
            aria-label="검색"
            onClick={() => goto({ name: "search", query: "" })}
          >
            <IcSearch size={23} />
          </button>
          {(
            <button
              className="icon-btn"
              aria-label="장바구니"
              onClick={() => goto({ name: "cart" })}
            >
              <IcCart size={23} />
              {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
            </button>
          )}
        </header>
      )}
      {route.name === "shop" && miniTop && !shopList && (
        <div className="float-nav">
          <button
            className="float-btn"
            aria-label="검색"
            onClick={() => goto({ name: "search", query: "" })}
          >
            <IcSearch size={19} />
          </button>
          <button
            className="float-btn"
            aria-label="장바구니"
            onClick={() => goto({ name: "cart" })}
          >
            <IcCart size={19} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
        </div>
      )}
      {BACK_ROUTES.has(route.name) && (
        <header className="backbar">
          <button
            className="back-btn"
            aria-label="뒤로가기"
            onClick={goBack}
          >
            <IcBack size={24} />
          </button>
        </header>
      )}
      <main>
        {catalogContextError && (
          <div className="state-box" role="alert">
            쇼핑 기능 정보를 확인하지 못했어요. 새로고침 후 다시 시도해 주세요.
          </div>
        )}
        {catalogReadOnly && <>
          <div className="state-box">
            <span>현재 테스트 계정: {userId}</span>{" "}
            <button className="link" disabled={loggingOut} onClick={async()=>{
              setLoggingOut(true);setLogoutError("");
              try{
                const response=await fetch("/api/session",{method:"DELETE"});
                const result=await response.json();
                if(!response.ok||!result.ok)throw new Error();
                location.reload();
              }catch{setLogoutError("로그아웃하지 못했어요. 다시 시도해 주세요.");setLoggingOut(false);}
            }}>{loggingOut?"로그아웃 중…":"로그아웃"}</button>
            {logoutError&&<p role="alert">{logoutError}</p>}
          </div>
          <CatalogNotice />
        </>}
        {route.name === "shop" && (
          <Shopping
            category={route.category}
            sub={route.sub}
            userName={user}
            onNav={(c, s) => goto({ name: "shop", category: c, sub: s ?? "" })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            onOpenOrders={() => goto({ name: "orders" })}
            onOpenCart={() => goto({ name: "cart" })}
            userId={userId}
            onOpenWish={() => goto({ name: "recent", tab: "wish" })}
            commerceEnabled={commerceEnabled}
          />
        )}
        {route.name === "search" && (
          <Search
            query={route.query}
            onBack={() => goto({ name: "shop", category: "", sub: "" })}
            onSubmit={(q) => goto({ name: "search", query: q })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            cartCount={cartCount}
            onOpenCart={() => goto({ name: "cart" })}
            userId={userId}
            onOpenWish={() => goto({ name: "recent", tab: "wish" })}
            commerceEnabled={commerceEnabled}
          />
        )}
        {route.name === "product" && (
          <Product
            // 계정 전환 시 재마운트 — 진행 중 detail 응답·최근본 기록이
            // 이전 actor 세대로 남지 않게 cleanup이 세대를 무효화한다 [C/069]
            key={userId + ":" + route.id + ":" + (route.variantId ?? "")}
            productId={route.id}
            initialVariantId={route.variantId}
            checkoutEnabled={checkoutEnabled}
            userId={userId}
            onBack={goBack}
            onOpenSearch={() => goto({ name: "search", query: "" })}
            onOpenCart={() => goto({ name: "cart" })}
            onOpenReviews={() => goto({ name: "reviews", id: route.id })}
            onCartChanged={(v) => applyCart(v, userId)}
            cartCount={cartCount}
            onOpenWish={() => goto({ name: "recent", tab: "wish" })}
            commerceEnabled={commerceEnabled}
            onBuyNow={(t) =>
              goto({
                name: "checkout",
                target: {
                  kind: "DIRECT",
                  variant_id: t.variant_id,
                  quantity: t.quantity,
                  product_id: route.name === "product" ? route.id : undefined,
                },
              })
            }
          />
        )}
        {route.name === "reviews" && (
          <Reviews key={route.id} productId={route.id} onBack={goBack} />
        )}
        {route.name === "cart" && (
          <Cart
            // actor별 재마운트 — 진행 중 카트 작업·선택 상태가 다른 계정에
            // 남지 않게 한다 [069 MAJOR-2 정정].
            key={userId}
            cart={cart}
            onCartLoaded={(v) => applyCart(v, userId)}
            onCheckout={(ids) =>
              goto(
                ids
                  ? { name: "checkout", target: { kind: "CART_SELECTED", cart_item_ids: ids } }
                  : { name: "checkout" },
              )
            }
            onOpenProduct={(id) => goto({ name: "product", id })}
            onOpenRecent={() => goto({ name: "recent" })}
            onOpenWish={() => goto({ name: "recent", tab: "wish" })}
            commerceEnabled={commerceEnabled}
            catalogReadOnly={catalogReadOnly}
            checkoutEnabled={checkoutEnabled}
            onOpenShop={() => goto({ name: "shop", category: "", sub: "" })}
          />
        )}
        {route.name === "checkout" && (
          <Checkout
            target={route.target}
            onOpenComplete={(id) => {
              // 결제 확정으로 서버 카트가 비워졌다 — 성공·pending 복구·재시도가
              // 공유하는 완료 진입점에서 읽기 갱신(seq 가드)해 홈 복귀 시
              // 배지가 결제 전 수량으로 남지 않게 한다.
              refreshCart();
              goto({ name: "orderComplete", id });
            }}
            onOpenCart={() => goto({ name: "cart" })}
          />
        )}
        {route.name === "orderComplete" && (
          <OrderComplete
            orderId={route.id}
            onOpenOrder={(id) => goto({ name: "order", id })}
            onOpenHome={() => goto({ name: "shop", category: "", sub: "" })}
          />
        )}
        {route.name === "orders" && (
          <Orders
            key={userId}
            onOpenOrder={(id) => goto({ name: "order", id })}
            onOpenShop={() => goto({ name: "shop", category: "", sub: "" })}
            onOpenShipping={(id) => goto({ name: "order", id, focus: "shipping" })}
          />
        )}
        {route.name === "order" && (
          <OrderDetail
            orderId={route.id}
            focus={route.focus}
            onBack={() => goto({ name: "orders" })}
            onOpenProduct={(id) => goto({ name: "product", id })}
          />
        )}
        {route.name === "recent" && (
          <Recent
            key={userId}
            userId={userId}
            // 탭은 route 소유 상태 — 선택과 URL이 항상 일치한다 [069 MAJOR-1].
            tab={route.tab === "wish" ? "wish" : "recent"}
            onSelectTab={(t) =>
              gotoReplace({
                name: "recent",
                tab: t === "wish" ? "wish" : undefined,
              })
            }
            cartCount={cartCount}
            onOpenCart={() => goto({ name: "cart" })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            onOpenShop={() => goto({ name: "shop", category: "", sub: "" })}
            commerceEnabled={commerceEnabled}
            catalogReadOnly={catalogReadOnly}
          />
        )}
        {route.name === "myshop" && (
          <MyShop
            key={userId}
            userId={userId}
            onOpenRecent={() => goto({ name: "recent" })}
            onOpenWish={() => goto({ name: "recent", tab: "wish" })}
            onOpenOrders={() => goto({ name: "orders" })}
            onOpenOrder={(id) => goto({ name: "order", id })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            onOpenShop={() => goto({ name: "shop", category: "", sub: "" })}
            commerceEnabled={commerceEnabled}
          />
        )}
      </main>
      {showNav && (
        <nav className={"bottom-nav" + (navHidden ? " hidden" : "")}>
          {/* Toss 하단 네비 5슬롯 구조(홈/혜택/쇼핑/증권/전체)를 따르되,
              우리 서비스에 없는 목적지는 구매 관련 화면으로 대체한다.
              홈=앱 루트(쇼핑 홈), 혜택=특가 탭 진입, 쇼핑=쇼핑 서비스 루트(active 슬롯),
              증권→AI(프로젝트 핵심 진입), 전체=메뉴 시트 [Observed 구조 / Project 매핑] */}
          <button
            className={"nav-item" + (activeNavSlot === "home" ? " on" : "")}
            aria-current={activeNavSlot === "home" ? "page" : undefined}
            onClick={() => { setRootNavSlot("home"); goto({ name: "shop", category: "", sub: "" }); }}
          >
            <IcHome size={22} />홈
          </button>
          <button
            className={"nav-item" + (activeNavSlot === "benefit" ? " on" : "")}
            aria-current={activeNavSlot === "benefit" ? "page" : undefined}
            onClick={() => goto({ name: "shop", category: "sale", sub: "" })}
          >
            <IcTag size={22} />혜택
          </button>
          <button
            className={"nav-item" + (activeNavSlot === "shop" ? " on" : "")}
            aria-current={activeNavSlot === "shop" ? "page" : undefined}
            onClick={() => { setRootNavSlot("shop"); goto({ name: "shop", category: "", sub: "" }); }}
          >
            {/* 선택 상태는 채움 아이콘 — Reference의 filled bag [Observed→Project] */}
            {activeNavSlot === "shop" ? <IcBagFill size={22} /> : <IcCart size={22} />}쇼핑
          </button>
          <button
            className={"nav-item" + (activeNavSlot === "ai" ? " on" : "")}
            disabled={!AGENT_TURN_ENABLED}
            title="AI 쇼핑 도우미"
            aria-expanded={agentOpen !== null}
            aria-pressed={activeNavSlot === "ai"}
            onClick={() => setAgentOpen("shopping")}
          >
            <IcSparkle size={22} />AI
            {!AGENT_TURN_ENABLED && <span className="nav-soon">준비중</span>}
          </button>
          <button
            ref={allBtnRef}
            className={"nav-item" + (activeNavSlot === "all" ? " on" : "")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-pressed={activeNavSlot === "all"}
            onClick={() => setMenuOpen(true)}
          >
            <IcMenu size={22} />전체
          </button>
        </nav>
      )}
      {menuOpen && (
        <div className="sheet-overlay" onClick={() => setMenuOpen(false)}>
          <div
            className="sheet menu-sheet"
            role="menu"
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-grabber" />
            {(
              [
                { icon: IcReceipt, label: "내 쇼핑", run: () => goto({ name: "myshop" }) },
                { icon: IcCart, label: "장바구니", run: () => goto({ name: "cart" }) },
                { icon: IcSearch, label: "검색", run: () => goto({ name: "search", query: "" }) },
                { icon: IcSparkle, label: "AI 쇼핑 도우미", run: () => setAgentOpen("shopping"), soon: !AGENT_TURN_ENABLED },
              ] as const
            ).map((m) => (
              <button
                key={m.label}
                className="menu-item"
                role="menuitem"
                disabled={"soon" in m && m.soon}
                title={"soon" in m && m.soon ? "AI 쇼핑 도우미는 아직 준비 중이에요" : undefined}
                onClick={() => {
                  setMenuOpen(false);
                  m.run();
                }}
              >
                <m.icon size={20} />
                {m.label}
                {"soon" in m && m.soon && (
                  <span className="menu-soon">준비중</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {agentOpen && (
        <AgentPanel
          key={userId+":"+agentOpen}
          brain={agentOpen}
          messages={agentMsgs[agentOpen]}
          setMessages={(m) => setAgentMsgs((prev) => ({ ...prev, [agentOpen]: m }))}
          pageContext={pageContext}
          onOpenProduct={(id, variantId) => {
            if (variantId !== undefined) takeDetailResume(id);
            setAgentOpen(null);
            goto({ name: "product", id, variantId });
          }}
          onCartChanged={refreshCart}
          onClose={() => setAgentOpen(null)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
