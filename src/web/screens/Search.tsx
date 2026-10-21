// 검색 화면 — 최근 검색어(recents) / 자동완성(suggest) / 결과(results) 3상태.
// 표시 모드는 입력값과 마지막 제출어 비교로 결정한다. URL의 ?q=는 공유·뒤로가기용.
import { useEffect, useRef, useState } from "react";
import { apiSafe, type ApiResult } from "../api.ts";
import type { SearchResult } from "../../contracts.ts";
import { WishProductCard } from "../components/WishProductCard.tsx";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { Empty, ErrorState } from "../components/CommerceState.tsx";
import { IcBack, IcCart, IcCheck, IcChevronDown, IcClock, IcClose, IcFilter, IcSearch } from "../icons.tsx";
import { groupLabel, rateOf } from "../display-meta.ts";
import { SearchFilterPage } from "./SearchFilter.tsx";
import { loadSearchPages } from "../search-loader.ts";
import {
  filterCountState,
  owned,
  suggestState,
  type Owned,
} from "../search-state.ts";
import {
  applySearchFilter,
  categoriesIn,
  countActiveFilters,
  EMPTY_FILTER,
  type FilterDraft,
} from "../search-filter.ts";

const RECENTS_KEY = "recent-searches";
const loadRecents = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
};
const saveRecents = (list: string[]) =>
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 10)));

type Sort = "RELEVANCE" | "PRICE_ASC";
const SORT_LABEL: Record<Sort, string> = {
  RELEVANCE: "추천순",
  PRICE_ASC: "낮은 가격순",
};
const SORT_DESC: Record<Sort, string> = {
  RELEVANCE: "평점이 높은 상품부터 보여줘요",
  PRICE_ASC: "최저가 옵션 기준으로 정렬해요",
};

// 입력한 부분만 강조 (토스쇼핑 자동완성 패턴)
function Marked({ name, needle }: { name: string; needle: string }) {
  const i = name.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, i)}
      <mark>{name.slice(i, i + needle.length)}</mark>
      {name.slice(i + needle.length)}
    </>
  );
}

