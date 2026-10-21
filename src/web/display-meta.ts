// 04-B Demo Catalog — 화면 표시/merchandising 전용 메타.
// 실제 가격·재고·리뷰 수는 항상 API 응답이 정본이다.
// 이 파일은 UI 메타와 출처가 명시된 Demo Product Signals만 관리한다.
// Brain이나 추천 로직은 없으며, static 태그 기반으로 04-C Home 재구성 시 교체 가능한 형태다.

// 상위 카테고리 그룹. DB products.category는 상품군 단위(digital/beauty/...)이고
// fixture의 monitor는 변경하지 않고 "디지털" 그룹에 함께 묶는다.
export interface CategoryGroup {
  id: string;
  label: string;
  categories: string[];
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { id: "digital", label: "디지털", categories: ["digital", "monitor"] },
  { id: "beauty", label: "뷰티", categories: ["beauty"] },
  { id: "fashion", label: "패션", categories: ["fashion"] },
  { id: "living", label: "리빙", categories: ["living"] },
  { id: "food", label: "식품", categories: ["food"] },
];

const GROUP_OF = new Map<string, string>(
  CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => [c, g.id] as const)),
);
// 알 수 없는 category는 원문을 돌려준다(그룹 밖 카테고리도 탭/칩으로 표시 가능).
export const groupOf = (category: string): string =>
  GROUP_OF.get(category) ?? category;
export const groupLabel = (id: string): string =>
  CATEGORY_GROUPS.find((g) => g.id === id)?.label ?? id;

export interface ProductMeta {
  // 최저가 옵션 기준 정가. 할인율과 특가 DealCard 취소선 표시에만 쓰인다(주문 가격과 무관).
  original_price_won?: number;
  // "오늘출발"/"내일도착" 같은 도착 라벨. 배송비는 서버 shipping_fee_won이 정본.
  delivery?: string;
  // 홈 섹션 태그. 정적 merchandising용 — 추후 Brain 추천 결과로 교체 가능.
  sections?: ("flash-sale" | "popular" | "new" | "recommended" | "value")[];
}

// 카드/히어로 공통 표시 계산. 실제 주문 가격은 항상 서버 값이 정본이다.
import type { ProductSummary } from "../contracts.ts";
export const minPriceOf = (p: ProductSummary) =>
  Math.min(...p.matched_variants.map((v) => v.unit_price_won));
export const rateOf = (p: ProductSummary) => {
  const o = PRODUCT_META[p.product_id]?.original_price_won;
  const m = minPriceOf(p);
  return o && o > m ? Math.round(((o - m) / o) * 100) : 0;
};

// 카드 표시·찜 스냅샷 전용 [F03] — matched_variants가 비면 null을 돌려
// 카드의 '가격 정보 없음' truthful fallback과 null 스냅샷을 가능하게 한다.
// 전역 minPriceOf 계약(빈 배열 → Infinity)은 유지 — 다른 화면 재작성 없음.
export const cardMinPriceOf = (p: ProductSummary): number | null =>
  p.matched_variants.length ? minPriceOf(p) : null;

// 로컬 생성 webp 컨벤션 — 시드 image_urls가 비어 있을 때의 표시 경로.
export const productImg = (p: { product_id: string; image: string | null }) =>
  p.image ?? `/assets/products/${p.product_id}.webp`;

// ── 04-C 홈 재구성용 merchandising 데이터 ─────────────────────────────
// 캡처 [Observed] 구조: 히어로(텍스트+이미지) → 혜택 행 → 숏컷 → 추천 그리드.

// 상단 쇼핑 탭. Toss의 OASIS는 우리 식품 콘텐츠로 대체한 [Project] 매핑.
// 디지털·패션·리빙은 탭에 없고 카테고리/숏컷으로 진입한다.
export const TOP_TABS = [
  { id: "", label: "쇼핑 홈" },
  { id: "beauty", label: "뷰티" },
  { id: "food", label: "식품" },
  { id: "category", label: "카테고리" },
  { id: "sale", label: "특가" },
  { id: "season", label: "시즌 추천" },
] as const;

// 콘텐츠 홈으로 렌더하는 탭(히어로+서브카테고리+그리드). 나머지 그룹 id는 리스팅.
export const CONTENT_TABS = new Set(["beauty", "food"]);

