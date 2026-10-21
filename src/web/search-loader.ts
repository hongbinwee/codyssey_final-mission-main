// 검색 결과 페이지 적재 — 서버 커서를 끝까지 따라 전체 결과를 모은다 [PMQA-071].
// 첫 페이지만으로 '최종 N개'/필터 개수를 계산하면 뒤 페이지 상품이 누락된다 [Luna].
//
// 계약 방어 [PM]:
// - has_more=true인데 next_cursor가 없으면 페이지네이션 불가 → 계약 오류
//   (부분 결과를 '전체'로 적용하지 않는다)
// - 같은 cursor가 반복되면 무한 요청 위험 → 계약 오류로 즉시 중단
// - SEARCH_PAGE_MAX 초과도 중단(런어웨이 방지; 1,500개 카탈로그도 완주)
// - 같은 product_id가 페이지를 넘어 반복되면 첫 등장만 유지 — 개수/React key에
//   중복 반영하지 않는다
//
// fetchPage·isStale는 호출부가 주입 — 실제 사용 경로를 mock IO로 단위 검증한다.
import type { SearchResult } from "../contracts.ts";
import type { ApiResult } from "./api.ts";

export const SEARCH_PAGE_MAX = 100;

export type SearchLoad =
  | { ok: true; data: SearchResult }
  | { ok: false; error: { code: string; message: string } }
  | { stale: true };

export async function loadSearchPages(
  base: string,
  fetchPage: (url: string) => Promise<ApiResult<SearchResult>>,
  isStale: () => boolean,
  onProgress?: (data: SearchResult) => void,
): Promise<SearchLoad> {
  const acc: SearchResult["items"] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < SEARCH_PAGE_MAX; page++) {
    const r = await fetchPage(
      base + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    if (isStale()) return { stale: true };
    if (!r.ok) return { ok: false, error: r.error };
    for (const it of r.data.items) {
      if (seenIds.has(it.product_id)) continue; // 중복 product_id는 첫 등장만
      seenIds.add(it.product_id);
      acc.push(it);
    }
    if (!r.data.has_more) {
      return { ok: true, data: { ...r.data, items: acc } };
    }
    if (!r.data.next_cursor) {
      return {
        ok: false,
        error: { code: "CONTRACT", message: "has_more without next_cursor" },
      };
    }
    if (seenCursors.has(r.data.next_cursor)) {
      return {
        ok: false,
        error: { code: "CONTRACT", message: "repeated next_cursor" },
      };
    }
    seenCursors.add(r.data.next_cursor);
    // Preview only after cursor validation; completion/error semantics stay unchanged.
    onProgress?.({ ...r.data, items: [...acc] });
    if (isStale()) return { stale: true };
    cursor = r.data.next_cursor;
  }
  return {
    ok: false,
    error: { code: "CONTRACT", message: "search page cap exceeded" },
  };
}
