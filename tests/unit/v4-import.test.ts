import test from "node:test";
import assert from "node:assert/strict";
import {
  assertV4JsonbShapes,
  buildV4Insert,
  fingerprintRows,
  validateLocalV4DatabaseUrl,
  validateV4Dataset,
  validateV4ExpectedDataDirectory,
  isV4LocalServerAddress,
  normalizeV4ReviewTimestamps,
  v4ImportTable,
} from "../../scripts/import-v4-local.ts";

const validData = () => ({
  products: [{
    id: "p-1", name: "Demo", brand: "Brand", category: "beauty", description: "",
    image_urls: ["/demo.webp"], specs_json: { kind: "demo" }, active: true, version: 1,
  }],
  variants: [{
    id: "v-1", product_id: "p-1", option_values_json: { color: "white" },
    spec_overrides_json: {}, unit_price_won: 12000, stock_qty: 3, active: true, version: 1,
  }],
  reviews: [{
    id: "r-1", product_id: "p-1", variant_id: "v-1", rating: 5,
    body: "Synthetic fixture review", source_kind: "SYNTHETIC", source_ref: "fixture",
    written_at: "2026-10-17T00:00:00.000Z",
  }],
});

const oneEach = { products: 1, variants: 1, reviews: 1 };

test("v4 importer targets only the isolated test_items catalog schema", () => {
  assert.deepEqual(
    [v4ImportTable("products"), v4ImportTable("product_variants"), v4ImportTable("reviews")],
    ["test_items.products", "test_items.product_variants", "test_items.reviews"],
  );
});

test("v4 importer requires an explicit absolute PostgreSQL data directory", () => {
  assert.equal(
    validateV4ExpectedDataDirectory("C:\\Users\\proje\\AppData\\Local\\Temp\\pgdata-ascii"),
    "C:\\Users\\proje\\AppData\\Local\\Temp\\pgdata-ascii",
  );
  assert.throws(() => validateV4ExpectedDataDirectory(undefined), /V4_EXPECTED_DATA_DIRECTORY/);
  assert.throws(() => validateV4ExpectedDataDirectory("relative\\pgdata"), /absolute path/);
});

test("v4 importer compares the canonical loopback host, not inet CIDR text", () => {
  assert.equal(isV4LocalServerAddress("127.0.0.1"), true);
  assert.equal(isV4LocalServerAddress("127.0.0.1/32"), false);
  assert.equal(isV4LocalServerAddress("::1"), false);
  assert.equal(isV4LocalServerAddress(null), false);
});

test("v4 importer accepts the exact product/variant/review graph and synthetic rows", () => {
  assert.deepEqual(validateV4Dataset(validData(), oneEach), oneEach);
});

test("v4 importer rejects wrong counts, duplicate IDs, and dangling product or variant IDs", () => {
  assert.throws(() => validateV4Dataset(validData()), /count/i);

  const duplicate = validData();
  duplicate.products.push({ ...duplicate.products[0] });
  assert.throws(() => validateV4Dataset(duplicate, { ...oneEach, products: 2 }), /duplicate/i);

  const missingProduct = validData();
  missingProduct.variants[0].product_id = "missing-product";
  assert.throws(() => validateV4Dataset(missingProduct, oneEach), /product|foreign key/i);

  const crossVariant = validData();
  crossVariant.reviews[0].variant_id = "missing-variant";
  assert.throws(() => validateV4Dataset(crossVariant, oneEach), /variant|foreign key/i);
});

test("v4 importer rejects REAL reviews and malformed source rows", () => {
  const observed = validData();
  observed.reviews[0].source_kind = "REAL";
  assert.throws(() => validateV4Dataset(observed, oneEach), /SYNTHETIC/i);

  const invalidPrice = validData();
  invalidPrice.variants[0].unit_price_won = -1;
  assert.throws(() => validateV4Dataset(invalidPrice, oneEach), /price|unit_price/i);
});

test("v4 importer pins database URL to the planned loopback DB and port", () => {
  const url = validateLocalV4DatabaseUrl(
    "postgres://loader:secret@127.0.0.1:15440/toss_v4_test_items_20261018_w01",
  );
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "15440");
  assert.equal(url.pathname, "/toss_v4_test_items_20261018_w01");

  assert.throws(() => validateLocalV4DatabaseUrl(
    "postgres://loader:secret@db.example:15440/toss_v4_test_items_20261018_w01",
  ), /loopback/i);
  assert.throws(() => validateLocalV4DatabaseUrl(
    "postgres://loader:secret@127.0.0.1:5432/toss_v4_test_items_20261018_w01",
  ), /15440/);
  assert.throws(() => validateLocalV4DatabaseUrl(
    "postgres://loader:secret@127.0.0.1:15440/production",
  ), /database/i);
});

test("canonical row fingerprints ignore row order and JSON key order", () => {
  const first = [{ id: "b", values: { z: 2, a: 1 } }, { id: "a", values: [true, null] }];
  const reordered = [{ id: "a", values: [true, null] }, { values: { a: 1, z: 2 }, id: "b" }];
  assert.equal(fingerprintRows(first), fingerprintRows(reordered));
  assert.notEqual(fingerprintRows(first), fingerprintRows([{ ...first[0], id: "changed" }, first[1]]));
});

test("v4 importer passes raw JSON structures to postgres JSONB binding", () => {
  const bound: unknown[] = [];
  const imageUrls = ["/demo.webp"];
  const specs = { kind: "demo" };
  const insert = buildV4Insert(
    "products",
    ["id", "image_urls", "specs_json"],
    [{ id: "p-1", image_urls: imageUrls, specs_json: specs }],
    ["image_urls", "specs_json"],
    (value) => { bound.push(value); return { jsonb: value }; },
  );
  assert.deepEqual(bound, [imageUrls, specs]);
  assert.deepEqual(insert.values, ["p-1", { jsonb: imageUrls }, { jsonb: specs }]);
  assert.match(insert.query, /\$2::jsonb/);
  assert.match(insert.query, /\$3::jsonb/);
});

test("v4 importer rejects JSONB values returned as strings instead of decoding them", () => {
  assert.doesNotThrow(() => assertV4JsonbShapes(
    [{ image_urls: ["/demo.webp"], specs_json: { kind: "demo" } }],
    { image_urls: "array", specs_json: "object" },
  ));
  assert.throws(() => assertV4JsonbShapes(
    [{ image_urls: "[\"/demo.webp\"]", specs_json: "{\"kind\":\"demo\"}" }],
    { image_urls: "array", specs_json: "object" },
  ), /non-array JSONB value for image_urls/);
});

test("review timestamp fingerprints normalize PostgreSQL Date results and source ISO strings", () => {
  const source = [{ written_at: "2026-08-01T06:00:00Z" }];
  const database = [{ written_at: new Date("2026-08-01T06:00:00.000Z") }];
  assert.equal(fingerprintRows(normalizeV4ReviewTimestamps(source)), fingerprintRows(normalizeV4ReviewTimestamps(database)));
  assert.throws(() => normalizeV4ReviewTimestamps([{ written_at: "invalid" }]), /invalid review timestamp/);
});
