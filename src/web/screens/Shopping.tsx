// 쇼핑 홈 — Toss Shopping 캡처 기준 재구성(04-C).
// 상단 탭은 그룹 필터가 아니라 콘텐츠가 다른 쇼핑 홈들이다:
// 쇼핑 홈/뷰티/식품/카테고리/특가/시즌 추천. 디지털·패션·리빙은 카테고리 탭과
// 숏컷으로 진입하는 리스팅 뷰. 가격·재고·평점은 API가 정본이고
// 정가·배송 라벨·섹션 태그는 display-meta의 표시용 메타다.
import { useEffect, useRef, useState, type ComponentType } from "react";
import { apiSafe, fmtWon, type ApiResult } from "../api.ts";
import type { ProductSummary, SearchResult } from "../../contracts.ts";
import { loadSearchPages } from "../search-loader.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { WishProductCard } from "../components/WishProductCard.tsx";
import { WishButton } from "../components/WishButton.tsx";
import { Empty, ErrorState } from "../components/CommerceState.tsx";
import {
  IcBulb, IcCart, IcChevronRight, IcCup, IcDrop, IcGrid,
  IcMonitor, IcReceipt, IcShirt, IcStar, IcTag,
} from "../icons.tsx";
import {
  CAMPAIGN_GROUPS, CATEGORY_GROUPS, CONTENT_TABS, GROUP_HERO, HOME_HERO,
  PRODUCT_META, SEASONAL, SUBCATS, TOP_TABS, cardMinPriceOf, groupOf,
  groupLabel, productImg, rateOf, subcatOf,
} from "../display-meta.ts";
import type { CategoryGroup } from "../display-meta.ts";

