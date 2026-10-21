import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transpileModule, JsxEmit, ModuleKind } from "typescript";
import type { ProductSummary } from "../../src/contracts.ts";

const tsxHook = registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext },
      }).outputText,
    };
  },
});

const displayMeta = await import("../../src/web/display-meta.ts");
const commerceUi = await import("../../src/web/commerce-ui.ts");
const navState = await import("../../src/web/bottom-nav-state.ts");
const { WishProductCard } = await import(
  "../../src/web/components/WishProductCard.tsx"
);
tsxHook.deregister();

function product(
  category: string,
  specs: Record<string, string>,
): ProductSummary {
  return {
    product_id: "fixture-product",
    name: "fixture",
    brand: "fixture",
    category,
    image: null,
    matched_variants: [
      {
        variant_id: "fixture-variant",
        option_values: {},
        effective_specs: specs,
        unit_price_won: 1000,
        stock_qty: 4,
        availability: "AVAILABLE",
        version: 1,
      },
    ],
    rating_summary: { avg: null, count: 0 },
    availability: "AVAILABLE",
  };
}

test("demo catalog categories classify from category and option specs, not product IDs", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../db/seeds/demo-catalog.json", import.meta.url), "utf8"),
  ) as { products: Array<{ category: string; specs: Record<string, string> }> };
  const unmatched = fixture.products.filter((item) => {
    const group = displayMeta.groupOf(item.category);
    return !displayMeta.SUBCATS[group]?.some((sub) =>
      sub.matches(product(item.category, item.specs)),
    );
  });
  assert.deepEqual(unmatched, []);
  assert.ok(displayMeta.SUBCATS.beauty.every((sub) => !("productIds" in sub)));
});

function findV4ProductsSnapshot(): string | undefined {
  const relative = [
    ".local-data",
    "v4-20261018-w01-20261018-190515-6435eb82",
    "database_exports",
    "toss",
    "test_items",
    "products.jsonl",
  ];
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, ...relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

const v4ProductsSnapshot = findV4ProductsSnapshot();
test(
  "v4 synthetic 180 product JSONL maps source subcategories and preserves empty-category counts",
  { skip: !v4ProductsSnapshot },
  () => {
    const rows = readFileSync(v4ProductsSnapshot!, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        id: string;
        name: string;
        category: string;
        specs_json: Record<string, string> | string;
      });
    const summaries = rows.map((row) => {
      const specs = typeof row.specs_json === "string"
        ? JSON.parse(row.specs_json) as Record<string, string>
        : row.specs_json;
      return {
        ...product(row.category, specs),
        product_id: row.id,
        name: row.name,
      };
    });
    const counts = Object.fromEntries(
      displayMeta.SUBCATS.beauty.map((sub) => [
        sub.id,
        summaries.filter((summary) => sub.matches(summary)).length,
      ]),
    );

    assert.equal(summaries.length, 180);
    assert.deepEqual(counts, {
      sun: 0,
      skincare: 100,
      cleansing: 0,
      makeup: 80,
    });
  },
);

test("monitor category metadata maps into the digital monitor subcategory", () => {
  const monitor = product("monitor", { resolution: "4K", refresh_rate: "144Hz" });
  assert.equal(displayMeta.groupOf(monitor.category), "digital");
  assert.equal(
    displayMeta.SUBCATS.digital.find((sub) => sub.id === "monitor")?.matches(monitor),
    true,
  );
});

test("Commerce stays disabled until a public catalog context is confirmed", () => {
  assert.equal(commerceUi.isCommerceEnabled(null), false);
  assert.equal(commerceUi.isCommerceEnabled({ read_only: true, is_simulated: true }), false);
  assert.equal(commerceUi.isCommerceEnabled({ read_only: false, is_simulated: false }), true);
});

test("read-only variant labels never expose the stock count", () => {
  assert.equal(commerceUi.variantStockLabel("AVAILABLE", 17, true), "시연 옵션 · 주문 불가");
  assert.equal(commerceUi.variantStockLabel("SOLD_OUT", 0, true), "품절");
  assert.equal(commerceUi.variantStockLabel("UNAVAILABLE", 17, true), "판매 중단");
  assert.equal(commerceUi.variantStockLabel("AVAILABLE", 17, false), "구매 가능");
  assert.doesNotMatch(commerceUi.stockSafeErrorMessage("OUT_OF_STOCK", "재고가 부족합니다 (남은 수량 17)"), /17/);
  assert.equal(commerceUi.stockSafeErrorMessage("VERSION_CONFLICT", "다시 확인"), "다시 확인");
});

test("bottom navigation active slot follows category, AI panel, and menu state", () => {
  assert.equal(navState.activeBottomNavSlot("shop", "", null, false, "shop"), "shop");
  assert.equal(navState.activeBottomNavSlot("shop", "", null, false, "home"), "home");
  assert.equal(navState.activeBottomNavSlot("shop", "", null, false), "home");
  assert.equal(navState.activeBottomNavSlot("shop", "sale", null, false), "benefit");
  assert.equal(navState.activeBottomNavSlot("shop", "beauty", null, false), "shop");
  assert.equal(navState.activeBottomNavSlot("shop", "", "shopping", false), "ai");
  assert.equal(navState.activeBottomNavSlot("shop", "", null, true), "all");
  assert.equal(navState.activeBottomNavSlot("cart", "", null, false), null);
});

test("read-only product cards keep visible controls without allowing a wishlist write", () => {
  const html = renderToStaticMarkup(
    createElement(WishProductCard, {
      p: product("beauty", { spf: "SPF50+" }),
      userId: "fixture-user",
      commerceEnabled: false,
      onOpen: () => {},
      onGoWish: () => {},
    }),
  );
  assert.match(html, /wish-heart/);
  assert.match(html, /card-cart/);
  assert.match(html, /disabled=""/);
  assert.match(html, /조회 전용 QA/);
});