// 히어로 슬라이드 — 홈은 카드형(좌텍스트+우이미지), 뷰티/식품은 풀블리드 이미지형.
// 원본 홈 히어로는 식품·생활 계열 중심이어서 카테고리를 섞는다 [Observed 01].
export const HOME_HERO = ["p-d-cof-1", "p-d-sun-mineral", "p-d-chair-1"];
export const GROUP_HERO: Record<string, string[]> = {
  beauty: ["p-d-sun-mineral", "p-d-lip", "p-d-tone"],
  food: ["p-d-cof-1", "p-d-pro-1", "p-d-cof-2"],
};

// 시즌 추천 탭 상품 — 쌀쌀한 계절 홈카페/무드 컨셉의 데모 큐레이션 [Project].
export const SEASONAL = [
  "p-d-lamp-2", "p-d-cof-1", "p-d-cof-2", "p-d-pro-1", "p-d-tee-2", "p-d-chair-2",
];

// 특가 탭 > 기획전 — 캠페인 그룹(제목+부제+가로 레일+더보기) [Observed 48 구조].
// 실제 캠페인 기간·랭킹이 아니라 기존 정적 메타의 재구성이다 [Project].
export interface CampaignGroup {
  id: string;
  title: string;
  sub: string;
  // productIds 우선, 없으면 group(상위 카테고리 그룹) 전체를 쓴다.
  productIds?: string[];
  group?: string;
  more: { cat: string; sub?: string };
}
export const CAMPAIGN_GROUPS: CampaignGroup[] = [
  {
    id: "season",
    title: "시즌 기획전",
    sub: "홈카페 · 무드등 모음",
    productIds: SEASONAL,
    more: { cat: "season" },
  },
  {
    id: "beauty",
    title: "뷰티 상품 모음",
    sub: "선케어부터 메이크업까지",
    group: "beauty",
    // 식품 전체보기와 같은 기존 목록 경로로 연결 — 캠페인 전용 화면은 없다 [Project]
    more: { cat: "beauty", sub: "all" },
  },
];

// 카테고리 브라우저의 서브카테고리 원형 아이콘 그리드 [Project].
// matches는 대표 이미지와 ?sub= 필터링에 쓰인다. Raw source detail categories are
// mapped only for display taxonomy; unverified product-title type/volume hints are not claims.
export interface Subcat {
  id: string;
  label: string;
  matches: (product: ProductSummary) => boolean;
}

const hasSpecs = (product: ProductSummary, keys: string[]) =>
  product.matched_variants.some((variant) =>
    keys.some((key) =>
      Object.entries(variant.effective_specs).some(
        ([name, value]) => name.toLocaleLowerCase() === key && String(value).trim() !== "",
      ),
    ),
  );

const specMatcher = (group: string, ...keys: string[]) =>
  (product: ProductSummary) =>
    groupOf(product.category) === group && hasSpecs(product, keys);

// Display taxonomy only; dataset IDs and inferred product-name claims are never used.
const SOURCE_SUBCATEGORY_KEYS = ["sub_category", "원본 목록 세부 카테고리", "type"];
const sourceSubcategoryMatcher = (group: string, ...values: string[]) =>
  (product: ProductSummary) =>
    groupOf(product.category) === group &&
    product.matched_variants.some((variant) =>
      SOURCE_SUBCATEGORY_KEYS.some(key => {
        const value=variant.effective_specs[key];
        return typeof value==="string"&&value.split(">").some(part=>values.includes(part.trim()));
      }),
    );

