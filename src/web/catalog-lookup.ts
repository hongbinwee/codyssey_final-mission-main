// 로컬 기록 id 목록(최근본 등)을 현재 상품 API 계약으로 해석한다.
// 목록 API의 page 크기는 서버에서 50으로 clamp되므로 cursor를 따라가며
// 필요한 id를 모두 찾거나 카탈로그 끝까지 훑는다 — '페이지 제한으로 아직 못
// 읽은 상품(unread)'·'끝까지 읽어도 없는 상품(missing, 삭제/비활성)'·
// '조회 실패'를 반환값으로 구분해 페이지 누락을 판매 중단으로 오표기하지 않는다.
import { apiSafe, type ApiResult } from "./api.ts";
import type { ProductSummary, SearchResult } from "../contracts.ts";

export type ProductLookup =
  | {
      ok: true;
      found: ProductSummary[]; // 입력 ids 순서 유지
      missing: string[]; // 카탈로그 끝까지 조회해도 없음 — 삭제/비활성
      unread: string[]; // 페이지 상한으로 미완료 조회 — missing과 다르다
    }
  | { ok: false };

export type ProductPageFetcher = (
  cursor: string | null,
) => Promise<ApiResult<SearchResult>>;

const defaultFetch: ProductPageFetcher = (cursor) =>
  apiSafe<SearchResult>(
    "/api/products?limit=50" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
  );

const MAX_PAGES = 40; // 카탈로그 비상 상한 — 무한 페이지 루프 방지 [Project]

export async function fetchProductsByIds(
  ids: string[],
  fetchPage: ProductPageFetcher = defaultFetch,
): Promise<ProductLookup> {
  const wanted = new Set(ids);
  const found = new Map<string, ProductSummary>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let finished = false; // 카탈로그 끝까지 실제로 읽었는가
  for (let pages = 0; wanted.size > 0 && pages < MAX_PAGES; pages++) {
    const r = await fetchPage(cursor);
    if (!r.ok) return { ok: false };
    for (const p of r.data.items)
      if (wanted.has(p.product_id)) {
        found.set(p.product_id, p);
        wanted.delete(p.product_id);
      }
    if (!r.data.has_more) {
      finished = true;
      break;
    }
    const next = r.data.next_cursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  const ordered = ids
    .filter((id) => found.has(id))
    .map((id) => found.get(id) as ProductSummary);
  const rest = [...wanted];
  return {
    ok: true,
    found: ordered,
    missing: finished ? rest : [],
    unread: finished ? [] : rest,
  };
}

// 개별 삭제의 로컬 적용 — 삭제된 카드를 현재 결과에서 제거한다.
// 화면은 삭제 시점에 진행 중이던 읽기 세대를 무효화한 뒤 이 헬퍼로 갱신한다 —
// 늦게 도착하는 삭제 이전 ids의 응답이 카드를 되살리는 경로를 차단한다 [C/069].
export function filterLookupRemove(
  lookup: ProductLookup,
  id: string,
): ProductLookup {
  if (!lookup.ok) return lookup;
  return {
    ok: true,
    found: lookup.found.filter((p) => p.product_id !== id),
    missing: lookup.missing.filter((x) => x !== id),
    unread: lookup.unread.filter((x) => x !== id),
  };
}
