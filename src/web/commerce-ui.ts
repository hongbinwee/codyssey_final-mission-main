import type { Availability } from "../contracts.ts";

export type CatalogUiContext = {
  read_only: boolean;
  is_simulated: boolean;
  cart_enabled?: boolean;
  wishlist_enabled?: boolean;
  checkout_enabled?: boolean;
};

// Commerce is enabled only after the catalog context has explicitly confirmed
// that the selected catalog is writable. Unknown/error states fail closed.
export const isCommerceEnabled = (
  context: CatalogUiContext | null | undefined,
): boolean => context != null && (context.cart_enabled === true || !context.read_only);

export const isCheckoutEnabled = (context: CatalogUiContext | null | undefined): boolean =>
  context != null && !context.read_only && context.checkout_enabled !== false;

export const stockSafeErrorMessage = (code: string, message: string): string =>
  code === "OUT_OF_STOCK" ? "재고가 부족합니다. 수량이나 옵션을 다시 확인해 주세요." : message;

export function variantStockLabel(
  availability: Availability,
  _stockQty: number,
  readOnly: boolean,
): string {
  if (availability === "SOLD_OUT") return "품절";
  if (availability === "UNAVAILABLE") return "판매 중단";
  return readOnly ? "시연 옵션 · 주문 불가" : "구매 가능";
}