export const SUBCATS: Record<string, Subcat[]> = {
  digital: [
    { id: "earbuds", label: "이어폰", matches: specMatcher("digital", "anc", "driver", "codec", "battery_hours", "waterproof") },
    { id: "keyboard", label: "키보드", matches: specMatcher("digital", "switch", "layout", "keycap") },
    { id: "battery", label: "보조배터리", matches: specMatcher("digital", "capacity", "output", "ports") },
    {
      id: "monitor",
      label: "모니터",
      matches: (product) =>
        product.category === "monitor" ||
        specMatcher("digital", "screen_size", "resolution", "refresh_rate", "panel")(
          product,
        ),
    },
  ],
  beauty: [
    { id: "sun", label: "선케어", matches: (product) => sourceSubcategoryMatcher("beauty", "선케어")(product) || specMatcher("beauty", "spf", "pa", "uv_type")(product) },
    { id: "skincare", label: "스킨케어", matches: sourceSubcategoryMatcher("beauty", "스킨케어") },
    { id: "cleansing", label: "클렌징", matches: (product) => sourceSubcategoryMatcher("beauty", "클렌징")(product) || specMatcher("beauty", "skin", "cleanser_type", "cleansing_type")(product) },
    {
      id: "makeup",
      label: "메이크업",
      matches: (product) =>
        sourceSubcategoryMatcher("beauty", "메이크업")(product) ||
        specMatcher("beauty", "finish", "tone", "coverage", "shade")(product),
    },
  ],
  fashion: [
    { id: "tee", label: "티셔츠", matches: (product) => sourceSubcategoryMatcher("fashion", "반소매 티셔츠", "긴소매 티셔츠", "후드 티셔츠", "피케/카라 티셔츠")(product) || specMatcher("fashion", "fit", "weight_g_m2", "neck", "sleeve")(product) },
    { id: "shoes", label: "스니커즈", matches: (product) => sourceSubcategoryMatcher("fashion", "스니커즈")(product) || specMatcher("fashion", "sole", "closure", "shoe_size", "outsole")(product) },
  ],
  living: [
    { id: "chair", label: "의자", matches: specMatcher("living", "lumbar", "max_load", "armrest", "recline") },
    { id: "light", label: "조명", matches: specMatcher("living", "light", "dimming", "color_temp") },
  ],
  food: [
    { id: "coffee", label: "커피", matches: specMatcher("food", "roast", "origin", "note") },
    { id: "protein", label: "프로틴", matches: (product) => sourceSubcategoryMatcher("food", "프로틴")(product) || specMatcher("food", "protein_per_serving", "servings")(product) },
  ],
};
export const subcatOf = (group: string, sub: string) =>
  SUBCATS[group]?.find((s) => s.id === sub);

export const SECTION_LABEL: Record<string, string> = {
  "flash-sale": "지금 특가",
  popular: "인기 상품",
  new: "새로 들어온 상품",
  recommended: "추천 상품",
  value: "가성비 상품",
};

// 상세 스펙 칩의 표시 라벨. DB specs_json 키는 영문 ID로 유지하고,
// 화면에는 이 표의 한글 라벨을 쓴다. 없는 키는 원문 그대로 노출.
export const SPEC_LABEL: Record<string, string> = {
  panel: "패널", size: "크기", resolution: "해상도", refresh_rate: "주사율",
  ports: "포트", anc: "노이즈캔슬링", battery_hours: "배터리", driver: "드라이버",
  waterproof: "방수", weight_g: "무게", codec: "코덱", layout: "배열",
  switch: "스위치", keycap: "키캡", connection: "연결", capacity: "용량",
  output: "출력", spf: "SPF", pa: "PA", uv_type: "자외선 차단", skin: "피부 타입",
  tone: "톤", finish: "마감", material: "소재", fit: "핏", weight_g_m2: "원단 무게",
  sole: "밑창", armrest: "팔걸이", lumbar: "요추 지지", recline: "틸트",
  max_load: "하중", dimming: "밝기 조절", color_temp: "색온도", light: "광원",
  volume: "용량", roast: "로스팅", origin: "원산지", note: "노트",
  protein_per_serving: "단백질", servings: "회분", type: "유형", closure: "마개",
  weight: "무게",
};