/* ── 히어로 캐러셀 — 카드형(좌 텍스트+우 이미지) / cover형(풀블리드 이미지+하단 텍스트) ── */
function Hero({
  products,
  cover,
  onOpen,
}: {
  products: ProductSummary[];
  cover?: boolean;
  onOpen: (id: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [, setIdx] = useState(0);
  if (!products.length) return null;
  const onScroll = () => {
    const el = trackRef.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first) return;
    const step = first.offsetWidth + 8;
    setIdx(Math.min(products.length - 1, Math.round(el.scrollLeft / step)));
  };
  return (
    <div className="hero-track" ref={trackRef} onScroll={onScroll}>
      {products.map((p, i) => {
        const meta = PRODUCT_META[p.product_id];
        const rate = rateOf(p);
        // 빈 variants는 카드 전용 헬퍼로 '가격 정보 없음' — 전역 minPriceOf의
        // Infinity 계약을 히어로에 새지 않게 한다 [F30]
        const min = cardMinPriceOf(p);
        return (
          <button
            key={p.product_id}
            className={"hero-slide" + (cover ? " cover" : "")}
            onClick={() => onOpen(p.product_id)}
          >
            {cover && <img className="hero-bg" src={productImg(p)} alt="" />}
            <span className="hero-txt">
              {rate > 0 && <b className="hero-rate">{rate}% 특가</b>}
              <b className="hero-name">{p.name}</b>
              <b className="hero-price">
                {min === null ? "가격 정보 없음" : fmtWon(min)}
              </b>
              <span className="hero-sub">
                {[p.brand, meta?.delivery].filter(Boolean).join(" · ")}
              </span>
            </span>
            {!cover && <img className="hero-img" src={productImg(p)} alt={p.name} />}
            <span className="hero-idx">{i + 1}|{products.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── 리스트형 딜 카드 — 특가/시즌 탭의 큰 이미지 카드 [Observed 34/50] ── */
function DealCard({ p, dealTag, row, onOpen }: { p: ProductSummary; dealTag?: string; row?: boolean; onOpen: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const meta = PRODUCT_META[p.product_id];
  const rate = rateOf(p);
  // 빈 variants는 카드 전용 nullable 헬퍼로 '가격 정보 없음' [F30] —
  // 전역 minPriceOf(빈 배열 → Infinity) 계약과 hero 표시 경로는 건드리지 않는다.
  const min = cardMinPriceOf(p);
  return (
    <button className={"deal-card" + (row ? " row" : "")} onClick={onOpen}>
      <div className="deal-thumb">
        {imgErr ? (
          <span className="thumb-fallback">{p.name.slice(0, 1)}</span>
        ) : (
          <img src={productImg(p)} alt={p.name} loading="lazy" onError={() => setImgErr(true)} />
        )}
        {rate > 0 && (
          <span className="thumb-badge">{dealTag ? dealTag + " " + rate + "%" : rate + "% 특가"}</span>
        )}
        <span className="deal-cart" aria-hidden><IcCart size={18} /></span>
      </div>
      <div className="deal-info">
        <div className="deal-name">{p.name}</div>
        <div className="deal-price">
          {/* 하루 특가: 가격+정가취소선 [Observed 35] / 시즌 가로행: 할인율+가격 [Observed 50] */}
          {row && rate > 0 && <span className="price-rate">{rate}%</span>}
          {min === null ? (
            <span className="price-none">가격 정보 없음</span>
          ) : (
            fmtWon(min)
          )}
          {!row && rate > 0 && meta?.original_price_won && (
            <span className="price-orig">{fmtWon(meta.original_price_won)}</span>
          )}
        </div>
        {p.rating_summary.avg !== null && (
          <div className="product-meta">
            <IcStar size={12} /> {p.rating_summary.avg}{" "}
            <span className="muted">({p.rating_summary.count})</span>
          </div>
        )}
      </div>
    </button>
  );
}

/* ── 서브카테고리 아이템 (원형/스퀘어 아이콘 + 라벨) ── */
function SubcatItem({
  groupId,
  subId,
  square,
  items,
  onNav,
}: {
  groupId: string;
  subId: string;
  square?: boolean;
  items: ProductSummary[];
  onNav: (cat: string, sub?: string) => void;
}) {
  const s = subcatOf(groupId, subId);
  const [imgErr, setImgErr] = useState(false);
  const rep = s ? items.find((item) => s.matches(item)) : undefined;
  const count = s ? items.filter((item) => s.matches(item)).length : 0;
  useEffect(() => setImgErr(false), [rep?.product_id]);
  if (!s) return null;
  return (
    <button
      className="sub-item"
      aria-label={`${s.label} ${count}개 상품`}
      onClick={() => onNav(groupId, s.id)}
    >
      <span className={"sub-circle" + (square ? " sq" : "")}>
        {rep && !imgErr ? (
          <img
            src={productImg(rep)}
            alt=""
            loading="lazy"
            onError={() => setImgErr(true)}
          />
        ) : (
          <span className="sub-icon-fallback" aria-hidden="true">
            {s.label.slice(0, 1)}
          </span>
        )}
      </span>
      <span className="sub-label">{s.label}</span>
      <span className="sub-count">{count}개</span>
    </button>
  );
}

/* ── 뷰 ───────────────────────────────────────────────── */

function HomeView({
  items,
  userName,
  onNav,
  onOpen,
  onOpenOrders,
  onOpenCart,
  userId,
  onGoWish,
  commerceEnabled,
  complete,
}: {
  complete: boolean;
  items: ProductSummary[];
  userName: string;
  onNav: (cat: string, sub?: string) => void;
  onOpen: (id: string) => void;
  onOpenOrders: () => void;
  onOpenCart: () => void;
  userId: string | null;
  onGoWish: () => void;
  commerceEnabled: boolean;
}) {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const hero = HOME_HERO.map((id) => byId.get(id)).filter(Boolean) as ProductSummary[];
  const maxRate = Math.max(0, ...items.map(rateOf));
  // 정적 추천 — 그룹별 recommended 우선 정렬 후 카테고리 라운드로빈.
  // 홈 첫 화면이 디지털 등 한 카테고리로 치우치지 않게 섞는다 [Observed: 원본은 식품·생활 중심 혼합].
  const GROUP_ORDER = ["food", "beauty", "living", "digital", "fashion"];
  const buckets = new Map<string, ProductSummary[]>();
  for (const p of items) {
    const g = groupOf(p.category);
    const arr = buckets.get(g);
    if (arr) arr.push(p);
    else buckets.set(g, [p]);
  }
  for (const arr of buckets.values()) {
    arr.sort(
      (a, b) =>
        (PRODUCT_META[b.product_id]?.sections?.includes("recommended") ? 1 : 0) -
        (PRODUCT_META[a.product_id]?.sections?.includes("recommended") ? 1 : 0),
    );
  }
  const keys = [
    ...GROUP_ORDER.filter((g) => buckets.has(g)),
    ...[...buckets.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];
  const ordered: ProductSummary[] = [];
  for (let i = 0, more = true; more; i++) {
    more = false;
    for (const g of keys) {
      const p = buckets.get(g)![i];
      if (p) {
        ordered.push(p);
        more = true;
      }
    }
  }
  const shortcuts: { icon: ComponentType<{ size?: number }>; label: string; run: () => void }[] = [
    { icon: IcGrid, label: "카테고리", run: () => onNav("category") },
    { icon: IcTag, label: "특가", run: () => onNav("sale") },
    { icon: IcDrop, label: "뷰티", run: () => onNav("beauty") },
    { icon: IcCup, label: "식품", run: () => onNav("food") },
    { icon: IcMonitor, label: "디지털", run: () => onNav("digital") },
    { icon: IcShirt, label: "패션", run: () => onNav("fashion") },
    { icon: IcBulb, label: "리빙", run: () => onNav("living") },
    { icon: IcReceipt, label: "내 주문", run: onOpenOrders },
    { icon: IcCart, label: "장바구니", run: onOpenCart },
  ];
  return (
    <>
      <Hero products={hero} onOpen={onOpen} />
      <button className="benefit" onClick={() => onNav("sale")}>
        <b>특가 · 배송 혜택 모아보기</b>
        {complete && <span className="benefit-chip">최대 {maxRate}%</span>}
      </button>
      <div className="shortcut-rail">
        {shortcuts.map((s) => (
          <button key={s.label} className="sc-item" onClick={s.run}>
            <span className="sc-ico"><s.icon size={24} /></span>
            <span className="sc-label">{s.label}</span>
          </button>
        ))}
      </div>
      {/* 카드의 조회수·최저가는 SYNTHETIC 데모 지표 — 섹션에 데모임을 표시한다 */}
      <h3 className="section-h rec-h">
        {userName}님을 위한 추천 상품
        <span className="demo-chip" title="카드의 조회수·최저가 표시는 시연용 합성 지표입니다">
          데모 지표
        </span>
      </h3>
      <div className="product-grid">
        {ordered.map((p) => (
          <WishProductCard
            key={p.product_id}
            p={p}
            userId={userId}
            commerceEnabled={commerceEnabled}
            onOpen={() => onOpen(p.product_id)}
            onGoWish={onGoWish}
          />
        ))}
      </div>
    </>
  );
}

function GroupHome({
  cat,
  items,
  userName,
  onNav,
  onOpen,
  userId,
  onGoWish,
  commerceEnabled,
}: {
  cat: string;
  items: ProductSummary[];
  userName: string;
  onNav: (cat: string, sub?: string) => void;
  onOpen: (id: string) => void;
  userId: string | null;
  onGoWish: () => void;
  commerceEnabled: boolean;
}) {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const hero = (GROUP_HERO[cat] ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean) as ProductSummary[];
  const subs = SUBCATS[cat] ?? [];
  const gItems = items.filter((i) => groupOf(i.category) === cat);
  return (
    <>
      {/* 뷰티=정사각 커버 [Observed 26], 식품=카드형 가로 히어로 [Observed 27] */}
      <Hero products={hero} cover={cat === "beauty"} onOpen={onOpen} />
      {subs.length > 0 && (
        <div className="icon-rail">
          {subs.map((s) => (
            <SubcatItem key={s.id} groupId={cat} subId={s.id} square items={items} onNav={onNav} />
          ))}
        </div>
      )}
      <h3 className="section-h rec-h">
        {userName}님을 위한 {groupLabel(cat)} 추천
        <span className="demo-chip" title="카드의 조회수·최저가 표시는 시연용 합성 지표입니다">
          데모 지표
        </span>
        {/* 식품 홈 추천은 가로 레일 + 우측 전체보기 [Observed 27] */}
        {cat === "food" && (
          <button className="sec-more" onClick={() => onNav(cat, "all")}>
            전체보기 <IcChevronRight size={14} />
          </button>
        )}
      </h3>
      {gItems.length === 0 ? (
        <Empty text="이 카테고리의 상품이 아직 없어요" />
      ) : cat === "food" ? (
        <div className="prod-rail">
          {gItems.map((p) => (
            <WishProductCard
              key={p.product_id}
              p={p}
              userId={userId}
              commerceEnabled={commerceEnabled}
              onOpen={() => onOpen(p.product_id)}
              onGoWish={onGoWish}
            />
          ))}
        </div>
      ) : (
        <div className="product-grid">
          {gItems.map((p) => (
            <WishProductCard
              key={p.product_id}
              p={p}
              userId={userId}
              commerceEnabled={commerceEnabled}
              onOpen={() => onOpen(p.product_id)}
              onGoWish={onGoWish}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CategoryBrowser({
  items,
  onNav,
}: {
  items: ProductSummary[];
  onNav: (cat: string, sub?: string) => void;
}) {
  // [Observed 28~31] Reference 고정 순서 식품→리빙(생활용품)→패션→뷰티(+디지털).
  // 이 브라우저 안에서만 사용하는 표시 순서 — 전역 CATEGORY_GROUPS/홈/검색은 바꾸지 않는다.
  const GROUPS = ["food", "living", "fashion", "beauty", "digital"]
    .map((id) => CATEGORY_GROUPS.find((x) => x.id === id))
    .filter(Boolean) as CategoryGroup[];
  const [g, setG] = useState(GROUPS[0].id);
  // [Observed 28~31] 좌측 레일은 우측 '연속 그룹 섹션'의 스크롤 위치만 맞춘다.
  // 우 pane이 독립 스크롤해 windowY=0을 유지 — header/topTabs/globalnav가 사라지지 않는다.
  const secRefs = useRef<Record<string, HTMLElement | null>>({});
  const paneRef = useRef<HTMLDivElement>(null);
  const spyLock = useRef(0);
  const go = (id: string) => {
    setG(id);
    spyLock.current = Date.now() + 600;
    const pane = paneRef.current;
    const el = secRefs.current[id];
    if (pane && el)
      pane.scrollTo({
        top: el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop,
        behavior: "smooth",
      });
  };
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const spy = () => {
      if (Date.now() < spyLock.current) return;
      const pt = pane.getBoundingClientRect().top;
      let cur = GROUPS[0].id;
      for (const grp of GROUPS) {
        const el = secRefs.current[grp.id];
        if (el && el.getBoundingClientRect().top - pt <= 12) cur = grp.id;
      }
      // 마지막 그룹은 아래 여백이 부족해 head가 목표 위치에 못 올 수 있다 —
      // scroll clamp 상태에서도 레일이 직전 그룹으로 되돌아가지 않게 한다.
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2)
        cur = GROUPS[GROUPS.length - 1].id;
      setG((prev) => (prev === cur ? prev : cur));
    };
    pane.addEventListener("scroll", spy, { passive: true });
    return () => pane.removeEventListener("scroll", spy);
  }, []);
  return (
    <div className="cat-browser">
      <div className="cat-rail">
        {GROUPS.map((x) => (
          <button
            key={x.id}
            className={"cat-rail-i" + (x.id === g ? " on" : "")}
            onClick={() => go(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="cat-pane" ref={paneRef}>
        {GROUPS.map((grp) => (
          <section
            key={grp.id}
            className="cat-sec"
            ref={(el) => {
              secRefs.current[grp.id] = el;
            }}
          >
            <div className="cat-pane-head">
              <b>{groupLabel(grp.id)}</b>
              <button className="cat-all" onClick={() => onNav(grp.id)}>
                전체보기 <IcChevronRight size={14} />
              </button>
            </div>
            <div className="sub-grid">
              {(SUBCATS[grp.id] ?? []).map((s) => (
                <SubcatItem
                  key={s.id}
                  groupId={grp.id}
                  subId={s.id}
                  items={items}
                  onNav={onNav}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SaleView({
  items,
  sub,
  onNav,
  onOpen,
  userId,
  onGoWish,
  commerceEnabled,
}: {
  items: ProductSummary[];
  sub: string;
  onNav: (cat: string, sub?: string) => void;
  onOpen: (id: string) => void;
  userId: string | null;
  onGoWish: () => void;
  commerceEnabled: boolean;
}) {
  const deals = items.filter(
    (i) =>
      i.availability !== "SOLD_OUT" &&
      PRODUCT_META[i.product_id]?.sections?.includes("flash-sale"),
  );
  const promo = deals[0];
  // 기획전 서브탭 — 세일 섹션 안의 캠페인 그룹 모음 [Observed 48]
  const campaign = sub === "campaign";
  const byId = new Map(items.map((i) => [i.product_id, i]));
  return (
    <>
      {/* 상단 프로모 카드 + 보조 탭 [Observed 34]. 미지원 탭은 disabled로 Demo임을 드러낸다. */}
      {!campaign && promo && (
        <button className="sale-promo" onClick={() => onOpen(promo.product_id)}>
          <span className="sp-txt">
            <b>
              데모 특가
              <br />
              상품 모음
            </b>
            <span className="sp-sub">데모 특가 상품 모음</span>
          </span>
          <img src={productImg(promo)} alt="" />
        </button>
      )}
      <nav className="sale-tabs">
        <button
          className={"sale-tab" + (!campaign ? " on" : "")}
          onClick={() => onNav("sale")}
        >
          하루 특가
        </button>
        <button className="sale-tab" disabled title="준비 중">
          셀러 특가
        </button>
        <button
          className={"sale-tab" + (campaign ? " on" : "")}
          onClick={() => onNav("sale", "campaign")}
        >
          기획전
        </button>
        <button className="sale-tab" disabled title="준비 중">
          쿠폰 혜택
        </button>
      </nav>
      {campaign ? (
        // 캠페인 그룹 — 기존 정적 메타의 재구성이며 기간·할인 주장은 없다 [Observed 48]
        CAMPAIGN_GROUPS.map((g) => {
          const gItems = (
            g.productIds
              ? g.productIds.map((id) => byId.get(id))
              : items.filter((i) => groupOf(i.category) === g.group)
          ).filter(Boolean) as ProductSummary[];
          if (!gItems.length) return null;
          return (
            <section key={g.id} className="camp-sec">
              <h3 className="section-h">
                {g.title}
                <span
                  className="demo-chip"
                  title="시연용 정적 기획전 모음이며 실제 캠페인 기간·할인율이 아닙니다"
                >
                  데모
                </span>
              </h3>
              <p className="camp-sub muted">{g.sub}</p>
              <div className="prod-rail">
                {gItems.map((p) => (
                  <WishProductCard
                    key={p.product_id}
                    p={p}
                    userId={userId}
                    commerceEnabled={commerceEnabled}
                    onOpen={() => onOpen(p.product_id)}
                    onGoWish={onGoWish}
                  />
                ))}
              </div>
              <button
                className="camp-more"
                onClick={() => onNav(g.more.cat, g.more.sub)}
              >
                {g.title} 더보기
              </button>
            </section>
          );
        })
      ) : (
        <>
          <div className="sale-timer">
            <IcTag size={15} />
            <b>데모 특가</b>
            <span>실제 종료 시각은 없어요</span>
          </div>
          <h2 className="sale-title">특가 상품을 모았어요</h2>
          {deals.map((p) => (
            <div key={p.product_id} className="wish-cell">
              <DealCard p={p} dealTag="특가" onOpen={() => onOpen(p.product_id)} />
              <WishButton
                className="wish-heart"
                userId={userId}
                commerceEnabled={commerceEnabled}
                product={{
                  product_id: p.product_id,
                  name: p.name,
                  image: p.image,
                  price_won: cardMinPriceOf(p),
                }}
                onGoWish={onGoWish}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
}

function SeasonView({
  items,
  userName,
  onOpen,
  userId,
  onGoWish,
  commerceEnabled,
}: {
  items: ProductSummary[];
  userName: string;
  onOpen: (id: string) => void;
  userId: string | null;
  onGoWish: () => void;
  commerceEnabled: boolean;
}) {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const picks = SEASONAL.map((id) => byId.get(id)).filter(Boolean) as ProductSummary[];
  // F30 — 원본은 추천 그룹과 별도 특가 그룹의 경계가 있다 [Observed 50].
  // 특가는 PRODUCT_META sections.flash-sale 지원 상품만 — 실랭킹/개인화 주장 금지.
  const deals = items.filter((p) =>
    PRODUCT_META[p.product_id]?.sections?.includes("flash-sale"),
  );
  const heroP = byId.get("p-d-lamp-2");
  return (
    <>
      <div className="season-hero">
        <span className="season-txt">
          <b>쌀쌀해지는 계절</b>
          <b>홈카페 · 무드등 기획전</b>
          <span>따뜻하게 준비하는 우리 집</span>
        </span>
        {heroP && <img className="season-img" src={productImg(heroP)} alt="" />}
      </div>
      {/* 정적 데모 큐레이션 — 개인화 추천 결과가 아님을 섹션에 표시한다 [F30] */}
      <h3 className="section-h rec-h">
        <em className="accent">{userName}</em>님이 좋아할 만한 상품
        <span className="demo-chip" title="시연용 정적 큐레이션이며 개인화 추천 결과가 아닙니다">
          데모 큐레이션
        </span>
      </h3>
      {picks.length === 0 ? (
        <Empty text="추천할 상품이 아직 없어요" />
      ) : (
        picks.map((p) => (
          <div key={p.product_id} className="wish-cell">
            <DealCard p={p} row onOpen={() => onOpen(p.product_id)} />
            <WishButton
              className="wish-heart"
              userId={userId}
              commerceEnabled={commerceEnabled}
              product={{
                product_id: p.product_id,
                name: p.name,
                image: p.image,
                price_won: cardMinPriceOf(p),
              }}
              onGoWish={onGoWish}
            />
          </div>
        ))
      )}
      {/* 추천 그룹과 특가 그룹의 경계선 [Observed 50] */}
      <hr className="sec-div" />
      {/* '인기 특가'의 실랭킹 주장은 정직한 데모 라벨로 대체한다 [F30] */}
      <h3 className="section-h rec-h">
        특가 상품
        <span className="demo-chip" title="시연용 정적 특가 모음이며 인기 순위가 아닙니다">
          데모 특가
        </span>
      </h3>
      {deals.length === 0 ? (
        <Empty text="지금 진행 중인 특가가 없어요" />
      ) : (
        deals.map((p) => (
          <div key={p.product_id} className="wish-cell">
            <DealCard p={p} row onOpen={() => onOpen(p.product_id)} />
            <WishButton
              className="wish-heart"
              userId={userId}
              commerceEnabled={commerceEnabled}
              product={{
                product_id: p.product_id,
                name: p.name,
                image: p.image,
                price_won: cardMinPriceOf(p),
              }}
              onGoWish={onGoWish}
            />
          </div>
        ))
      )}
    </>
  );
}

function ListView({
  cat,
  sub,
  items,
  onNav,
  onOpen,
  userId,
  onGoWish,
  commerceEnabled,
}: {
  cat: string;
  sub: string;
  items: ProductSummary[];
  onNav: (cat: string, sub?: string) => void;
  onOpen: (id: string) => void;
  userId: string | null;
  onGoWish: () => void;
  commerceEnabled: boolean;
}) {
  const sc = sub ? subcatOf(cat, sub) : undefined;
  const list = sc
    ? items.filter((i) => sc.matches(i))
    : items.filter((i) => groupOf(i.category) === cat);
  // 첫 로컬탭 '추천'은 그룹 전체 목록에서 recommended 태그 상품을 앞에 둔다
  // [Observed 100 첫 탭 / Project 정렬]. 실제 랭킹·개인화 주장은 없다.
  if (!sc) {
    list.sort(
      (a, b) =>
        (PRODUCT_META[b.product_id]?.sections?.includes("recommended") ? 1 : 0) -
        (PRODUCT_META[a.product_id]?.sections?.includes("recommended") ? 1 : 0),
    );
  }
  const subs = SUBCATS[cat] ?? [];
  return (
    <>
      {/* 리스트 전용 로컬 서브탭 — 글로벌 쇼핑탭 대신 그룹 내 전환 [Observed 100] */}
      {subs.length > 0 && (
        <nav className="list-tabs">
          <button
            className={"list-tab" + (!sc ? " on" : "")}
            onClick={() => onNav(cat, "all")}
          >
            추천
          </button>
          {subs.map((s) => (
            <button
              key={s.id}
              className={"list-tab" + (sc?.id === s.id ? " on" : "")}
              onClick={() => onNav(cat, s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      )}
      <h3 className="section-h list-h">
        {sc ? sc.label : groupLabel(cat)}
        <span className="muted cnt">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <Empty text="조건에 맞는 상품이 없어요" />
      ) : (
        <div className="product-grid">
          {list.map((p) => (
            <WishProductCard
              key={p.product_id}
              p={p}
              userId={userId}
              commerceEnabled={commerceEnabled}
              onOpen={() => onOpen(p.product_id)}
              onGoWish={onGoWish}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function Shopping({
  category,
  sub,
  userName,
  onNav,
  onOpenProduct,
  onOpenOrders,
  onOpenCart,
  userId,
  onOpenWish,
  commerceEnabled,
}: {
  category: string;
  sub: string;
  userName: string;
  onNav: (cat: string, sub?: string) => void;
  onOpenProduct: (id: string) => void;
  onOpenOrders: () => void;
  onOpenCart: () => void;
  userId: string | null;
  onOpenWish: () => void;
  commerceEnabled: boolean;
}) {
  const [res, setRes] = useState<ApiResult<SearchResult> | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setRes(null);
    void (async () => {
      const result = await loadSearchPages(
        "/api/products?limit=50",
        (url) => apiSafe<SearchResult>(url),
        () => !active,
        (data) => { if (active) setRes({ ok: true, data }); },
      );
      if (!active || "stale" in result) return;
      setRes(
        result.ok
          ? { ok: true, data: result.data }
          : { ok: false, error: result.error },
      );
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [tick]);

  const items = res?.ok ? res.data.items : [];

  // 상단 탭 활성 상태 — 그룹 리스팅 진입 시 해당 콘텐츠 탭을 유지한다.
  const grp = groupOf(category);
  const activeTab =
    !category ? ""
    : category === "sale" ? "sale"
    : category === "season" ? "season"
    : category === "category" ? "category"
    : grp === "beauty" ? "beauty"
    : grp === "food" ? "food"
    : "category";

  // 선택된 상단 탭이 가로 스크롤 밖에 있으면 scrollLeft만 조정해 가시화한다.
  // scrollIntoView는 탭 스트립이 세로 fold 밖이면 페이지 세로 위치까지 움직일 수 있고,
  // offsetLeft는 offsetParent 기준이라 컨테이너와 어긋날 수 있어
  // getBoundingClientRect 차이로 계산한다 [Project]
  const tabsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const navEl = tabsRef.current;
    if (!navEl) return;
    const tabEl = navEl.querySelector<HTMLElement>(".shop-tab.on");
    if (!tabEl) return;
    const left =
      navEl.scrollLeft +
      (tabEl.getBoundingClientRect().left - navEl.getBoundingClientRect().left) -
      (navEl.clientWidth - tabEl.clientWidth) / 2;
    navEl.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [activeTab]);

  const view =
    !category ? "home"
    : category === "sale" ? "sale"
    : category === "season" ? "season"
    : category === "category" ? "category"
    : sub ? "list"
    : CONTENT_TABS.has(grp) ? "cathome"
    : "list";

  return (
    <div className="screen">
      {/* 리스트 뷰는 전용 헤더(.list-head)+로컬 서브탭을 쓰므로
          글로벌 쇼핑 탭을 렌더하지 않는다 [Observed 100 / F31] */}
      {view !== "list" && (
        <nav className="shop-tabs" ref={tabsRef}>
          {TOP_TABS.map((t) => (
            <button
              key={t.id}
              className={"shop-tab" + (activeTab === t.id ? " on" : "")}
              onClick={() => onNav(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}

      {loading && res?.ok && <p className="muted sm" role="status">상품을 더 불러오는 중이에요.</p>}
      {loading && (view !== "home" || !res?.ok) ? (
        <div className="product-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skel-card">
              <div className="skel-thumb" />
              <div className="skel-line" />
              <div className="skel-line sm" />
            </div>
          ))}
        </div>
      ) : !res ? null : !res.ok ? (
        <ErrorState
          text={"조회에 실패했어요 (" + res.error.code + ")"}
          onRetry={() => setTick((t) => t + 1)}
        />
      ) : view === "home" ? (
        <HomeView
          complete={!loading}
          items={items}
          userName={userName}
          onNav={onNav}
          onOpen={onOpenProduct}
          onOpenOrders={onOpenOrders}
          onOpenCart={onOpenCart}
          userId={userId}
          onGoWish={onOpenWish}
          commerceEnabled={commerceEnabled}
        />
      ) : view === "cathome" ? (
        <GroupHome
          cat={grp}
          items={items}
          userName={userName}
          onNav={onNav}
          onOpen={onOpenProduct}
          userId={userId}
          onGoWish={onOpenWish}
          commerceEnabled={commerceEnabled}
        />
      ) : view === "category" ? (
        <CategoryBrowser items={items} onNav={onNav} />
      ) : view === "sale" ? (
        <SaleView
          items={items}
          sub={sub}
          onNav={onNav}
          onOpen={onOpenProduct}
          userId={userId}
          onGoWish={onOpenWish}
          commerceEnabled={commerceEnabled}
        />
      ) : view === "season" ? (
        <SeasonView
          items={items}
          userName={userName}
          onOpen={onOpenProduct}
          userId={userId}
          onGoWish={onOpenWish}
          commerceEnabled={commerceEnabled}
        />
      ) : (
        <ListView
          cat={grp}
          sub={sub}
          items={items}
          onNav={onNav}
          onOpen={onOpenProduct}
          userId={userId}
          onGoWish={onOpenWish}
          commerceEnabled={commerceEnabled}
        />
      )}
    </div>
  );
}
