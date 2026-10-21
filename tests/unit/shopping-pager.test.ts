import test from "node:test";
import assert from "node:assert/strict";
import type { ProductSummary } from "../../src/contracts.ts";
import {
  applyBrowsePage,
  browsePageUrl,
  claimBrowseRequest,
  createBrowsePagerState,
  type BrowsePage,
} from "../../src/web/shopping-pager.ts";

const item = (id: string): ProductSummary => ({
  product_id: id,
  name: id,
  brand: "b",
  category: "beauty",
  image: null,
  matched_variants: [],
  rating_summary: { avg: null, count: 0 },
  availability: "AVAILABLE",
});
const page = (ids: string[], next_cursor: string | null, has_more: boolean): BrowsePage => ({
  items: ids.map(item),
  shipping_fee_won: 0,
  next_cursor,
  has_more,
});

test("browse URL includes current raw route filters and an encoded cursor", () => {
  assert.equal(
    browsePageUrl("뷰티", "선케어", "cursor +/"),
    "/api/products?browse=1&browse_group=%EB%B7%B0%ED%8B%B0&browse_sub=%EC%84%A0%EC%BC%80%EC%96%B4&limit=50&cursor=cursor+%2B%2F",
  );
  assert.equal(
    browsePageUrl("", "", null),
    "/api/products?browse=1&browse_group=&browse_sub=&limit=50",
  );
});

test("first page keeps the server total summary while displaying only its 50 items", () => {
  const state = createBrowsePagerState("beauty");
  const result = applyBrowsePage(state, "beauty", null, {
    ...page(Array.from({ length: 50 }, (_, i) => "p-" + i), "c1", true),
    browse_summary: {
      total_count: 180,
      group_counts: { beauty: 180 },
      subcategory_counts: { beauty: { skincare: 100, makeup: 80 } },
      max_discount_rate: 35,
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.items.length, 50);
  assert.equal(result.state.browseSummary?.total_count, 180);
  assert.equal(result.state.nextCursor, "c1");
  assert.equal(result.state.hasMore, true);
});

test("next pages append unique products and preserve the all-catalog total", () => {
  const first = applyBrowsePage(createBrowsePagerState("beauty"), "beauty", null, {
    ...page(Array.from({ length: 50 }, (_, i) => "p-" + i), "c1", true),
    browse_summary: { total_count: 120, group_counts: {}, subcategory_counts: {}, max_discount_rate: 0 },
  }).state;
  const second = applyBrowsePage(first, "beauty", "c1", page(["p-49", ...Array.from({ length: 50 }, (_, i) => "p-" + (50 + i))], "c2", true));
  assert.equal(second.state.items.length, 100);
  assert.equal(second.state.browseSummary?.total_count, 120);
  assert.equal(new Set(second.state.items.map((x) => x.product_id)).size, 100);
});

test("query reset ignores a late response from the previous category, subcategory or user", () => {
  const current = createBrowsePagerState(JSON.stringify(["beauty", "makeup", "user-b"]));
  const late = applyBrowsePage(
    current,
    JSON.stringify(["beauty", "skincare", "user-a"]),
    null,
    page(["old"], null, false),
  );
  assert.equal(late.stale, true);
  assert.deepEqual(late.state.items, []);
});

test("cursor mismatch ignores an out-of-order response without replacing current state", () => {
  const current = applyBrowsePage(createBrowsePagerState("beauty"), "beauty", null, page(["a"], "c2", true)).state;
  const late = applyBrowsePage(current, "beauty", "c1", page(["stale"], null, false));
  assert.equal(late.stale, true);
  assert.deepEqual(late.state.items.map((x) => x.product_id), ["a"]);
});

test("has_more without a cursor and a repeated cursor fail without dropping loaded cards", () => {
  const first = applyBrowsePage(createBrowsePagerState("beauty"), "beauty", null, page(["a"], "c1", true)).state;
  const missing = applyBrowsePage(first, "beauty", "c1", page(["b"], null, true));
  assert.match(missing.error ?? "", /next_cursor/);
  assert.deepEqual(missing.state.items.map((x) => x.product_id), ["a"]);

  const repeated = applyBrowsePage(first, "beauty", "c1", page(["b"], "c1", true));
  assert.match(repeated.error ?? "", /repeated next_cursor/);
  assert.deepEqual(repeated.state.items.map((x) => x.product_id), ["a"]);
});

test("request lock blocks duplicate fetches and releases after failure for retry", () => {
  const inFlight = new Set<string>();
  const release = claimBrowseRequest(inFlight, "beauty", "c1");
  assert.equal(typeof release, "function");
  assert.equal(claimBrowseRequest(inFlight, "beauty", "c1"), undefined);
  release?.();
  assert.equal(typeof claimBrowseRequest(inFlight, "beauty", "c1"), "function");
});
