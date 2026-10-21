import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const DATABASE_NAME = "toss_v4_test_items_20261018_w01";
const DATABASE_PORT = "15440";
export const V4_IMPORT_SCHEMA = "test_items" as const;
type V4Table = "products" | "product_variants" | "reviews";
const DEFAULT_COUNTS = { products: 180, variants: 180, reviews: 4737 } as const;
const SOURCE_HASHES = {
  "products.jsonl": "9b0fc3cde856fb18843e3e705720a592c948382d198c8cda6cbb8ba9be91105c",
  "product_variants.jsonl": "df9275269b24bb8f79bf7888201e4cff11b0eddf4983f47b3396701c94936a5c",
  "reviews.jsonl": "f508406edd228addaf55274e81876d2580397a17c91adbb5dbbe2e88e73cc3d9",
} as const;

type Counts = { products: number; variants: number; reviews: number };
type Product = {
  id: string; name: string; brand: string; category: string; description: string;
  image_urls: string[]; specs_json: Record<string, postgres.JSONValue>; active: boolean; version: number;
};
type Variant = {
  id: string; product_id: string; option_values_json: Record<string, postgres.JSONValue>;
  spec_overrides_json: Record<string, postgres.JSONValue>; unit_price_won: number;
  stock_qty: number; active: boolean; version: number;
};
type Review = {
  id: string; product_id: string; variant_id: string | null; rating: number;
  body: string; source_kind: "SYNTHETIC"; source_ref: string; written_at: string;
};
type V4Dataset = { products: Product[]; variants: Variant[]; reviews: Review[] };

class ImportError extends Error {}

export function v4ImportTable(table: V4Table): string {
  return `${V4_IMPORT_SCHEMA}.${table}`;
}

export function validateV4ExpectedDataDirectory(raw: string | undefined): string {
  if (!raw) fail("V4_EXPECTED_DATA_DIRECTORY is required");
  if (!isAbsolute(raw)) fail("V4_EXPECTED_DATA_DIRECTORY must be an absolute path");
  return resolve(raw);
}

export function isV4LocalServerAddress(address: string | null): boolean {
  return address === "127.0.0.1";
}

function fail(message: string): never {
  throw new ImportError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    fail(`${label} has an unexpected schema`);
  }
}

function requireString(value: unknown, label: string, nonEmpty = false): asserts value is string {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    fail(`${label} must be ${nonEmpty ? "a non-empty " : "a "}string`);
  }
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
}

