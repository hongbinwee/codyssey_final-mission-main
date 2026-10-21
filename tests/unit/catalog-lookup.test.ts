// catalog-lookup — page clamp(50) 하에서 cursor를 따라가는 조회가
// '못 찾은 상품(missing)'·'아직 못 읽은 상품(unread)'·'조회 실패'를 구분하는지
// mock fetcher로 검증한다(DB-free).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { fetchProductsByIds } = await import("../../src/web/catalog-lookup.ts");
import type { ProductSummary } from "../../src/contracts.ts";

const mkItem = (id: string): ProductSummary => ({
  product_id: id,
  name: "상품 " + id,
  brand: "b",
  category: "digital",
  image: null,
  matched_variants: [],
  rating_summary: { avg: null, count: 0 },
  availability: "AVAILABLE",
});

const mkPage = (
  ids: string[],
  next_cursor: string | null,
  has_more: boolean,
) => ({
  ok: true as const,
  data: {
    items: ids.map(mkItem),
    shipping_fee_won: 0,
    next_cursor,
    has_more,
  },
});

describe("fetchProductsByIds", () => {
  test("단일 페이지 — 입력 순서대로 found를 돌려준다", async () => {
    const r = await fetchProductsByIds(["p-b", "p-a"], async () =>
      mkPage(["p-a", "p-b"], null, false),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.found.map((p) => p.product_id), ["p-b", "p-a"]);
      assert.deepEqual(r.missing, []);
      assert.deepEqual(r.unread, []);
    }
  });

  test("cursor를 따라가 다음 페이지의 id도 찾는다", async () => {
    const seen: (string | null)[] = [];
    const r = await fetchProductsByIds(["p-x", "p-49"], async (cursor) => {
      seen.push(cursor);
      if (cursor === null)
        return mkPage(
          Array.from({ length: 50 }, (_, i) => "p-" + i),
          "c50",
          true,
        );
      return mkPage(["p-x"], null, false);
    });
    assert.ok(r.ok);
    assert.deepEqual(seen, [null, "c50"]);
    if (r.ok) {
      assert.deepEqual(r.found.map((p) => p.product_id), ["p-x", "p-49"]);
      assert.deepEqual(r.missing, []);
    }
  });

  test("카탈로그 끝까지 읽어도 없는 id는 missing — 삭제/비활성으로 구분", async () => {
    const r = await fetchProductsByIds(["p-a", "p-gone"], async () =>
      mkPage(["p-a"], null, false),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.found.map((p) => p.product_id), ["p-a"]);
      assert.deepEqual(r.missing, ["p-gone"]);
      assert.deepEqual(r.unread, []);
    }
  });

  test("페이지 상한에 닿으면 남은 id는 missing이 아니라 unread", async () => {
    // has_more가 계속 true인 카탈로그 — 40페이지 후 중단해야 한다.
    let calls = 0;
    const r = await fetchProductsByIds(["p-never"], async (cursor) => {
      calls++;
      return mkPage(["p-x"], "c" + calls, true);
    });
    assert.ok(r.ok);
    assert.equal(calls, 40, "상한까지 읽고 멈춰야 한다");
    if (r.ok) {
      assert.deepEqual(r.missing, [], "미완료 조회를 missing으로 오표기 금지");
      assert.deepEqual(r.unread, ["p-never"]);
    }
  });

  test("반복 커서는 즉시 멈추고 남은 id를 unread로 보존한다", async () => {
    let calls = 0;
    const r = await fetchProductsByIds(["p-never"], async () => {
      calls++;
      return mkPage(["p-other"], "repeat", true);
    });
    assert.equal(calls, 2, "반복 커서에서 세 번째 페이지를 요청하지 않는다");
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.missing, []);
      assert.deepEqual(r.unread, ["p-never"]);
    }
  });

  test("has_more인데 next_cursor가 없으면 미완료로 분류한다", async () => {
    const r = await fetchProductsByIds(["p-never"], async () =>
      mkPage(["p-other"], null, true),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.missing, []);
      assert.deepEqual(r.unread, ["p-never"]);
    }
  });

  test("조회 실패는 ok:false — found/missing과 구분된다", async () => {
    const r = await fetchProductsByIds(["p-a"], async () => ({
      ok: false as const,
      error: { code: "NETWORK", message: "fail" },
    }));
    assert.equal(r.ok, false);
  });

  test("원하는 id를 모두 찾으면 이후 페이지를 읽지 않는다", async () => {
    let calls = 0;
    const r = await fetchProductsByIds(["p-1"], async () => {
      calls++;
      return mkPage(["p-1"], "more", true);
    });
    assert.equal(calls, 1);
    assert.ok(r.ok);
  });

  test("빈 입력은 fetch 없이 빈 결과", async () => {
    let calls = 0;
    const r = await fetchProductsByIds([], async () => {
      calls++;
      return mkPage([], null, false);
    });
    assert.equal(calls, 0);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.found, []);
  });
});