export function Search({
  query,
  onBack,
  onSubmit,
  onOpenProduct,
  cartCount = 0,
  onOpenCart,
  userId,
  onOpenWish,
  commerceEnabled,
}: {
  query: string;
  onBack: () => void;
  onSubmit: (q: string) => void;
  onOpenProduct: (id: string) => void;
  cartCount?: number;
  onOpenCart?: () => void;
  userId: string | null;
  onOpenWish: () => void;
  commerceEnabled: boolean;
}) {
  const [text, setText] = useState(query);
  const [submitted, setSubmitted] = useState(query);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  // 응답은 발행 시점의 query와 함께 보관한다 — owner가 현재 query와 다르면
  // 표시·실행 모두 차단(A 결과가 B 입력 아래 남는 경로 차단) [PM].
  const [sugs, setSugs] = useState<Owned<ApiResult<SearchResult>> | null>(null);
  const [res, setRes] = useState<Owned<ApiResult<SearchResult>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [sugTick, setSugTick] = useState(0); // 자동완성 실패 재시도
  const [sort, setSort] = useState<Sort>("RELEVANCE");
  // 적용된 필터 — 전용 필터 화면의 draft와 분리(적용 전 뒤로가기는 폐기) [F02]
  const [applied, setApplied] = useState<FilterDraft>(EMPTY_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 응답 세대 가드 — 정렬/검색어가 바뀐 뒤 도착한 구 응답이 새 결과를 덮지 못한다 [Luna]
  const resSeq = useRef(0);
  const sugSeq = useRef(0);

  // 언마운트 시 진행 중 응답의 재적용을 막는다 [PM].
  useEffect(
    () => () => {
      resSeq.current++;
      sugSeq.current++;
    },
    [],
  );

  // 뒤로가기 등으로 URL의 q가 바뀌면 입력값/제출어를 동기화
  useEffect(() => {
    setText(query);
    setSubmitted(query);
    setApplied(EMPTY_FILTER);
    setFilterOpen(false);
  }, [query]);

  useEffect(() => inputRef.current?.focus(), []);

  // 자동완성 — 입력이 마지막 제출어와 다르고 비어있지 않을 때만
  useEffect(() => {
    if (!text || text === submitted) {
      // 지우기/미제출 전환도 진행 중 응답을 무효화한다 — 시작 시점에만
      // 세대를 올리면 clear 뒤 late 응답이 재적용될 수 있다 [PM].
      sugSeq.current++;
      setSugs(null);
      return;
    }
    const my = ++sugSeq.current;
    const q = text; // 이 응답의 owner — 적용 시점에 입력이 바뀌어 있어도 q에 귀속
    const t = setTimeout(() => {
      apiSafe<SearchResult>("/api/products?query=" + encodeURIComponent(q) + "&limit=5")
        .then((r) => {
          if (sugSeq.current === my) setSugs({ q, r });
        });
    }, 150);
    return () => clearTimeout(t);
  }, [text, submitted, sugTick]);

  // 결과 조회
  useEffect(() => {
    // 미제출 상태로 돌아가도 진행 중 페이지네이션을 무효화한다 [PM].
    if (!submitted) {
      resSeq.current++;
      return;
    }
    setLoading(true);
    const my = ++resSeq.current;
    const q = submitted; // 이 결과의 owner — 제출어가 바뀌면 표시 차단 [PM]
    const base =
      // 카테고리 칩은 상위 그룹(digital/beauty/...)으로, 결과에서 클라이언트 필터한다.
      // 서버 category 파라미터는 단일 값만 받아 monitor가 디지털 그룹에 못 들어가므로 쓰지 않는다.
      // limit=50(서버 최대)으로 커서를 끝까지 따라간다 — 첫 페이지만으로
      // '최종 N개'나 그룹 필터를 계산하면 뒤 페이지 상품이 누락된다 [Luna/PM].
      "/api/products?query=" + encodeURIComponent(submitted) + "&sort=" + sort + "&limit=50";
    (async () => {
      // 커서 추종·계약 방어(has_more+next_cursor 없음/반복 커서/중복 product_id)는
      // loadSearchPages에 위임 — 단위 테스트가 같은 함수를 mock IO로 검증한다 [PM].
      const out = await loadSearchPages(
        base,
        (u) => apiSafe<SearchResult>(u),
        () => resSeq.current !== my,
      );
      if ("stale" in out || resSeq.current !== my) return;
      if (!out.ok) setRes({ q, r: { ok: false, error: out.error } });
      else setRes({ q, r: { ok: true, data: out.data } });
    })().finally(() => {
      if (resSeq.current === my) setLoading(false);
    });
  }, [submitted, sort, tick]);

  const submit = (q: string) => {
    const v = q.trim();
    if (!v) return;
    setText(v);
    setSubmitted(v);
    setRecents((r) => {
      const next = [v, ...r.filter((x) => x !== v)];
      saveRecents(next);
      return next;
    });
    onSubmit(v);
    inputRef.current?.blur();
  };

  const removeRecent = (w: string) =>
    setRecents((r) => {
      const next = r.filter((x) => x !== w);
      saveRecents(next);
      return next;
    });

  const mode =
    text !== submitted ? (text ? "suggest" : "recents") : submitted ? "results" : "recents";

  // 필터 칩·적용은 실제 결과 데이터에 존재하는 값만 사용한다 — 필터 전용
  // 화면(Ref105/106)의 draft는 적용 버튼으로 확정되기 전까지 applied와 분리된다.
  // 현재 제출어 소유가 아닌 결과는 즉시 차단한다 — A 결과가 B 아래 표시되지 않는다.
  const resVisible = owned(res, submitted);
  const resItems = resVisible?.ok ? resVisible.data.items : [];
  const cats = categoriesIn(resItems);
  // PRICE_ASC는 '필터된 variants 최저가'로 재정렬 — 서버의 상품 전체 최저가
  // 정렬은 밴드가 적용되면 표시가와 어긋난다 [PM].
  const shown = applySearchFilter(resItems, applied, {
    minPriceSort: sort === "PRICE_ASC",
  });
  const sugState = suggestState(text, sugs);

  return (
    <div className="search-screen">
      <form
        className="search-head"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <button type="button" className="back-btn" aria-label="뒤로가기" onClick={onBack}>
          <IcBack size={24} />
        </button>
        <div className="search-field">
          <span className="field-ico"><IcSearch size={18} /></span>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="검색어를 입력하세요"
            enterKeyHint="search"
          />
          {text && (
            <button
              type="button"
              className="clear-btn"
              aria-label="지우기"
              onClick={() => {
                setText("");
                inputRef.current?.focus();
              }}
            >
              <IcClose size={10} />
            </button>
          )}
        </div>
        {(
          <button type="button" className="icon-btn" aria-label="장바구니" onClick={onOpenCart}>
            <IcCart size={23} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
        )}
      </form>

      {mode === "recents" && (
        <section className="search-body">
          <h3 className="section-h">최근 검색어</h3>
          {recents.length === 0 ? (
            <p className="muted sm">최근 검색 기록이 없어요</p>
          ) : (
            recents.map((w) => (
              <div key={w} className="recent-row">
                <button className="recent-word" onClick={() => submit(w)}>
                  <IcClock size={18} /> {w}
                </button>
                <button
                  className="rm"
                  aria-label={w + " 삭제"}
                  onClick={() => removeRecent(w)}
                >
                  <IcClose size={14} />
                </button>
              </div>
            ))
          )}
        </section>
      )}

      {mode === "suggest" && (
        <section className="search-body">
          {sugState === "items" && sugs?.r.ok ? (
            sugs.r.data.items.map((p) => (
              <button
                key={p.product_id}
                className="recent-row sug-row"
                onClick={() => submit(p.name)}
              >
                <Marked name={p.name} needle={text} />
              </button>
            ))
          ) : sugState === "error" ? (
            <p className="muted sm">
              자동완성을 불러오지 못했어요{" "}
              <button
                type="button"
                className="retry-inline"
                onClick={() => setSugTick((t) => t + 1)}
              >
                재시도
              </button>
            </p>
          ) : sugState === "empty" ? (
            <p className="muted sm">일치하는 상품명이 없어요</p>
          ) : (
            <p className="muted sm">검색 중…</p>
          )}
        </section>
      )}

      {mode === "results" && (
        <section className="search-body results-zone">
          <div className="chip-row">
            <button
              className={"fchip filter-trigger" + (countActiveFilters(applied) ? " on" : "")}
              onClick={() => {
                inputRef.current?.blur(); // 필터가 열린 뒤에도 검색 입력에 포커스가 남지 않게 [PM]
                setFilterOpen(true);
              }}
            >
              <IcFilter size={15} /> 필터
            </button>
            <button className="fchip sort-trigger" onClick={() => setSortOpen(true)}>
              {SORT_LABEL[sort]} <IcChevronDown size={14} />
            </button>
            <button
              className={"fchip" + (applied.category === null ? " on" : "")}
              onClick={() => setApplied((a) => ({ ...a, category: null }))}
            >
              전체
            </button>
            {cats.map((c) => (
              <button
                key={c}
                className={"fchip" + (applied.category === c ? " on" : "")}
                onClick={() => setApplied((a) => ({ ...a, category: a.category === c ? null : c }))}
              >
                {groupLabel(c)}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="product-grid">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skel-card">
                  <div className="skel-thumb" />
                  <div className="skel-line" />
                  <div className="skel-line sm" />
                </div>
              ))}
            </div>
          ) : !resVisible ? null : !resVisible.ok ? (
            <ErrorState
              text={"조회에 실패했어요 (" + resVisible.error.code + ")"}
              onRetry={() => setTick((t) => t + 1)}
            />
          ) : shown.length === 0 ? (
            <Empty text="조건에 맞는 상품이 없어요" />
          ) : (
            <>
              {/* 할인 배지 출처 안내 — 검색 카드는 카드별 데모 표기가 없으므로
                  결과 영역에서 한 번만 고지한다 [MAJOR073-02]. 배지가 하나도
                  없으면 문구도 숨긴다. */}
              {shown.some((p) => rateOf(p) > 0) && (
                <p className="muted sm search-note">
                  할인율·특가 표시는 데모 정가 기준이며 실제 가격 이력이 아니에요
                </p>
              )}
              <div className="product-grid">
                {shown.map((p) => (
                  <WishProductCard
                    key={p.product_id}
                    p={p}
                    userId={userId}
                    commerceEnabled={commerceEnabled}
                    onOpen={() => onOpenProduct(p.product_id)}
                    onGoWish={onOpenWish}
                    variant="search"
                  />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {sortOpen && (
        <BottomSheet title="정렬" onClose={() => setSortOpen(false)}>
          {(["RELEVANCE", "PRICE_ASC"] as Sort[]).map((s) => (
            <button
              key={s}
              className="sort-item"
              onClick={() => {
                setSort(s);
                setSortOpen(false);
              }}
            >
              <span>
                {SORT_LABEL[s]}
                <span className="desc">{SORT_DESC[s]}</span>
              </span>
              {sort === s && <span className="sort-check"><IcCheck size={18} /></span>}
            </button>
          ))}
        </BottomSheet>
      )}

      {filterOpen && (
        <SearchFilterPage
          items={resItems}
          // 전체 커서를 다 모았을 때만 최종 개수를 약속한다 — 확인 중/실패를 구분 [PM]
          countState={filterCountState(loading, resVisible)}
          onRetry={() => setTick((t) => t + 1)}
          initial={applied}
          onBack={() => setFilterOpen(false)}
          onApply={(f) => {
            setApplied(f);
            setFilterOpen(false);
          }}
        />
      )}
    </div>
  );
}
