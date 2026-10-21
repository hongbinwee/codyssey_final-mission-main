// src/catalog.ts getReviews의 DB-free 정렬 검증 — 실제 exported service에
// mock db를 주입해 ORDER BY 매핑·VALIDATION·상속키 거절·기본값을 회귀한다
// [PMQA-068 — PM 선제 지적: REVIEW_ORDER[sort]는 'toString' 등 상속키를
// truthy로 통과시키므로 Object.hasOwn own-property 검사가 필수].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getReviews } from "../../src/catalog.ts";

type Call = { q: string; params: unknown[] | undefined };

// reviews SELECT에는 reviewRows를, 상품/옵션 존재 확인에는 [{id}]를 돌려주는
// 최소 mock. 쿼리 문자열은 검증용으로 전부 기록한다.
const mkDb = (reviewRows: unknown[] = []) => {
  const calls: Call[] = [];
  const db = {
    unsafe: async (q: string, params?: unknown[]) => {
      calls.push({ q, params });
      if (q.includes("FROM public.reviews")) return reviewRows;
      return [{ id: "x" }];
    },
  };
  return { db, calls };
};

const lastQuery = (calls: Call[]) => calls.at(-1)!.q;

describe("getReviews sort [PMQA-068]", () => {
  test("sort 생략 → 기본 최신순 ORDER BY written_at DESC + id tie-break", async () => {
    const { db, calls } = mkDb();
    const r = await getReviews({ product_id: "p-t" }, db as never);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.sort, "LATEST");
    assert.ok(lastQuery(calls).includes("ORDER BY written_at DESC, id"));
  });

  test("RATING_DESC → rating DESC + written_at/id tie-break, 결과에 sort echo", async () => {
    const { db, calls } = mkDb();
    const r = await getReviews({ product_id: "p-t", sort: "RATING_DESC" }, db as never);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.sort, "RATING_DESC");
    assert.ok(lastQuery(calls).includes("ORDER BY rating DESC, written_at DESC, id"));
  });

  test("RATING_ASC → rating ASC + written_at/id tie-break", async () => {
    const { db, calls } = mkDb();
    const r = await getReviews({ product_id: "p-t", sort: "RATING_ASC" }, db as never);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.sort, "RATING_ASC");
    assert.ok(lastQuery(calls).includes("ORDER BY rating ASC, written_at DESC, id"));
  });

  test("미지원 sort → VALIDATION + 어떤 쿼리도 실행하지 않는다", async () => {
    for (const bad of ["RECOMMENDED", "BEST", "latest", ""]) {
      const { db, calls } = mkDb();
      const r = await getReviews({ product_id: "p-t", sort: bad }, db as never);
      assert.equal(r.ok, false, "sort=" + JSON.stringify(bad));
      if (r.ok) return;
      assert.equal(r.error.code, "VALIDATION");
      assert.equal(calls.length, 0, "거절은 쿼리 실행 전이어야 한다");
    }
  });

  test("상속키 sort(toString/constructor/__proto__) → VALIDATION + 쿼리 0회", async () => {
    // PMQA-068 선제 지적 — REVIEW_ORDER[key] 인덱싱은 상속 속성을 truthy로
    // 통과시켜 깨진 ORDER BY가 실제 쿼리로 나가는 결함이 있었다.
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const { db, calls } = mkDb();
      const r = await getReviews({ product_id: "p-t", sort: bad }, db as never);
      assert.equal(r.ok, false, "sort=" + bad);
      if (r.ok) return;
      assert.equal(r.error.code, "VALIDATION");
      assert.equal(calls.length, 0);
    }
  });

  test("variant_id 조합 — 존재 확인 후 리뷰 SELECT에도 같은 정렬이 적용된다", async () => {
    const { db, calls } = mkDb();
    const r = await getReviews(
      { product_id: "p-t", variant_id: "v-t", sort: "RATING_DESC" },
      db as never,
    );
    assert.equal(r.ok, true);
    assert.equal(calls.length, 3, "상품+옵션 존재 확인 + 리뷰 SELECT");
    assert.ok(lastQuery(calls).includes("ORDER BY rating DESC, written_at DESC, id"));
  });

  test("상품 없음 → NOT_FOUND (정렬과 무관한 기존 계약 보존)", async () => {
    const empty = { unsafe: async () => [] };
    const r = await getReviews({ product_id: "none" }, empty as never);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, "NOT_FOUND");
  });

  // 서버가 이미 정렬해 돌려준 결과라고 가정하는 5행 — mock은 DB가 ORDER BY를
  // 적용한 뒤의 행 순서만 제공하고, slice/커서/echo 계약은 실제 service가
  // 수행한다. 정렬 알고리즘을 테스트용으로 복제하지 않는다. 실제 SQL 정렬
  // 실행·잠금은 DB 통합 NOT_RUN으로 분리한다.
  const sortedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: "r-" + i,
      product_id: "p-t",
      variant_id: null,
      rating: 5 - i,
      body: "body " + i,
      source_kind: i % 2 === 0 ? "SYNTHETIC" : "REAL",
      source_ref: "test",
      written_at: "2026-01-0" + (i + 1) + "T00:00:00Z",
    }));

  test("5행 limit=2 → 첫 페이지 slice·total_matching·sort·출처 보존", async () => {
    const { db, calls } = mkDb(sortedRows(5));
    const r = await getReviews({ product_id: "p-t", sort: "RATING_DESC", limit: 2 }, db as never);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.sort, "RATING_DESC");
    assert.equal(r.data.total_matching, 5);
    assert.equal(r.data.returned_count, 2);
    assert.deepEqual(r.data.reviews.map((x) => x.id), ["r-0", "r-1"]);
    assert.ok(r.data.has_more);
    assert.ok(r.data.next_cursor !== null);
    assert.ok(lastQuery(calls).includes("ORDER BY rating DESC, written_at DESC, id"));
    // REAL/SYNTHETIC 출처 칩 계약은 매핑을 거쳐도 유지된다.
    assert.equal(r.data.reviews[0].source_kind, "SYNTHETIC");
    assert.equal(r.data.reviews[1].source_kind, "REAL");
  });

  test("next_cursor → 다음 페이지는 나머지 행을 같은 정렬로 slice한다", async () => {
    const rows = sortedRows(5);
    const { db } = mkDb(rows);
    const first = await getReviews({ product_id: "p-t", sort: "RATING_DESC", limit: 2 }, db as never);
    assert.equal(first.ok, true);
    if (!first.ok || !first.data.next_cursor) return;
    const second = await getReviews(
      { product_id: "p-t", sort: "RATING_DESC", limit: 2, cursor: first.data.next_cursor },
      db as never,
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.data.sort, "RATING_DESC");
    assert.equal(second.data.total_matching, 5);
    assert.deepEqual(second.data.reviews.map((x) => x.id), ["r-2", "r-3"]);
    assert.ok(second.data.has_more);
  });
});
