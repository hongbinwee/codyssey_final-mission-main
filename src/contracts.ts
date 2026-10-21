// DATA_TOOL_DESIGN 5~7절 공통 계약. 구현된 Tool만 registry에 노출한다.
export type RecoveryAction =
  | "RETRY_READ"
  | "REFRESH_AND_RECONFIRM"
  | "CHECK_OPERATION"
  | "STOP";

export type ToolError = {
  code: string;
  message: string;
  recovery_action: RecoveryAction;
};

export type ToolResult<T> =
  | {
      ok: true;
      data: T;
      observed_at: string;
      trace_id: string;
      operation_id?: string;
      action_status?: string;
      replayed?: boolean;
    }
  | {
      ok: false;
      error: ToolError;
      trace_id: string;
      operation_id?: string;
      action_status?: string;
      replayed?: boolean;
    };

export const ok = <T>(data: T, trace_id: string): ToolResult<T> => ({
  ok: true,
  data,
  observed_at: new Date().toISOString(),
  trace_id,
});

export const fail = <T>(
  error: ToolError,
  trace_id: string,
  operation_id?: string,
): ToolResult<T> => ({ ok: false, error, trace_id, operation_id });

export const err = (
  code: string,
  message: string,
  recovery_action: RecoveryAction = "STOP",
): ToolError => ({ code, message, recovery_action });

export type Availability = "AVAILABLE" | "SOLD_OUT" | "UNAVAILABLE";

export interface CatalogContext {
  source: "test_items" | "test_items2";
  read_only: true;
  is_simulated: true;
}

export interface MatchedVariant {
  variant_id: string;
  option_values: Record<string, string>;
  effective_specs: Record<string, string>;
  unit_price_won: number;
  stock_qty: number;
  availability: Availability;
  version: number;
}

export interface ProductSummary {
  product_id: string;
  name: string;
  brand: string;
  category: string;
  image: string | null;
  matched_variants: MatchedVariant[];
  rating_summary: { avg: number | null; count: number };
  availability: Availability;
}

export interface SearchResult {
  catalog_context?: CatalogContext;
  items: ProductSummary[];
  shipping_fee_won: number;
  next_cursor: string | null;
  has_more: boolean;
  browse_summary?: {
    total_count: number;
    group_counts: Record<string, number>;
    subcategory_counts: Record<string, Record<string, number>>;
    max_discount_rate: number;
  };
}

export interface ProductDetail {
  catalog_context?: CatalogContext;
  product: {
    id: string;
    name: string;
    brand: string;
    category: string;
    description: string;
    images: string[];
    specs: Record<string, string>;
    active: boolean;
    version: number;
    availability: Availability;
  };
  variants: MatchedVariant[];
  shipping_fee_won: number;
}

export interface ReviewItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  rating: number;
  body: string;
  source_kind: "REAL" | "SYNTHETIC";
  source_ref: string;
  written_at: string;
}

export interface ReviewsResult {
  catalog_context?: CatalogContext;
  reviews: ReviewItem[];
  total_matching: number;
  returned_count: number;
  next_cursor: string | null;
  has_more: boolean;
  // 서버가 실제 적용한 정렬 — Ref127 팝오버의 3종만 지원한다 [PMQA-068].
  // '추천순'은 순위 알고리즘 계약이 없어 제공하지 않는다.
  sort: ReviewSort;
}

export type ReviewSort = "LATEST" | "RATING_DESC" | "RATING_ASC";

export interface CartItemView {
  cart_item_id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  image: string | null;
  option_values: Record<string, string>;
  quantity: number;
  unit_price_won: number;
  variant_version: number;
  availability: Availability;
  purchasable: boolean;
  block_reason: string | null;
}