// 상품별 표시 메타. 원가는 최저가 옵션의 정가이며 없으면 할인 표시를 하지 않는다.
export const PRODUCT_META: Record<string, ProductMeta> = {
  // fixture 모니터 — category는 그대로 두고 디지털 그룹으로 묶인다.
  "p-a": { original_price_won: 219000, delivery: "내일도착", sections: ["recommended"] },
  "p-b": { original_price_won: 189000, delivery: "오늘출발", sections: ["recommended", "popular"] },
  "p-c": { delivery: "내일도착", sections: ["recommended"] },

  // digital
  "p-d-ear-lite": { original_price_won: 119000, delivery: "오늘출발", sections: ["flash-sale", "recommended"] },
  "p-d-ear-pro": { original_price_won: 189000, delivery: "오늘출발", sections: ["flash-sale", "popular"] },
  "p-d-ear-ultra": { delivery: "내일도착", sections: ["new"] },
  "p-d-key-87": { original_price_won: 99000, delivery: "오늘출발", sections: ["flash-sale", "recommended"] },
  "p-d-key-61": { delivery: "내일도착", sections: ["value"] },
  "p-d-bat-10": { original_price_won: 39000, delivery: "오늘출발", sections: ["flash-sale", "value"] },
  "p-d-bat-20": { delivery: "내일도착", sections: ["value"] },

  // beauty
  "p-d-sun-mineral": { original_price_won: 24000, delivery: "오늘출발", sections: ["flash-sale", "popular"] },
  "p-d-sun-aqua": { delivery: "오늘출발", sections: ["popular"] },
  "p-d-sun-stick": { delivery: "내일도착", sections: ["new", "value"] },
  "p-d-tone": { delivery: "내일도착", sections: ["new"] },
  "p-d-lip": { original_price_won: 19000, delivery: "오늘출발", sections: ["flash-sale", "new"] },
  "p-d-foam-1": { original_price_won: 12900, delivery: "오늘출발", sections: ["flash-sale", "value"] },
  "p-d-foam-2": { delivery: "내일도착", sections: ["value"] },

  // fashion
  "p-d-tee-1": { original_price_won: 29000, delivery: "오늘출발", sections: ["flash-sale", "popular"] },
  "p-d-tee-2": { delivery: "내일도착", sections: ["new"] },
  "p-d-sn-1": { original_price_won: 79000, delivery: "내일도착", sections: ["flash-sale", "popular"] },
  // sn-2는 전 옵션 품절 상품 — 특가/추천 섹션에서 제외한다.
  "p-d-sn-2": { delivery: "내일도착" },

  // living
  "p-d-chair-1": { original_price_won: 189000, delivery: "내일도착", sections: ["flash-sale", "popular"] },
  "p-d-chair-2": { delivery: "내일도착", sections: ["recommended"] },
  "p-d-lamp-1": { original_price_won: 45000, delivery: "오늘출발", sections: ["flash-sale", "value"] },
  "p-d-lamp-2": { delivery: "내일도착", sections: ["new"] },

  // food
  "p-d-cof-1": { original_price_won: 14900, delivery: "오늘출발", sections: ["flash-sale", "value", "popular"] },
  "p-d-cof-2": { delivery: "오늘출발", sections: ["new"] },
  "p-d-pro-1": { original_price_won: 42000, delivery: "오늘출발", sections: ["flash-sale"] },
};

// ── 카드 보조 지표(신호) — 출처를 명시하는 확장 가능 계약 ────────────
// "N명 조회"/"30일 내 최저가" 같은 행은 Toss 카드에 있지만 [Observed home/02]
// 우리는 아직 실제 조회 집계·가격 이력 파이프라인이 없다. 향후 내부 이벤트
// 집계(INTERNAL)나 외부 상품 API(EXTERNAL)로 같은 계약에 교체할 수 있게
// 출처를 source로 명시하고, 지금 값은 전부 SYNTHETIC 시연용이다.
// UI는 이 데이터를 실제 통계처럼 주장하지 않는다(섹션 데모 칩 + title).
export type SignalSource = "INTERNAL" | "EXTERNAL" | "SYNTHETIC";

export interface ViewCountSignal {
  metric: "UNIQUE_VISITORS";
  // 고유 방문자 수 — 총 페이지뷰와 구분한다.
  unique_viewers: number;
  window_days: number; // 집계 기간(일)
  as_of: string;
  source: SignalSource;
  source_name: string;
}
export interface PriceObservation {
  product_id: string;
  variant_id: string;
  observed_at: string;
  price_won: number;
  source: SignalSource;
  source_name: string;
}
export interface ProductSignals {
  view_count?: ViewCountSignal;
  // Lowest 30-day value is derived from same-variant observations, never a boolean.
  price_observations?: PriceObservation[];
}

const SYN = "SYNTHETIC" as const;
const sourceName = "demo-price-history";
const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const viewers: Record<string, number> = {
  "p-b": 5200,
  "p-d-ear-lite": 32400, "p-d-ear-pro": 18300, "p-d-key-87": 13600,
  "p-d-bat-10": 19200, "p-d-bat-20": 8400, "p-d-sun-mineral": 45600,
  "p-d-sun-aqua": 26100, "p-d-lip": 6800, "p-d-foam-1": 7400,
  "p-d-tee-1": 12400, "p-d-sn-1": 15700, "p-d-chair-1": 9800,
  "p-d-lamp-1": 11300, "p-d-cof-1": 22700, "p-d-pro-1": 8900,
};
const viewSignal = (unique_viewers: number): ViewCountSignal => ({
  metric: "UNIQUE_VISITORS",
  unique_viewers,
  window_days: 30,
  as_of: new Date().toISOString(),
  source: SYN,
  source_name: "demo-traffic-sample",
});

