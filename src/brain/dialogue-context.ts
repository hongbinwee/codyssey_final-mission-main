import type { Preference, PreferenceKey, PreferenceValue, ReviewSummaryRequest } from "./contracts.ts";
import type { ResearchResult } from "./read-flow.ts";

export type DialogueContext = {
  recentTurns: { user: string; assistant: string }[];
  displayedProducts: { productId: string; variantId: string; name: string }[];
  pendingReview?: ReviewSummaryRequest;
  approvedPreferences: { key: PreferenceKey; value: PreferenceValue }[];
  shoppingPlan?: {
    query: string;
    maxTotalWon: number | null;
    minTotalWon?: number;
    requiredConditions: string[];
    currentPreferences: Partial<Record<PreferenceKey, PreferenceValue>>;
    category?: string;
  };
};

const MAX_TURNS = 6;
const MAX_CONTEXT_CHARS = 12_000;
const VALID_PREFERENCES: Record<PreferenceKey, readonly PreferenceValue[]> = {
  price_priority: ["value", "balanced", "performance"],
  eye_comfort: ["important", "normal"],
  noise_sensitivity: ["important", "normal"],
};
const SECRET_TEXT = /(?:sk-[a-z0-9_-]{8,}|(?:api[_ -]?key|password|passwd|secret|token)\s*[:=]\s*\S+|bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const safeId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value);
const safeText = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max && !SECRET_TEXT.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    ? value.trim()
    : undefined;

function approvedPreferences(memories: Preference[]): DialogueContext["approvedPreferences"] {
  const latest = new Map<PreferenceKey, { value: PreferenceValue; updatedAt: string }>();
  for (const memory of [...memories].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    const values = VALID_PREFERENCES[memory.key];
    if (!values?.includes(memory.value)) continue;
    latest.set(memory.key, { value: memory.value, updatedAt: memory.updatedAt });
  }
  return [...latest].slice(0, 3).map(([key, value]) => ({ key, value: value.value }));
}

function displayedProducts(previous: ResearchResult): DialogueContext["displayedProducts"] {
  const candidatesByProduct = new Map<string, { variantId: string; productName?: string }[]>();
  for (const row of [...previous.ranking.ranked, ...previous.ranking.referenceOnly]) {
    const candidate = row.candidate;
    if (!safeId(candidate.productId) || !safeId(candidate.variantId)) continue;
    const rows = candidatesByProduct.get(candidate.productId) ?? [];
    rows.push({ variantId: candidate.variantId, productName: candidate.productName });
    candidatesByProduct.set(candidate.productId, rows);
  }
  const sources: { productId: string; variantId?: string; name?: string }[] = [
    ...(previous.explanation?.items ?? []),
    ...(previous.explanation?.reviewSummary?.product ? [{
      productId: previous.explanation.reviewSummary.product.id,
      variantId: previous.explanation.reviewSummary.product.variantId,
      name: previous.explanation.reviewSummary.product.name,
    }] : []),
    ...(previous.explanation?.reviewSummary?.choices ?? []).map((choice) => ({
      productId: choice.productId, name: choice.name,
    })),
    ...(previous.shoppingPlan?.lastDisplayedProducts ?? []),
    ...previous.ranking.ranked.map(({ candidate }) => ({
      productId: candidate.productId, variantId: candidate.variantId, name: candidate.productName,
    })),
  ];
  const namesByProduct = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!safeId(source.productId)) continue;
    const name = safeText(source.name, 160);
    if (!name) continue;
    const names = namesByProduct.get(source.productId) ?? new Set<string>();
    names.add(name);
    namesByProduct.set(source.productId, names);
  }
  for (const [productId, rows] of candidatesByProduct) {
    for (const row of rows) {
      const name = safeText(row.productName, 160);
      if (!name) continue;
      const names = namesByProduct.get(productId) ?? new Set<string>();
      names.add(name);
      namesByProduct.set(productId, names);
    }
  }
  const result: DialogueContext["displayedProducts"] = [];
  const seen = new Set<string>();
  for (const item of sources) {
    const productId = item.productId;
    if (!safeId(productId) || namesByProduct.get(productId)?.size !== 1) continue;
    const candidateRows = candidatesByProduct.get(productId) ?? [];
    const matchingRows = item.variantId
      ? candidateRows.filter((candidate) => candidate.variantId === item.variantId)
      : candidateRows;
    if (item.variantId && !safeId(item.variantId)) continue;
    if (matchingRows.length > 1 && new Set(matchingRows.map((row) => row.variantId)).size > 1 && !item.variantId) continue;
    const variantId = safeId(item.variantId) ? item.variantId : matchingRows[0]?.variantId;
    if (!safeId(variantId)) continue;
    const key = `${productId}\0${variantId}`;
    if (seen.has(key)) continue;
    const name = safeText(item.name, 160) ?? safeText(matchingRows[0]?.productName, 160);
    if (!name) continue;
    seen.add(key);
    result.push({ productId, variantId, name });
    if (result.length === 3) break;
  }
  return result;
}