function requireInteger(value: unknown, label: string, minimum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${label} must be an integer greater than or equal to ${minimum}`);
  }
}

function requireJsonObject(value: unknown, label: string): asserts value is Record<string, postgres.JSONValue> {
  if (!isRecord(value)) fail(`${label} must be a JSON object`);
  try {
    JSON.stringify(value);
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function validateRows(data: unknown): V4Dataset {
  if (!isRecord(data) || !Array.isArray(data.products) || !Array.isArray(data.variants) || !Array.isArray(data.reviews)) {
    fail("dataset must contain products, variants, and reviews arrays");
  }

  const productKeys = ["id", "name", "brand", "category", "description", "image_urls", "specs_json", "active", "version"];
  const variantKeys = ["id", "product_id", "option_values_json", "spec_overrides_json", "unit_price_won", "stock_qty", "active", "version"];
  const reviewKeys = ["id", "product_id", "variant_id", "rating", "body", "source_kind", "source_ref", "written_at"];

  for (const [index, row] of data.products.entries()) {
    const label = `products[${index}]`;
    requireKeys(row, productKeys, label);
    requireString(row.id, `${label}.id`, true);
    requireString(row.name, `${label}.name`);
    requireString(row.brand, `${label}.brand`);
    requireString(row.category, `${label}.category`);
    requireString(row.description, `${label}.description`);
    if (!Array.isArray(row.image_urls) || row.image_urls.some((image) => typeof image !== "string")) {
      fail(`${label}.image_urls must be an array of strings`);
    }
    requireJsonObject(row.specs_json, `${label}.specs_json`);
    requireBoolean(row.active, `${label}.active`);
    requireInteger(row.version, `${label}.version`, 1);
  }

  for (const [index, row] of data.variants.entries()) {
    const label = `variants[${index}]`;
    requireKeys(row, variantKeys, label);
    requireString(row.id, `${label}.id`, true);
    requireString(row.product_id, `${label}.product_id`, true);
    requireJsonObject(row.option_values_json, `${label}.option_values_json`);
    requireJsonObject(row.spec_overrides_json, `${label}.spec_overrides_json`);
    requireInteger(row.unit_price_won, `${label}.unit_price_won`, 0);
    requireInteger(row.stock_qty, `${label}.stock_qty`, 0);
    requireBoolean(row.active, `${label}.active`);
    requireInteger(row.version, `${label}.version`, 1);
  }

  for (const [index, row] of data.reviews.entries()) {
    const label = `reviews[${index}]`;
    requireKeys(row, reviewKeys, label);
    requireString(row.id, `${label}.id`, true);
    requireString(row.product_id, `${label}.product_id`, true);
    if (row.variant_id !== null) requireString(row.variant_id, `${label}.variant_id`, true);
    requireInteger(row.rating, `${label}.rating`, 1);
    if ((row.rating as number) > 5) fail(`${label}.rating must be between 1 and 5`);
    requireString(row.body, `${label}.body`);
    if (row.source_kind !== "SYNTHETIC") fail(`${label}.source_kind must be SYNTHETIC`);
    requireString(row.source_ref, `${label}.source_ref`);
    requireString(row.written_at, `${label}.written_at`, true);
    if (!Number.isFinite(Date.parse(row.written_at))) fail(`${label}.written_at must be a valid timestamp`);
  }

  return data as V4Dataset;
}

export function validateV4Dataset(data: unknown, expectedCounts: Counts = DEFAULT_COUNTS): Counts {
  for (const key of ["products", "variants", "reviews"] as const) {
    requireInteger(expectedCounts[key], `expectedCounts.${key}`, 0);
  }
  const rows = validateRows(data);
  const counts = {
    products: rows.products.length,
    variants: rows.variants.length,
    reviews: rows.reviews.length,
  };
  for (const key of ["products", "variants", "reviews"] as const) {
    if (counts[key] !== expectedCounts[key]) {
      fail(`${key} count mismatch: expected ${expectedCounts[key]}, received ${counts[key]}`);
    }
  }

  const productIds = new Set<string>();
  for (const product of rows.products) {
    if (productIds.has(product.id)) fail(`duplicate product id: ${product.id}`);
    productIds.add(product.id);
  }
  const variantsById = new Map<string, Variant>();
  for (const variant of rows.variants) {
    if (variantsById.has(variant.id)) fail(`duplicate variant id: ${variant.id}`);
    if (!productIds.has(variant.product_id)) fail(`variant ${variant.id} references a missing product`);
    variantsById.set(variant.id, variant);
  }
  const reviewIds = new Set<string>();
  for (const review of rows.reviews) {
    if (reviewIds.has(review.id)) fail(`duplicate review id: ${review.id}`);
    reviewIds.add(review.id);
    if (!productIds.has(review.product_id)) fail(`review ${review.id} references a missing product`);
    if (review.variant_id !== null) {
      const variant = variantsById.get(review.variant_id);
      if (!variant || variant.product_id !== review.product_id) {
        fail(`review ${review.id} references a missing or mismatched variant`);
      }
    }
  }
  return counts;
}

export function validateLocalV4DatabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("V4_IMPORT_DATABASE_URL is not a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail("V4_IMPORT_DATABASE_URL must use PostgreSQL");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())) {
    fail("database host must be loopback");
  }
  if (url.port !== DATABASE_PORT) fail(`database port must be ${DATABASE_PORT}`);
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    fail("database name in V4_IMPORT_DATABASE_URL is invalid");
  }
  if (database !== DATABASE_NAME || url.pathname.split("/").length !== 2) {
    fail(`database name must be ${DATABASE_NAME}`);
  }
  if (url.search || url.hash) fail("database URL query and fragment are not allowed");
  return url;
}

function canonical(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail("cannot fingerprint an invalid date");
    return JSON.stringify(value.toISOString());
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("cannot fingerprint a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  fail("cannot fingerprint a non-JSON value");
}

export function fingerprintRows(rows: readonly unknown[]): string {
  const normalized = rows.map(canonical).sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function assertV4JsonbShapes(
  rows: readonly Record<string, unknown>[],
  shapes: Readonly<Record<string, "array" | "object">>,
): void {
  for (const row of rows) {
    for (const [field, shape] of Object.entries(shapes)) {
      const value = row[field];
      const valid = shape === "array" ? Array.isArray(value) : isRecord(value);
      if (!valid) fail(`database returned a non-${shape} JSONB value for ${field}`);
    }
  }
}

export function normalizeV4ReviewTimestamps<T extends { written_at: string | Date }>(
  rows: readonly T[],
): Array<Omit<T, "written_at"> & { written_at: Date }> {
  return rows.map((row) => {
    const value = row.written_at;
    const timestamp = value instanceof Date ? value : new Date(value as string);
    if (!Number.isFinite(timestamp.getTime())) fail("database returned an invalid review timestamp");
    return { ...row, written_at: timestamp };
  });
}

function readJsonl(directory: string, filename: keyof typeof SOURCE_HASHES): unknown[] {
  const filePath = resolve(directory, filename);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    fail(`${filename} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${filename} must be a regular file`);
  const bytes = readFileSync(filePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== SOURCE_HASHES[filename]) fail(`${filename} SHA-256 does not match the approved source`);
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${filename} is not valid UTF-8`);
  }
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim().length === 0)) fail(`${filename} contains an empty JSONL row`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      fail(`${filename} contains invalid JSON on line ${index + 1}`);
    }
  });
}