// [SYNTHETIC] sample points stand in for permitted product-price observations.
// Each entry is tied to one product + variant + source; the card derives the low.
const syntheticHistory = (
  product_id: string,
  variant_id: string,
  current_won: number,
  previous_low_won = current_won,
): PriceObservation[] =>
  [
    { days: 29, price_won: current_won + 2000 },
    { days: 14, price_won: previous_low_won },
    { days: 1, price_won: current_won },
  ].map(({ days, price_won }) => ({
    product_id,
    variant_id,
    observed_at: ago(days),
    price_won,
    source: SYN,
    source_name: sourceName,
  }));

const priceSeries: [string, string, number, number?][] = [
  ["p-d-ear-lite", "v-d-ear-lite-w", 89000],
  ["p-d-ear-pro", "v-d-ear-pro-w", 149000],
  ["p-d-key-87", "v-d-key-87-w", 79000],
  ["p-d-bat-10", "v-d-bat-10", 29000],
  // Current 45,000 > observed low 43,000 → the claim should stay hidden.
  ["p-d-bat-20", "v-d-bat-20", 45000, 43000],
  ["p-d-sun-mineral", "v-d-sun-mineral", 18000],
  ["p-d-lip", "v-d-lip-c", 14000],
  ["p-d-foam-1", "v-d-foam-1", 8900],
  ["p-d-tee-1", "v-d-tee-1-sw", 19000],
  ["p-d-sn-1", "v-d-sn-1-240", 59000],
  ["p-d-chair-1", "v-d-chair-1-g", 149000],
  ["p-d-lamp-1", "v-d-lamp-1", 35000],
  ["p-d-cof-1", "v-d-cof-1-200", 9900],
  ["p-d-pro-1", "v-d-pro-1", 32000],
];
export const PRODUCT_SIGNALS: Record<string, ProductSignals> = Object.fromEntries(
  Object.entries(viewers).map(([id, count]) => [id, { view_count: viewSignal(count) }]),
);
for (const [product_id, variant_id, current, previous] of priceSeries) {
  PRODUCT_SIGNALS[product_id] ??= {};
  PRODUCT_SIGNALS[product_id].price_observations = syntheticHistory(
    product_id, variant_id, current, previous,
  );
}

// "3만 명"/"1,500명" 형태. 10만 이상은 정수 만 단위 [Observed 형식 근사].
export const fmtViewerCount = (n: number): string =>
  n >= 10000 ? Math.floor(n / 10000) + "만 명" : n.toLocaleString("ko-KR") + "명";

export interface Lowest30dResult {
  variant_id: string;
  current_price_won: number;
  price_won: number;
  source: SignalSource;
}

// 같은 상품/옵션/출처의 최근 30일 관측만 계산한다. 현재가가 최저가보다
// 높거나 관측값이 없거나 오래됐으면 null → UI에 최저가 문구를 렌더하지 않는다.
export const lowest30dFor = (
  p: ProductSummary,
  now = Date.now(),
): Lowest30dResult | null => {
  if (p.matched_variants.length === 0) return null;
  const variant = p.matched_variants.reduce((best, v) =>
    v.unit_price_won < best.unit_price_won ? v : best,
  );
  const cutoff = now - 30 * 86400000;
  const groups = new Map<string, PriceObservation[]>();
  for (const o of PRODUCT_SIGNALS[p.product_id]?.price_observations ?? []) {
    const at = Date.parse(o.observed_at);
    if (
      o.product_id !== p.product_id || o.variant_id !== variant.variant_id ||
      !Number.isFinite(at) || !Number.isFinite(o.price_won) ||
      at < cutoff || at > now
    ) continue;
    const key = o.source + ":" + o.source_name;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const series = [...groups.values()].sort((a, b) =>
    Math.max(...b.map((x) => Date.parse(x.observed_at))) -
    Math.max(...a.map((x) => Date.parse(x.observed_at))),
  )[0];
  if (!series?.length) return null;
  const low = Math.min(...series.map((o) => o.price_won));
  return variant.unit_price_won <= low
    ? { variant_id: variant.variant_id, current_price_won: variant.unit_price_won, price_won: low, source: series[0].source }
    : null;
};