export interface CartView {
  cart_id: string;
  version: number;
  items: CartItemView[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  can_checkout: boolean;
}

// A01 비교 카드. 서버가 Tool 조회 결과로만 조립한다 — LLM 텍스트를 근거로 쓰지 않는다.
export interface CompareCard {
  products: {
    product_id: string;
    name: string;
    min_price_won: number;
    max_price_won: number;
    rating_summary: { avg: number | null; count: number };
    availability: Availability;
    evidence_review_ids: string[];
  }[];
  limitations: string[];
}

// 주문/결제/배송 (Phase 3). 주문 항목은 구매 시점 스냅샷이다.
export interface OrderItemView {
  order_item_id: string;
  variant_id: string;
  product_name: string;
  option_values: Record<string, string>;
  unit_price_won: number;
  quantity: number;
  line_total_won: number;
  // 현재 카탈로그 이미지 — 구매 시점 스냅샷이 아니라 조회 시점 표시용이다.
  // 이름/옵션/수량/가격은 저장 스냅샷만 사용하고, 이미지는 없으면 null.
  image: string | null;
  // 이미지 fallback·상품 링크에 쓰는 현재 variant의 product id.
  // variant가 삭제됐으면 null — 스냅샷 필드가 아니라 조회 시점 참조다.
  product_id: string | null;
}

export interface PaymentView {
  status: "PAID";
  paid_amount_won: number;
  paid_at: string;
  refund_status: "NONE" | "PENDING" | "REFUNDED";
  refunded_amount_won: number;
  refunded_at: string | null;
}

export interface ShipmentEvent {
  status: "PREPARING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
  occurred_at: string;
  note?: string;
}

export interface ShipmentView {
  status: ShipmentEvent["status"];
  events: ShipmentEvent[];
  estimated_arrival_at: string | null;
  updated_at: string;
}

export interface OrderView {
  id: string;
  version: number;
  status: "CONFIRMED" | "CANCELLED";
  created_at: string;
  cancelled_at: string | null;
  items: OrderItemView[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  address_snapshot: Record<string, string>;
  payment: PaymentView | null;
  shipping: ShipmentView | null;
  cancel_request: {
    id: string; status: string; reason_code: string;
    refund_amount_won: number; requested_at: string; completed_at: string | null;
  } | null;
  // 서버 canonical 취소 정책(cancel-policy.ts evaluateCancelFacts) 결과 —
  // 상세 CTA는 이 값만 소비한다. 서버가 항상 계산해 required다 [PMQA-06B-053].
  cancel_eligible: boolean;
}

export interface OrderListFirstItem {
  product_name: string;                    // 스냅샷
  option_values: Record<string, string>;   // 스냅샷
  quantity: number;                        // 스냅샷 — 첫 품목 수량(주문 전체 수량 아님)
  line_total_won: number;                  // 스냅샷 — 첫 품목 금액(주문 총액 아님, '외 N건'과 총액 별도 표시)
  // 조회 시점 카탈로그 이미지 — 구매 시점 스냅샷이 아니다. 없으면 null.
  image: string | null;
  // 이미지 fallback·상품 링크용 조회 시점 참조 — variant 삭제 시 null. 스냅샷 아님.
  product_id: string | null;
}

export interface OrderListItem {
  id: string;
  created_at: string;
  item_summary: string;
  total_won: number;
  order_status: string;
  payment_status: string | null;
  shipping_status: string | null;
  refund_status: string | null;
  cancel_status: string | null;
  // ── 06B additive (PMQA-048-A) — 기존 소비자 필드 의미 불변, 전부 optional ──
  item_count?: number;                     // 주문 내 품목 수 — '외 N건' 표시용
  first_item?: OrderListFirstItem | null;  // 카드 썸네일 행 — 없으면 요약 텍스트로 대체
  paid_at?: string | null;                 // 'N.N 결제 상세' 라벨 — 없으면 created_at 사용
  cancelled_at?: string | null;            // 취소 완료 상태일 — 주문 취소 시에만
  shipping_estimated_arrival_at?: string | null; // 도착 예정 — null이면 미노출(임의 ETA 금지)
  delivered_at?: string | null;            // 마지막 배송 event가 실제 DELIVERED일 때만 설정
  // 서버 canonical 취소 정책 결과 — 없음/불명은 UI에서 fail closed(비노출) [PMQA-06B-053].
  cancel_eligible?: boolean;
}

export interface ShippingStatusResult {
  order_id: string;
  order_version: number;
  information: "AVAILABLE" | "NO_INFORMATION";
  status: ShipmentEvent["status"] | null;
  events: ShipmentEvent[];
  estimated_arrival_at: string | null;
  updated_at: string | null;
}

// T3 취소 (Phase 4). 가능 여부·견적·환불액은 서버가 결정한다 — LLM 입력은 사유 선택뿐.
export type CancelReasonCode = "ORDER_MISTAKE" | "CHANGE_OF_MIND" | "OTHER";

export interface CancelEligibilityResult {
  order_id: string;
  order_version: number;
  eligible: boolean;
  reasons: { code: string; message: string }[];
  policy_version: string;
}

export interface CancelQuoteResult {
  order_id: string;
  order_version: number;
  eligible: boolean;
  reasons: { code: string; message: string }[];
  quote: {
    order_id: string;
    order_version: number;
    reason_code: CancelReasonCode;
    refund_amount_won: number;
    currency: "KRW";
    policy_version: string;
    expires_at: string;
    quote_token: string;
  } | null;
}

export interface CancelRequestResult {
  cancel_request_id: string;
  status: "REQUESTED";
  refund_amount_won: number;
  order: OrderView | null; // 최초 접수 결과 + 현재 주문 상태 재조회. 조회 실패 시 null.
}

// W04 주문서 견적 (UI 전용 — Agent Tool이 아니다). 서명된 불투명 토큰 +
// 정규화된 구매 대상 items + 표시용 카트 스냅샷/주소.
// PMQA-067 [사용자 C 통합 승인]: 구매 대상은 source로 구분한다 —
// CART_FULL(기존 전체 카트, legacy GET quote 호환), CART_SELECTED(카트 선택
// 항목 부분 주문), DIRECT(상품 상세 바로 구매 — 카트 읽기/쓰기 0).
export type CheckoutSource =
  | { kind: "CART_FULL" }
  | { kind: "CART_SELECTED"; cart_item_ids: string[] }
  | { kind: "DIRECT"; variant_id: string; quantity: number };

// 프런트 라우트용 주문 대상 — DIRECT의 product_id는 뒤로가기 부모 복원에만
// 쓰이고 견적 요청에는 포함되지 않는다.
export type CheckoutTarget =
  | { kind: "CART_SELECTED"; cart_item_ids: string[] }
  | { kind: "DIRECT"; variant_id: string; quantity: number; product_id?: string };

export interface CheckoutItemView {
  cart_item_id: string | null; // cart source만 — DIRECT는 null
  product_id: string;
  variant_id: string;
  product_name: string;
  image: string | null;
  option_values: Record<string, string>;
  quantity: number;
  unit_price_won: number;
}

export interface CheckoutQuoteView {
  quote_token: string;
  expires_at: string;
  source: "CART_FULL" | "CART_SELECTED" | "DIRECT";
  items: CheckoutItemView[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  address: Record<string, string>;
  // 표시용 스냅샷 — CART_FULL=전체 카트, CART_SELECTED=선택 부분집합(실제
  // cart id/version 유지), DIRECT는 카트가 없으므로 null. 결제 표시는
  // items/금액 필드를 사용한다.
  cart: CartView | null;
}

// 찜 (PMQA-070) — UI 전용 계약. Agent Tool registry에는 노출하지 않는다.
// 목록은 최근 저장순(created_at DESC)·product_id ASC로 안정 정렬한다.
export interface WishlistItemView {
  product_id: string;
  saved_at: string;
  // 목록 표시용 현재 상품 정보 — 비활성(판매 중단) 상품도 찜 목록에는
  // 보존·표시한다(FK NO ACTION으로 물리 삭제 자체가 거절되므로 join이
  // 항상 성립). 새 저장만 서버가 거절하고 해제는 항상 가능하다.
  name: string;
  image: string | null;
  active: boolean;
  min_price_won: number | null;
}
export interface WishlistView {
  items: WishlistItemView[];
}
export interface SetWishlistResult {
  product_id: string;
  saved: boolean;
  wishlist_count: number;
}
