// loadSearchPages — PM 지정: 실제 사용 페이지 적재 함수를 mock IO로 검증한다.
// 2페이지 수집·has_more+next_cursor 부재·반복 커서·중간 실패·stale 중단·
// product_id 중복 제거·페이지 상한 — 순수 밴드 테스트와 별개의 적재 계약이다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { loadSearchPages, SEARCH_PAGE_MAX } = await import(
  "../../src/web/search-loader.ts"
);
import type { SearchResult, ProductSummary } from "../../src/contracts.ts";
import type { ApiResult } from "../../src/web/api.ts";

const mkItem = (id: string): ProductSummary => ({
  product_id: id,
  name: id,
  brand: "b",
  category: "digital",
  image: null,
  matched_variants: [],
  rating_summary: { avg: null, count: 0 },
  availability: "AVAILABLE",
});

const page = (
  ids: string[],
  next_cursor: string | null,
  has_more: boolean,
): ApiResult<SearchResult> => ({
  ok: true,
  data: {
    items: ids.map(mkItem),
    shipping_fee_won: 0,
    next_cursor,
    has_more,
  },
});

const fail = (code = "NETWORK"): ApiResult<SearchResult> => ({
  ok: false,
  error: { code, message: "x" },
});

// 호출 URL을 기록하는 mock fetcher — 페이지별 응답을 순서대로 돌려준다.
const fetcher = (pages: ApiResult<SearchResult>[]) => {
  const urls: string[] = [];
  const fn = async (u: string) => {
    urls.push(u);
    const r = pages[urls.length - 1];
    if (!r) throw new Error("unexpected extra fetch: " + u);
    return r;
  };
  return { fn, urls };
};

describe("loadSearchPages", () => {
  test("1,500개 상품의 30페이지를 누락 없이 적재한다", async () => {
    const pages=Array.from({length:30},(_,p)=>page(Array.from({length:50},(_,i)=>`p-${p*50+i}`),p<29?`cursor-${p+1}`:null,p<29));
    const {fn,urls}=fetcher(pages);
    const result=await loadSearchPages("/api/products?limit=50",fn,()=>false);
    assert.ok("ok" in result&&result.ok);
    assert.equal(result.data.items.length,1500);
    assert.equal(urls.length,30);
  });
  test("2페이지 — 커서를 따라가 전체를 모으고 has_more=false로 닫는다", async () => {
    const { fn, urls } = fetcher([
      page(["a", "b"], "c1", true),
      page(["c", "d"], null, false),
    ]);
    const r = await loadSearchPages("b?", fn, () => false);
    assert.equal(urls.length, 2);
    assert.ok(urls[1].includes("cursor=c1"));
    assert.ok("ok" in r && r.ok);
    assert.deepEqual(
      r.data.items.map((i) => i.product_id),
      ["a", "b", "c", "d"],
    );
    assert.equal(r.data.has_more, false);
  });

  test("커서는 URL 인코딩되어 다음 요청에 실린다", async () => {
    const { fn, urls } = fetcher([
      page(["a"], "a+b/c=", true),
      page(["d"], null, false),
    ]);
    await loadSearchPages("b?", fn, () => false);
    assert.ok(urls[1].includes("cursor=" + encodeURIComponent("a+b/c=")));
  });

  test("has_more=true인데 next_cursor 없음 → 계약 오류, 추가 요청 없음", async () => {
    const { fn, urls } = fetcher([page(["a", "b"], null, true)]);
    const r = await loadSearchPages("b?", fn, () => false);
    assert.equal(urls.length, 1);
    assert.ok("ok" in r && !r.ok);
    assert.equal(r.error.code, "CONTRACT");
  });

  test("같은 next_cursor 반복 → 무한 요청 없이 계약 오류로 중단", async () => {
    const { fn, urls } = fetcher([
      page(["a"], "c1", true),
      page(["c"], "c1", true), // 반복 커서
    ]);
    const r = await loadSearchPages("b?", fn, () => false);
    assert.equal(urls.length, 2); // 3번째 요청은 나가지 않는다
    assert.ok("ok" in r && !r.ok);
    assert.equal(r.error.code, "CONTRACT");
  });

  test("중간 페이지 실패 → 실패 봉투를 돌려주고 더 요청하지 않는다", async () => {
    const { fn, urls } = fetcher([
      page(["a"], "c1", true),
      fail("NETWORK"),
    ]);
    const r = await loadSearchPages("b?", fn, () => false);
    assert.equal(urls.length, 2);
    assert.ok("ok" in r && !r.ok);
    assert.equal(r.error.code, "NETWORK");
  });

  test("stale이면 다음 페이지를 요청하지 않고 적용도 하지 않는다", async () => {
    const { fn, urls } = fetcher([
      page(["a"], "c1", true),
      page(["c"], null, false),
    ]);
    let stale = false;
    const wrapped = async (u: string) => {
      const r = await fn(u);
      stale = true; // 첫 응답 직후 stale 전환 — 다음 요청이 나가면 안 된다
      return r;
    };
    const r = await loadSearchPages("b?", wrapped, () => stale);
    assert.equal(urls.length, 1);
    assert.ok("stale" in r);
  });

  test("같은 product_id가 페이지를 넘어 반복돼도 첫 등장만 유지한다", async () => {
    const { fn } = fetcher([
      page(["a", "b"], "c1", true),
      page(["b", "c"], null, false), // b 중복
    ]);
    const r = await loadSearchPages("b?", fn, () => false);
    assert.ok("ok" in r && r.ok);
    assert.deepEqual(
      r.data.items.map((i) => i.product_id),
      ["a", "b", "c"],
    );
  });

  test("커서가 계속 새 값이어도 페이지 상한에서 계약 오류로 멈춘다", async () => {
    const { fn, urls } = fetcher(
      Array.from({ length: SEARCH_PAGE_MAX + 1 }, (_, i) =>
        page(["p" + i], "c" + i, true),
      ),
    );
    const r = await loadSearchPages("b?", fn, () => false);
    assert.equal(urls.length, SEARCH_PAGE_MAX); // 상한에서 중단
    assert.ok("ok" in r && !r.ok);
    assert.equal(r.error.code, "CONTRACT");
  });

  test("단일 페이지(has_more=false)면 1회 요청으로 끝난다", async () => {
    const { fn, urls } = fetcher([page(["a"], null, false)]);
    const r = await loadSearchPages("b?", fn, () => false);
    assert.equal(urls.length, 1);
    assert.ok("ok" in r && r.ok);
    assert.equal(r.data.items.length, 1);
  });
});
