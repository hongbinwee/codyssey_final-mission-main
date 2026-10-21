import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../../src/catalog.ts";

const products = [
  ...Array.from({ length: 60 }, (_, index) => {
    const id = `p-z-digital-${String(index).padStart(3, "0")}`;
    return {
      id, name: id, brand: "test", category: "digital", description: "",
      image_urls: [], specs_json: {}, active: true, version: 1,
    };
  }),
  {
    id: "p-a", name: "recommended monitor", brand: "test", category: "monitor",
    description: "", image_urls: [], specs_json: {}, active: true, version: 1,
  },
  {
    id: "p-d-sun-mineral", name: "beauty skincare", brand: "test",
    category: "beauty", description: "", image_urls: [], specs_json: {},
    active: true, version: 1,
  },
  {
    id: "p-b-beauty", name: "beauty cleansing", brand: "test",
    category: "beauty", description: "", image_urls: [], specs_json: {},
    active: true, version: 1,
  },
];

const variants = products.map((product, index) => ({
  id: `v-${product.id}`, product_id: product.id,
  option_values_json: {},
  spec_overrides_json: product.id === "p-d-sun-mineral"
    ? { sub_category: "스킨케어" }
    : product.id === "p-b-beauty"
      ? { sub_category: "클렌징" }
      : {},
  unit_price_won: product.id === "p-d-sun-mineral" ? 12000 : product.id === "p-a" ? 218000 : 10000,
  stock_qty: 5, active: true, version: 1,
}));

function makeDb() {
  const queries: string[] = [];
  const db = {
    unsafe: async (query: string) => {
      queries.push(query);
      if (query.includes(".products")) return products;
      if (query.includes(".product_variants")) return variants;
      if (query.includes(".reviews")) return [];
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return { db, queries };
}

describe("catalog browse pagination", () => {
  test("filters before paging, keeps global facets, and reuses the readonly snapshot", async () => {
    const { db, queries } = makeDb();
    const catalog = createCatalog("test_items", db as never);

    const first = await catalog.searchProducts({
      browse: true, browse_group: "beauty", limit: 1,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.data.items.map((item) => item.product_id), ["p-b-beauty"]);
    assert.equal(first.data.has_more, true);
    assert.equal(first.data.browse_summary?.total_count, 2);
    assert.equal(first.data.browse_summary?.group_counts.digital, 61);
    assert.equal(first.data.browse_summary?.group_counts.beauty, 2);
    assert.equal(first.data.browse_summary?.subcategory_counts.beauty.skincare, 1);
    assert.equal(first.data.browse_summary?.max_discount_rate, 50);

    const second = await catalog.searchProducts({
      browse: true, browse_group: "beauty", limit: 1,
      cursor: first.data.next_cursor ?? undefined,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(second.data.items.map((item) => item.product_id), ["p-d-sun-mineral"]);
    assert.equal(second.data.has_more, false);
    assert.equal(queries.length, 3);
  });

  test("shares concurrent reads, refreshes after 15 seconds, and clears a rejected snapshot", async () => {
    const { db, queries } = makeDb();
    const catalog = createCatalog("test_items", db as never);
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const [first, concurrent] = await Promise.all([
        catalog.searchProducts({ browse: true }),
        catalog.searchProducts({ browse: true }),
      ]);
      assert.equal(first.ok, true);
      assert.equal(concurrent.ok, true);
      assert.equal(queries.length, 3);

      now += 14_999;
      await catalog.searchProducts({ browse: true });
      assert.equal(queries.length, 3);
      now += 1;
      await catalog.searchProducts({ browse: true });
      assert.equal(queries.length, 6);
    } finally {
      Date.now = realNow;
    }

    const { db: baseDb } = makeDb();
    const baseUnsafe = baseDb.unsafe;
    const retryQueries: string[] = [];
    let failFirst = true;
    const retryDb = {
      unsafe: async (query: string) => {
        retryQueries.push(query);
        if (failFirst) {
          failFirst = false;
          throw new Error("temporary snapshot failure");
        }
        return baseUnsafe(query);
      },
    };
    const retryCatalog = createCatalog("test_items", retryDb as never);
    await assert.rejects(
      retryCatalog.searchProducts({ browse: true }),
      /temporary snapshot failure/,
    );
    const recovered = await retryCatalog.searchProducts({ browse: true });
    assert.equal(recovered.ok, true);
    assert.equal(retryQueries.length, 6);
  });

  test("applies the registered subcategory matcher across the full catalog", async () => {
    const { db } = makeDb();
    const catalog = createCatalog("test_items", db as never);
    const result = await catalog.searchProducts({
      browse: true, browse_group: "beauty", browse_sub: "skincare", limit: 10,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.items.map((item) => item.product_id), ["p-d-sun-mineral"]);
    assert.equal(result.data.browse_summary?.total_count, 1);
    assert.equal(result.data.browse_summary?.subcategory_counts.beauty.cleansing, 1);
  });

  test("preserves raw-category aliases, recommended ordering, and season deal coverage", async () => {
    const { db } = makeDb();
    const catalog = createCatalog("test_items", db as never);
    const monitor = await catalog.searchProducts({ browse: true, browse_group: "monitor", limit: 1 });
    assert.equal(monitor.ok, true);
    if (!monitor.ok) return;
    assert.deepEqual(monitor.data.items.map((item) => item.product_id), ["p-a"]);
    assert.equal(monitor.data.browse_summary?.total_count, 61);

    const season = await catalog.searchProducts({ browse: true, browse_group: "season", limit: 10 });
    assert.equal(season.ok, true);
    if (!season.ok) return;
    assert.deepEqual(season.data.items.map((item) => item.product_id), ["p-d-sun-mineral"]);
  });

  test("rejects ordinary search filters and malformed browse boundaries before querying", async () => {
    const { db, queries } = makeDb();
    const catalog = createCatalog("test_items", db as never);
    const invalidInputs = [
      { query: "soap" },
      { category: "beauty" },
      { max_unit_price_won: 1000 },
      { required_specs: { size: "M" } },
      { sort: "PRICE_ASC" as const },
      { limit: Number.NaN },
      { cursor: "not/a/cursor" },
      { cursor: Buffer.from("99999999999999999999999").toString("base64url") },
    ];

    for (const extra of invalidInputs) {
      const result = await catalog.searchProducts({ browse: true, ...extra });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "VALIDATION");
    }
    assert.equal(queries.length, 0);
  });
});