function readApprovedDataset(inputDirectory: string): V4Dataset {
  const directory = resolve(inputDirectory);
  if (!isAbsolute(inputDirectory)) fail("--input-dir must be an absolute path");
  return validateRows({
    products: readJsonl(directory, "products.jsonl"),
    variants: readJsonl(directory, "product_variants.jsonl"),
    reviews: readJsonl(directory, "reviews.jsonl"),
  });
}

function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).replaceAll("/", "\\").toLowerCase() === resolve(right).replaceAll("/", "\\").toLowerCase();
}

export function buildV4Insert<
  Row extends { [Key in keyof Row]: postgres.JSONValue },
  BoundValue extends postgres.ParameterOrJSON<never>,
>(
  table: V4Table,
  columns: readonly (keyof Row & string)[],
  rows: readonly Row[],
  jsonColumns: readonly (keyof Row & string)[],
  bindJson: (value: postgres.JSONValue) => BoundValue,
): { query: string; values: postgres.ParameterOrJSON<never>[] } {
  const values: postgres.ParameterOrJSON<never>[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      const value = row[column];
      values.push(jsonColumns.includes(column) ? bindJson(value) : value);
      const placeholder = `$${values.length}`;
      return jsonColumns.includes(column) ? `${placeholder}::jsonb` : placeholder;
    });
    return `(${placeholders.join(", ")})`;
  });
  return {
    query: `INSERT INTO ${v4ImportTable(table)} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
    values,
  };
}

async function importIntoLocalDatabase(dataset: V4Dataset): Promise<void> {
  const rawUrl = process.env.V4_IMPORT_DATABASE_URL;
  if (!rawUrl) fail("set V4_IMPORT_DATABASE_URL through the approved local secret file");
  const url = validateLocalV4DatabaseUrl(rawUrl);
  const expectedDataDirectory = validateV4ExpectedDataDirectory(process.env.V4_EXPECTED_DATA_DIRECTORY);
  const client = postgres(url.toString(), { max: 1, connect_timeout: 5, idle_timeout: 5 });
  try {
    const [server] = await client.unsafe<{
      database: string; port: string; server_address: string | null; data_directory: string;
    }[]>(`SELECT current_database() AS database, current_setting('port') AS port,
      host(inet_server_addr()) AS server_address, current_setting('data_directory') AS data_directory`);
    if (server.database !== DATABASE_NAME) fail("connected database does not match the approved Commerce database");
    if (server.port !== DATABASE_PORT) fail("connected PostgreSQL server is not on the approved port");
    if (!isV4LocalServerAddress(server.server_address)) fail("connected PostgreSQL server is not bound to 127.0.0.1");
    if (!sameWindowsPath(server.data_directory, expectedDataDirectory)) fail("connected PostgreSQL data directory does not match this local dataset workspace");

    await client.begin(async (tx) => {
      const [relations] = await tx.unsafe<{
        products: string | null; variants: string | null; reviews: string | null;
        public_products: string | null; public_variants: string | null; public_reviews: string | null;
      }[]>(`SELECT to_regclass('test_items.products')::text AS products,
        to_regclass('test_items.product_variants')::text AS variants,
        to_regclass('test_items.reviews')::text AS reviews,
        to_regclass('public.products')::text AS public_products,
        to_regclass('public.product_variants')::text AS public_variants,
        to_regclass('public.reviews')::text AS public_reviews`);
      if (!relations.products || !relations.variants || !relations.reviews) {
        fail("required test_items catalog tables are missing");
      }
      if (!relations.public_products || !relations.public_variants || !relations.public_reviews) {
        fail("required public Commerce tables are missing");
      }
      await tx.unsafe("LOCK TABLE test_items.products, test_items.product_variants, test_items.reviews, public.products, public.product_variants, public.reviews IN SHARE ROW EXCLUSIVE MODE");
      const [existing] = await tx.unsafe<{ products: number; variants: number; reviews: number }[]>(
        `SELECT (SELECT count(*)::int FROM test_items.products) AS products,
          (SELECT count(*)::int FROM test_items.product_variants) AS variants,
          (SELECT count(*)::int FROM test_items.reviews) AS reviews`,
      );
      if (existing.products !== 0 || existing.variants !== 0 || existing.reviews !== 0) {
        fail("test_items target tables must be empty before import");
      }
      const [publicExisting] = await tx.unsafe<{ products: number; variants: number; reviews: number }[]>(
        `SELECT (SELECT count(*)::int FROM public.products) AS products,
          (SELECT count(*)::int FROM public.product_variants) AS variants,
          (SELECT count(*)::int FROM public.reviews) AS reviews`,
      );
      if (publicExisting.products !== 0 || publicExisting.variants !== 0 || publicExisting.reviews !== 0) {
        fail("public catalog tables must remain empty for the test_items import");
      }

      const bindJson = (value: postgres.JSONValue) => tx.json(value);
      const productInsert = buildV4Insert("products", [
        "id", "name", "brand", "category", "description", "image_urls", "specs_json", "active", "version",
      ], dataset.products, ["image_urls", "specs_json"], bindJson);
      const variantInsert = buildV4Insert("product_variants", [
        "id", "product_id", "option_values_json", "spec_overrides_json", "unit_price_won", "stock_qty", "active", "version",
      ], dataset.variants, ["option_values_json", "spec_overrides_json"], bindJson);
      const reviewInsert = buildV4Insert("reviews", [
        "id", "product_id", "variant_id", "rating", "body", "source_kind", "source_ref", "written_at",
      ], dataset.reviews, [], bindJson);
      await tx.unsafe(productInsert.query, productInsert.values);
      await tx.unsafe(variantInsert.query, variantInsert.values);
      await tx.unsafe(reviewInsert.query, reviewInsert.values);

      const [counts] = await tx.unsafe<Counts[]>(
        `SELECT (SELECT count(*)::int FROM test_items.products) AS products,
          (SELECT count(*)::int FROM test_items.product_variants) AS variants,
          (SELECT count(*)::int FROM test_items.reviews) AS reviews`,
      );
      validateV4Dataset(dataset, counts);
      const [products, variants, reviews] = await Promise.all([
        tx.unsafe<Product[]>("SELECT id, name, brand, category, description, image_urls, specs_json, active, version FROM test_items.products"),
        tx.unsafe<Variant[]>("SELECT id, product_id, option_values_json, spec_overrides_json, unit_price_won, stock_qty, active, version FROM test_items.product_variants"),
        tx.unsafe<Review[]>("SELECT id, product_id, variant_id, rating, body, source_kind, source_ref, written_at FROM test_items.reviews"),
      ]);
      assertV4JsonbShapes(products, { image_urls: "array", specs_json: "object" });
      assertV4JsonbShapes(variants, { option_values_json: "object", spec_overrides_json: "object" });
      const normalizedSourceReviews = normalizeV4ReviewTimestamps(dataset.reviews);
      const normalizedReviews = normalizeV4ReviewTimestamps(reviews);
      for (const key of ["products", "variants", "reviews"] as const) {
        const expected = { products: dataset.products, variants: dataset.variants, reviews: normalizedSourceReviews }[key];
        const actual = { products, variants, reviews: normalizedReviews }[key];
        if (fingerprintRows(expected) !== fingerprintRows(actual)) {
          fail(`${key} verification fingerprint does not match the approved source`);
        }
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

function parseArguments(args: string[]): { inputDirectory: string; validateOnly: boolean } {
  let inputDirectory: string | undefined;
  let validateOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input-dir" && args[i + 1]) {
      inputDirectory = args[i + 1];
      i += 1;
    } else if (args[i] === "--validate-only") {
      validateOnly = true;
    } else {
      fail("usage: node scripts/import-v4-local.ts --input-dir <absolute-path> [--validate-only]");
    }
  }
  if (!inputDirectory || !isAbsolute(inputDirectory)) {
    fail("--input-dir must be an absolute path");
  }
  return { inputDirectory, validateOnly };
}

async function main(): Promise<void> {
  const { inputDirectory, validateOnly } = parseArguments(process.argv.slice(2));
  const dataset = readApprovedDataset(inputDirectory);
  const counts = validateV4Dataset(dataset);
  const fingerprints = {
    products: fingerprintRows(dataset.products),
    variants: fingerprintRows(dataset.variants),
    reviews: fingerprintRows(dataset.reviews),
  };
  if (!validateOnly) await importIntoLocalDatabase(dataset);
  process.stdout.write(`${validateOnly ? "Validated" : "Imported and verified"} approved local v4 dataset: `
    + `${counts.products} products, ${counts.variants} variants, ${counts.reviews} reviews\n`
    + `Fingerprints: products=${fingerprints.products} variants=${fingerprints.variants} reviews=${fingerprints.reviews}\n`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  main().catch((error: unknown) => {
    if (error instanceof ImportError) {
      process.stderr.write(`Import failed: ${error.message}\n`);
    } else {
      const code = isRecord(error) && typeof error.code === "string" ? ` (${error.code})` : "";
      process.stderr.write(`Import failed during local database operation${code}. Details omitted.\n`);
    }
    process.exitCode = 1;
  });
}
