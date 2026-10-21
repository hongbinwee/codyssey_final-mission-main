// 상품·리뷰 조회 서비스. 화면 API와 Agent Tool이 같은 함수를 사용한다.
import { sql } from "./db.ts";
import {
  ok, fail, err,
  type Availability, type MatchedVariant, type ProductDetail,
  type ProductSummary, type ReviewsResult, type SearchResult,
  type ReviewItem, type ReviewSort,
  type ToolResult,
} from "./contracts.ts";
import type { RequestContext } from "./session.ts";
import {
  CAMPAIGN_GROUPS, CATEGORY_GROUPS, PRODUCT_META, SEASONAL, SUBCATS,
  groupOf, rateOf, subcatOf,
} from "./web/display-meta.ts";

export const FLAT_SHIPPING_FEE_WON = 3000;

export type CatalogSource = "public" | "test_items" | "test_items2";
const BROWSE_SNAPSHOT_TTL_MS = 15_000; // ponytail: 15s listing cache only; purchase validation stays fresh.
export function catalogSource(value: unknown): CatalogSource {
  if (value === undefined || value === "" || value === "public") return "public";
  if (value === "test_items" || value === "test_items2") return value;
  throw new Error("unsupported catalog source");
}
const catalogContext = (source: CatalogSource) => source !== "public"
  ? { catalog_context: { source: source as "test_items"|"test_items2", read_only: true as const, is_simulated: true as const } }
  : {};

// Fixed identifiers, not request input or a global search_path change.
export function createCatalog(source: CatalogSource, db: Pick<typeof sql, "unsafe"> = sql) {
  source = catalogSource(source);
  let cachedBrowse: { expiresAt: number; promise: Promise<BrowseSnapshot> } | undefined;
  const getBrowseSnapshot = source === "public"
    ? () => loadBrowseSnapshot(db, source)
    : () => {
      if (cachedBrowse && cachedBrowse.expiresAt > Date.now()) return cachedBrowse.promise;
      const entry = { expiresAt: Number.POSITIVE_INFINITY, promise: loadBrowseSnapshot(db, source) };
      cachedBrowse = entry;
      void entry.promise.then(
        () => { if (cachedBrowse === entry) entry.expiresAt = Date.now() + BROWSE_SNAPSHOT_TTL_MS; },
        () => { if (cachedBrowse === entry) cachedBrowse = undefined; },
      );
      return entry.promise;
    };
  return {
    searchProducts: (input: SearchProductsInput) => searchProducts(
      input, db, source, input.browse ? getBrowseSnapshot : undefined,
    ),
    getProduct: (input: {product_id: string}) => getProduct(input, db, source),
    getReviews: (input: Parameters<typeof getReviews>[0]) => getReviews(input, db, source),
    getReviewsByIds: (input: {product_id: string; review_ids: string[]}) => getReviewsByIds(input, db, source),
  };
}

export function catalogRequestAllowed(source: CatalogSource, method: string, path: string): boolean {
  if (source === "public") return true;
  if (path.startsWith("/api/brain/")) return true; // separately authenticated AI-only storage
  return method === "GET" && (path === "/api/catalog/context" ||
    /^\/api\/products(?:\/[^/]+(?:\/reviews)?)?$/.test(path));
}

export function variantAvailability(
  productActive: boolean,
  variantActive: boolean,
  stock: number,
): Availability {
  if (!productActive || !variantActive) return "UNAVAILABLE";
  return stock > 0 ? "AVAILABLE" : "SOLD_OUT";
}

function productAvailability(vs: { availability: Availability }[]): Availability {
  if (vs.length === 0) return "UNAVAILABLE";
  if (vs.some((v) => v.availability === "AVAILABLE")) return "AVAILABLE";
  if (vs.every((v) => v.availability === "SOLD_OUT")) return "SOLD_OUT";
  return "UNAVAILABLE";
}

