import type { ProductSummary, SearchResult } from "../contracts.ts";

export type BrowseSummary = NonNullable<SearchResult["browse_summary"]>;

export type BrowsePage = SearchResult;

export interface BrowsePagerState {
  key: string;
  items: ProductSummary[];
  browseSummary?: BrowseSummary;
  nextCursor: string | null;
  hasMore: boolean;
  seenIds: Set<string>;
  seenCursors: Set<string>;
}

export function browseKey(category: string, sub: string, userId: string | null): string {
  return JSON.stringify([category, sub, userId]);
}

export function browsePageUrl(category: string, sub: string, cursor: string | null): string {
  const params = new URLSearchParams({
    browse: "1",
    browse_group: category,
    browse_sub: sub,
    limit: "50",
  });
  if (cursor !== null) params.set("cursor", cursor);
  return "/api/products?" + params.toString();
}

export function createBrowsePagerState(key: string): BrowsePagerState {
  return { key, items: [], nextCursor: null, hasMore: false, seenIds: new Set(), seenCursors: new Set() };
}

export function claimBrowseRequest(
  inFlight: Set<string>,
  key: string,
  cursor: string | null,
): (() => void) | undefined {
  const requestKey = JSON.stringify([key, cursor]);
  if (inFlight.has(requestKey)) return;
  inFlight.add(requestKey);
  return () => inFlight.delete(requestKey);
}

export function applyBrowsePage(
  state: BrowsePagerState,
  key: string,
  requestedCursor: string | null,
  page: BrowsePage,
): { state: BrowsePagerState; stale?: true; error?: string } {
  if (state.key !== key || state.nextCursor !== requestedCursor) return { state, stale: true };
  if (!Array.isArray(page?.items) || typeof page.has_more !== "boolean")
    return { state, error: "invalid browse page" };
  if (page.has_more) {
    if (typeof page.next_cursor !== "string" || !page.next_cursor)
      return { state, error: "has_more without next_cursor" };
    if (page.next_cursor === requestedCursor || state.seenCursors.has(page.next_cursor))
      return { state, error: "repeated next_cursor" };
  }

  const seenIds = new Set(state.seenIds);
  const items = [...state.items];
  for (const item of page.items) {
    if (!item || typeof item.product_id !== "string" || !item.product_id || seenIds.has(item.product_id)) continue;
    seenIds.add(item.product_id);
    items.push(item);
  }
  const seenCursors = new Set(state.seenCursors);
  if (page.has_more) seenCursors.add(page.next_cursor!);
  return {
    state: {
      key,
      items,
      ...(page.browse_summary ? { browseSummary: page.browse_summary } :
        state.browseSummary ? { browseSummary: state.browseSummary } : {}),
      nextCursor: page.has_more ? page.next_cursor : null,
      hasMore: page.has_more,
      seenIds,
      seenCursors,
    },
  };
}