function pendingReview(
  request: ReviewSummaryRequest | undefined,
  products: DialogueContext["displayedProducts"],
): ReviewSummaryRequest | undefined {
  if (!request || (request.focus !== "ALL" && request.focus !== "CONS")) return undefined;
  const ids = new Set(products.map((product) => product.productId));
  const pageProductId = safeId(request.pageProductId) && ids.has(request.pageProductId) ? request.pageProductId : undefined;
  const productId = safeId(request.productId) && ids.has(request.productId) ? request.productId : undefined;
  const variantId = safeId(request.variantId) && products.some((product) => product.variantId === request.variantId) ? request.variantId : undefined;
  const query = safeText(request.query, 160);
  const displayIndex = Number.isSafeInteger(request.displayIndex) && request.displayIndex! >= 1 && request.displayIndex! <= 3
    ? request.displayIndex : undefined;
  const useCurrent = typeof request.useCurrent === "boolean" ? request.useCurrent : undefined;
  if ((request.productId && !productId) || (request.pageProductId && !pageProductId) ||
      (request.variantId && !variantId) || (request.query && !query)) return undefined;
  return {
    ...(query ? { query } : {}), ...(productId ? { productId } : {}),
    ...(pageProductId ? { pageProductId } : {}), ...(variantId ? { variantId } : {}),
    ...(displayIndex ? { displayIndex } : {}), ...(useCurrent !== undefined ? { useCurrent } : {}),
    focus: request.focus,
  };
}

function shoppingPlan(previous: ResearchResult): DialogueContext["shoppingPlan"] {
  const plan = previous.shoppingPlan;
  if (!plan || !safeText(plan.query, 200) ||
      !(plan.maxTotalWon === null || Number.isSafeInteger(plan.maxTotalWon) && plan.maxTotalWon >= 0) ||
      !Array.isArray(plan.requiredConditions) || plan.requiredConditions.length > 12) return undefined;
  const currentPreferences: Partial<Record<PreferenceKey, PreferenceValue>> = {};
  for (const [key, value] of Object.entries(plan.currentPreferences ?? {})) {
    if (VALID_PREFERENCES[key as PreferenceKey]?.includes(value as PreferenceValue))
      currentPreferences[key as PreferenceKey] = value as PreferenceValue;
  }
  const requiredConditions = plan.requiredConditions
    .map((condition) => safeText(condition, 80)).filter((value): value is string => !!value);
  const category = safeText(plan.category, 80);
  return {
    query: plan.query.slice(0, 200), maxTotalWon: plan.maxTotalWon,
    ...(plan.minTotalWon !== undefined && Number.isSafeInteger(plan.minTotalWon) && plan.minTotalWon >= 0
      ? { minTotalWon: plan.minTotalWon } : {}),
    requiredConditions, currentPreferences, ...(category ? { category } : {}),
  };
}

/** Authenticated memory ownership is checked by prepareTurn; only its approved key/value pair reaches this projection. */
export function buildDialogueContext(
  previous: ResearchResult | undefined,
  memories: Preference[],
  datasetVersion?: string,
): DialogueContext {
  const result: DialogueContext = { recentTurns: [], displayedProducts: [], approvedPreferences: approvedPreferences(memories) };
  const datasetChanged = !!datasetVersion && previous?.datasetVersion !== datasetVersion;
  if (!previous || datasetChanged) return result;

  result.recentTurns = (previous.recentTurns ?? []).slice(-MAX_TURNS).flatMap((turn) => {
    const user = safeText(turn?.user, 1200);
    const assistant = safeText(turn?.assistant, 1200);
    return user && assistant ? [{ user, assistant }] : [];
  });
  result.displayedProducts = displayedProducts(previous);
  result.pendingReview = pendingReview(previous.pendingReview, result.displayedProducts);
  result.shoppingPlan = shoppingPlan(previous);

  while (result.recentTurns.length && JSON.stringify(result).length > MAX_CONTEXT_CHARS)
    result.recentTurns.shift();
  if (JSON.stringify(result).length > MAX_CONTEXT_CHARS) {
    result.recentTurns = [];
    result.displayedProducts = [];
    delete result.pendingReview;
  }
  return result;
}