// 옵션 유효 스펙 = 상품 스펙 + 옵션 override 병합
export const effectiveSpecs = (
  specs: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> => ({ ...specs, ...overrides });

export function specsMatch(
  required: Record<string, string>,
  eff: Record<string, string>,
): boolean {
  for (const [k, v] of Object.entries(required)) {
    if (eff[k] !== v) return false;
  }
  return true;
}

// 불투명 커서 = offset. ponytail: 내부 구조를 숨기기만 하면 되므로 base64 숫자.
const encCursor = (o: number) => Buffer.from(String(o)).toString("base64url");
const decCursor = (c?: string) => {
  if (!c) return 0;
  if (!/^[A-Za-z0-9_-]+$/.test(c)) return -1;
  const s = Buffer.from(c, "base64url").toString();
  return /^\d+$/.test(s) ? Number(s) : -1;
};

const page = (input: { cursor?: string; limit?: number }) => {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const offset = decCursor(input.cursor);
  return { limit, offset };
};

type VariantRow = {
  id: string; product_id: string; option_values_json: Record<string, string>;
  spec_overrides_json: Record<string, string>; unit_price_won: number;
  stock_qty: number; active: boolean; version: number;
};
type ProductRow = {
  id: string; name: string; brand: string; category: string;
  description: string; image_urls: string[]; specs_json: Record<string, string>;
  active: boolean; version: number;
};
type ReviewRow = {
  id: string; product_id: string; variant_id: string | null; rating: number;
  body: string; source_kind: "REAL" | "SYNTHETIC"; source_ref: string;
  written_at: string;
};

const toVariant = (p: { active: boolean; specs_json: Record<string, string> }, v: VariantRow): MatchedVariant => ({
  variant_id: v.id,
  option_values: v.option_values_json,
  effective_specs: effectiveSpecs(p.specs_json, v.spec_overrides_json),
  unit_price_won: v.unit_price_won,
  stock_qty: v.stock_qty,
  availability: variantAvailability(p.active, v.active, v.stock_qty),
  version: v.version,
});

type BrowseSnapshot = {
  items: ProductSummary[];
  group_counts: Record<string, number>;
  subcategory_counts: Record<string, Record<string, number>>;
  max_discount_rate: number;
};

async function loadBrowseSnapshot(
  db: Pick<typeof sql, "unsafe">,
  source: CatalogSource,
): Promise<BrowseSnapshot> {
  const [products, variants, ratings] = await Promise.all([
    db.unsafe<ProductRow[]>(`SELECT * FROM ${source}.products WHERE active = true ORDER BY id`),
    db.unsafe<VariantRow[]>(`SELECT * FROM ${source}.product_variants WHERE active = true ORDER BY id`),
    db.unsafe<{ product_id: string; avg: number; count: number }[]>(
      `SELECT product_id, avg(rating)::float AS avg, count(*)::int AS count FROM ${source}.reviews GROUP BY product_id`,
    ),
  ]);
  const variantsByPid = new Map<string, VariantRow[]>();
  for (const variant of variants) {
    const productVariants = variantsByPid.get(variant.product_id);
    if (productVariants) productVariants.push(variant);
    else variantsByPid.set(variant.product_id, [variant]);
  }
  const ratingByPid = new Map(ratings.map((rating) => [rating.product_id, rating]));
  const items: ProductSummary[] = products.map((product) => {
    const matched_variants = (variantsByPid.get(product.id) ?? []).map((variant) => toVariant(product, variant));
    const rating = ratingByPid.get(product.id);
    return {
      product_id: product.id,
      name: product.name,
      brand: product.brand,
      category: product.category,
      image: product.image_urls?.[0] ?? null,
      matched_variants,
      rating_summary: rating
        ? { avg: Math.round(rating.avg * 10) / 10, count: rating.count }
        : { avg: null, count: 0 },
      availability: productAvailability(matched_variants),
    };
  });
  items.sort(
    (a, b) =>
      (b.rating_summary.avg ?? 0) - (a.rating_summary.avg ?? 0) ||
      a.product_id.localeCompare(b.product_id),
  );

  const group_counts = Object.create(null) as Record<string, number>;
  const subcategory_counts = Object.create(null) as Record<string, Record<string, number>>;
  for (const group of CATEGORY_GROUPS) group_counts[group.id] = 0;
  for (const [group, subcategories] of Object.entries(SUBCATS)) {
    subcategory_counts[group] = Object.create(null) as Record<string, number>;
    for (const subcategory of subcategories) subcategory_counts[group][subcategory.id] = 0;
  }
  let max_discount_rate = 0;
  for (const item of items) {
    const group = groupOf(item.category);
    group_counts[group] = (group_counts[group] ?? 0) + 1;
    for (const subcategory of SUBCATS[group] ?? []) {
      if (subcategory.matches(item)) subcategory_counts[group][subcategory.id]++;
    }
    max_discount_rate = Math.max(max_discount_rate, rateOf(item));
  }
  return { items, group_counts, subcategory_counts, max_discount_rate };
}

function selectBrowseItems(
  items: ProductSummary[],
  requestedGroup?: string,
  requestedSub?: string,
): ProductSummary[] | undefined {
  const rawGroup = requestedGroup?.trim() ?? "";
  const group = rawGroup && !["category", "sale", "season"].includes(rawGroup)
    ? groupOf(rawGroup)
    : rawGroup;
  const sub = requestedSub?.trim() ?? "";
  if (!group || group === "category") {
    return !sub || sub === "all" ? items : undefined;
  }
  if (group === "sale") {
    if (!sub || sub === "all") {
      return items.filter((item) => item.availability !== "SOLD_OUT" &&
        PRODUCT_META[item.product_id]?.sections?.includes("flash-sale"));
    }
    if (sub !== "campaign") return undefined;
    const campaignIds = new Set(CAMPAIGN_GROUPS.flatMap((campaign) => campaign.productIds ?? []));
    const campaignGroups = new Set(CAMPAIGN_GROUPS.flatMap((campaign) => campaign.group ? [campaign.group] : []));
    return items.filter((item) => campaignIds.has(item.product_id) || campaignGroups.has(groupOf(item.category)));
  }
  if (group === "season") {
    if (sub && sub !== "all") return undefined;
    const seasonalIds = new Set(SEASONAL);
    return items.filter((item) => seasonalIds.has(item.product_id) ||
      PRODUCT_META[item.product_id]?.sections?.includes("flash-sale"));
  }
  if (!sub || sub === "all") {
    const groupItems = items.filter((item) => groupOf(item.category) === group);
    const recommended = (item: ProductSummary) =>
      PRODUCT_META[item.product_id]?.sections?.includes("recommended") ? 1 : 0;
    return groupItems.sort((a, b) => recommended(b) - recommended(a));
  }
  const subcategory = subcatOf(group, sub);
  if (!subcategory) return undefined;
  return items.filter((item) => groupOf(item.category) === group && subcategory.matches(item));
}

const browsePage = (input: SearchProductsInput) => {
  if (input.limit !== undefined && (!Number.isFinite(input.limit) || !Number.isInteger(input.limit))) return undefined;
  const offset = decCursor(input.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return { limit: Math.min(Math.max(input.limit ?? 20, 1), 50), offset };
};

export type SearchProductsInput = {
  query?: string;
  category?: string;
  max_unit_price_won?: number;
  required_specs?: Record<string, string>;
  sort?: "RELEVANCE" | "PRICE_ASC";
  browse?: boolean;
  browse_group?: string;
  browse_sub?: string;
  cursor?: string;
  limit?: number;
};

export async function searchProducts(
  input: SearchProductsInput,
  db: Pick<typeof sql, "unsafe"> = sql,
  source: CatalogSource = "public",
  browseSnapshot?: () => Promise<BrowseSnapshot>,
): Promise<ToolResult<SearchResult>> {
  source = catalogSource(source);
  const trace_id = crypto.randomUUID();
  const browsePageData = input.browse ? browsePage(input) : undefined;
  if (input.browse && !browsePageData)
    return fail(err("VALIDATION", "invalid browse cursor or limit"), trace_id);
  const { limit, offset } = browsePageData ?? page(input);
  if (offset < 0) return fail(err("VALIDATION", "invalid cursor"), trace_id);
  if (input.sort && !["RELEVANCE", "PRICE_ASC"].includes(input.sort))
    return fail(err("VALIDATION", "invalid sort"), trace_id);
  if (
    input.required_specs &&
    Object.entries(input.required_specs).some(
      ([k, v]) => typeof k !== "string" || typeof v !== "string",
    )
  )
    return fail(err("VALIDATION", "required_specs는 문자열 키/값만 허용"), trace_id);
  if (
    input.max_unit_price_won !== undefined &&
    (!Number.isInteger(input.max_unit_price_won) || input.max_unit_price_won < 0)
  )
    return fail(err("VALIDATION", "invalid max_unit_price_won"), trace_id);

  if (input.browse) {
    if (
      input.query?.trim() || input.category?.trim() ||
      input.max_unit_price_won !== undefined ||
      (input.required_specs && Object.keys(input.required_specs).length > 0) ||
      input.sort !== undefined
    )
      return fail(err("VALIDATION", "browse cannot be combined with search filters"), trace_id);
    const snapshot = await (browseSnapshot ?? (() => loadBrowseSnapshot(db, source)))();
    const browseItems = selectBrowseItems(snapshot.items, input.browse_group, input.browse_sub);
    if (!browseItems) return fail(err("VALIDATION", "invalid browse group or subcategory"), trace_id);
    const sliced = browseItems.slice(offset, offset + limit);
    const has_more = offset + limit < browseItems.length;
    return ok(
      {
        items: sliced,
        ...catalogContext(source),
        shipping_fee_won: FLAT_SHIPPING_FEE_WON,
        next_cursor: has_more ? encCursor(offset + limit) : null,
        has_more,
        browse_summary: {
          total_count: browseItems.length,
          group_counts: snapshot.group_counts,
          subcategory_counts: snapshot.subcategory_counts,
          max_discount_rate: snapshot.max_discount_rate,
        },
      },
      trace_id,
    );
  }

  const q = (input.query ?? "").trim();
  const products = await db.unsafe<ProductRow[]>(
    `SELECT * FROM ${source}.products WHERE active = true
      AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR brand ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR category = $2)
      ORDER BY id`,
    [q, input.category ?? null],
  );
  const variants = await db.unsafe<VariantRow[]>(`SELECT * FROM ${source}.product_variants WHERE active = true ORDER BY id`);
  const ratings = await db.unsafe<{ product_id: string; avg: number; count: number }[]>(`SELECT product_id, avg(rating)::float AS avg, count(*)::int AS count FROM ${source}.reviews GROUP BY product_id`);
  const ratingByPid = new Map(ratings.map((r) => [r.product_id, r]));

  let items: ProductSummary[] = [];
  for (const p of products) {
    const vs = variants
      .filter((v) => v.product_id === p.id)
      .map((v) => toVariant(p, v))
      .filter((mv) => {
        if (
          input.max_unit_price_won !== undefined &&
          mv.unit_price_won > input.max_unit_price_won
        )
          return false;
        if (input.required_specs && !specsMatch(input.required_specs, mv.effective_specs))
          return false;
        return true;
      });
    // 필수 스펙/가격 조건이 있는데 맞는 옵션이 없으면 상품을 결과에서 제외
    const constrained =
      input.max_unit_price_won !== undefined ||
      (input.required_specs && Object.keys(input.required_specs).length > 0);
    if (constrained && vs.length === 0) continue;
    const rating = ratingByPid.get(p.id);
    items.push({
      product_id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      image: p.image_urls?.[0] ?? null,
      matched_variants: vs,
      rating_summary: rating
        ? { avg: Math.round(rating.avg * 10) / 10, count: rating.count }
        : { avg: null, count: 0 },
      availability: productAvailability(vs),
    });
  }
  if ((input.sort ?? "RELEVANCE") === "PRICE_ASC") {
    items.sort(
      (a, b) =>
        Math.min(...a.matched_variants.map((v) => v.unit_price_won)) -
        Math.min(...b.matched_variants.map((v) => v.unit_price_won)),
    );
  } else {
    items.sort(
      (a, b) =>
        (b.rating_summary.avg ?? 0) - (a.rating_summary.avg ?? 0) ||
        a.product_id.localeCompare(b.product_id),
    );
  }
  const sliced = items.slice(offset, offset + limit);
  const has_more = offset + limit < items.length;
  return ok(
    {
      items: sliced,
      ...catalogContext(source),
      shipping_fee_won: FLAT_SHIPPING_FEE_WON,
      next_cursor: has_more ? encCursor(offset + limit) : null,
      has_more,
    },
    trace_id,
  );
}

export async function getProduct(input: {
  product_id: string;
}, db: Pick<typeof sql, "unsafe"> = sql, source: CatalogSource = "public"): Promise<ToolResult<ProductDetail>> {
  source = catalogSource(source);
  const trace_id = crypto.randomUUID();
  const [p] = await db.unsafe<ProductRow[]>(`SELECT * FROM ${source}.products WHERE id = $1`, [
    input.product_id,
  ]);
  if (!p) return fail(err("NOT_FOUND", "상품을 찾을 수 없습니다"), trace_id);
  const vs = (await db.unsafe<VariantRow[]>(`SELECT * FROM ${source}.product_variants WHERE product_id = $1 AND active = true ORDER BY id`, [p.id])).map((v) => toVariant(p, v));
  return ok(
    {
      ...catalogContext(source),
      product: {
        id: p.id,
        name: p.name,
        brand: p.brand,
        category: p.category,
        description: p.description,
        images: p.image_urls ?? [],
        specs: p.specs_json,
        active: p.active,
        version: p.version,
        availability: productAvailability(vs),
      },
      variants: vs,
      shipping_fee_won: FLAT_SHIPPING_FEE_WON,
    },
    trace_id,
  );
}

// 리뷰 정렬 — ORDER BY는 이 상수 매핑에서만 가져오고 입력 원문은 절대
// 삽입하지 않는다. Ref127의 3종만 지원하고 '추천순'은 순위 알고리즘
// 계약이 없어 제공하지 않는다(sort 생략은 LATEST, 지원하지 않는 값은 VALIDATION) [PMQA-068].
const REVIEW_ORDER: Record<ReviewSort, string> = {
  LATEST: "written_at DESC, id",
  RATING_DESC: "rating DESC, written_at DESC, id",
  RATING_ASC: "rating ASC, written_at DESC, id",
};

export async function getReviews(
  input: {
    product_id: string;
    variant_id?: string;
    query?: string;
    sort?: string;
    cursor?: string;
    limit?: number;
  },
  db: Pick<typeof sql, "unsafe"> = sql,
  source: CatalogSource = "public",
): Promise<ToolResult<ReviewsResult>> {
  source = catalogSource(source);
  const trace_id = crypto.randomUUID();
  const { limit, offset } = page(input);
  if (offset < 0) return fail(err("VALIDATION", "invalid cursor"), trace_id);
  // own-property 검사 — 'toString'/'constructor'/'__proto__' 같은 상속키가
  // truthy로 통과해 ORDER BY에 들어가는 결함을 차단한다 [PMQA-068].
  const sortKey = input.sort ?? "LATEST";
  if (!Object.hasOwn(REVIEW_ORDER, sortKey))
    return fail(
      err("VALIDATION", "지원하지 않는 리뷰 정렬입니다"),
      trace_id,
    );
  const orderBy = REVIEW_ORDER[sortKey as ReviewSort];
  const [p] = await db.unsafe(`SELECT id FROM ${source}.products WHERE id = $1`, [
    input.product_id,
  ]);
  if (!p) return fail(err("NOT_FOUND", "상품을 찾을 수 없습니다"), trace_id);
  if (input.variant_id) {
    const [v] = await db.unsafe(
      `SELECT id FROM ${source}.product_variants WHERE id = $1 AND product_id = $2`,
      [input.variant_id, input.product_id],
    );
    if (!v)
      return fail(
        err("VALIDATION", "variant_id가 해당 상품의 옵션이 아닙니다"),
        trace_id,
      );
  }
  const q = (input.query ?? "").trim();
  const rows = await db.unsafe<ReviewRow[]>(
    `SELECT * FROM ${source}.reviews WHERE product_id = $1
      AND ($2::text IS NULL OR variant_id = $2)
      AND ($3 = '' OR body ILIKE '%' || $3 || '%')
      ORDER BY ${orderBy}`,
    [input.product_id, input.variant_id ?? null, q],
  );
  const sliced = rows.slice(offset, offset + limit);
  const has_more = offset + limit < rows.length;
  return ok(
    {
      ...catalogContext(source),
      reviews: sliced.map((r) => ({
        id: r.id,
        product_id: r.product_id,
        variant_id: r.variant_id,
        rating: r.rating,
        body: r.body,
        source_kind: r.source_kind,
        source_ref: r.source_ref,
        written_at: new Date(r.written_at).toISOString(),
      })),
      total_matching: rows.length,
      returned_count: sliced.length,
      next_cursor: has_more ? encCursor(offset + limit) : null,
      has_more,
      sort: sortKey as ReviewSort,
    },
    trace_id,
  );
}

const MAX_REVIEW_LOOKUP_IDS = 300;

export async function getReviewsByIds(
  input: { product_id: string; review_ids: string[] },
  db: Pick<typeof sql, "unsafe"> = sql,
  source: CatalogSource = "public",
): Promise<ReviewItem[]> {
  source = catalogSource(source);
  if (!input.product_id || input.product_id.length > 128 ||
      !Array.isArray(input.review_ids) || input.review_ids.length > MAX_REVIEW_LOOKUP_IDS ||
      input.review_ids.some((id) => typeof id !== "string" || !id || id.length > 128) ||
      new Set(input.review_ids).size !== input.review_ids.length)
    throw new Error("invalid review lookup IDs or ID limit exceeded");
  if (input.review_ids.length === 0) return [];
  const rows = await db.unsafe<ReviewRow[]>(
    "SELECT id, product_id, variant_id, rating, body, source_kind, source_ref, written_at " +
      `FROM ${source}.reviews WHERE product_id = $1 AND id = ANY($2) ORDER BY id LIMIT 300`,
    [input.product_id, input.review_ids],
  );
  return rows.map((r) => ({
    id: r.id,
    product_id: r.product_id,
    variant_id: r.variant_id,
    rating: r.rating,
    body: r.body,
    source_kind: r.source_kind,
    source_ref: r.source_ref,
    written_at: new Date(r.written_at).toISOString(),
  }));
}
