import test from "node:test";
import assert from "node:assert/strict";
import { buildDialogueContext } from "../../src/brain/dialogue-context.ts";

test("dialogue context bounds same-dataset history and projects only approved preference fields", () => {
  const previous = {
    datasetVersion: "dataset-a", conversationId: "c-1", messageId: "m-1",
    ranking: { ranked: [{ candidate: { productId: "p-1", variantId: "v-1", productName: "수분크림" } }], referenceOnly: [] },
    shoppingPlan: { query: "수분크림", maxTotalWon: 50000, requiredConditions: ["무향"], currentPreferences: {}, revision: 2 },
    explanation: { items: [{ productId: "p-1", variantId: "v-1", name: "수분크림" }] },
    pendingReview: { productId: "p-1", focus: "CONS" },
    recentTurns: Array.from({ length: 8 }, (_, index) => ({ user: `질문 ${index}`, assistant: `답변 ${index}` })),
  };
  const memories = [
    { userId: "owner", key: "price_priority", value: "value", sourceConversationId: "secret-c", sourceMessageId: "secret-m", updatedAt: "2026-10-20T00:00:00Z" },
    { userId: "owner", key: "eye_comfort", value: "important", sourceConversationId: "secret-c", sourceMessageId: "secret-m", updatedAt: "2026-10-20T00:00:00Z" },
    { userId: "owner", key: "noise_sensitivity", value: "normal", sourceConversationId: "secret-c", sourceMessageId: "secret-m", updatedAt: "2026-10-20T00:00:00Z" },
    { userId: "owner", key: "price_priority", value: "bad", sourceConversationId: "secret-c", sourceMessageId: "secret-m", updatedAt: "2026-10-21T00:00:00Z" },
  ];
  const result = buildDialogueContext(previous as never, memories as never, "dataset-a") as unknown as Record<string, unknown>;
  assert.deepEqual(result.recentTurns, [
    { user: "질문 2", assistant: "답변 2" }, { user: "질문 3", assistant: "답변 3" },
    { user: "질문 4", assistant: "답변 4" }, { user: "질문 5", assistant: "답변 5" },
    { user: "질문 6", assistant: "답변 6" }, { user: "질문 7", assistant: "답변 7" },
  ]);
  assert.deepEqual(result.displayedProducts, [{ productId: "p-1", variantId: "v-1", name: "수분크림" }]);
  assert.deepEqual(result.approvedPreferences, [
    { key: "price_priority", value: "value" },
    { key: "eye_comfort", value: "important" },
    { key: "noise_sensitivity", value: "normal" },
  ]);
  assert.deepEqual(result.pendingReview, { productId: "p-1", focus: "CONS" });
  assert.doesNotMatch(JSON.stringify(result), /secret-c|secret-m|owner|bad/);
});

test("dialogue context excludes prior products and wording across dataset versions and drops secret text", () => {
  const previous = {
    datasetVersion: "dataset-old", conversationId: "c-1", messageId: "m-1",
    ranking: { ranked: [{ candidate: { productId: "p-old", variantId: "v-old", productName: "old product" } }], referenceOnly: [] },
    shoppingPlan: { query: "old product", maxTotalWon: 10000, requiredConditions: [], currentPreferences: {}, revision: 1 },
    explanation: { items: [{ productId: "p-old", variantId: "v-old", name: "old product" }] },
    pendingReview: { productId: "p-old", focus: "ALL" },
    recentTurns: [{ user: "old question", assistant: "old answer" }],
  };
  const result = buildDialogueContext(previous as never, [], "dataset-new") as unknown as Record<string, unknown>;
  assert.deepEqual(result.recentTurns, []);
  assert.deepEqual(result.displayedProducts, []);
  assert.equal(result.pendingReview, undefined);
  assert.equal(result.shoppingPlan, undefined);
  assert.doesNotMatch(JSON.stringify(result), /old product|old question|old answer/);

  const sameDataset = buildDialogueContext({
    datasetVersion: "dataset-new", recentTurns: [{ user: "password=abc123secret", assistant: "safe response" }],
    explanation: { items: [{ productId: "p-1", variantId: "v-1", name: "sk-abcdefghijklmnop" }] },
    ranking: { ranked: [{ candidate: { productId: "p-1", variantId: "v-1", productName: "sk-abcdefghijklmnop" } }], referenceOnly: [] },
  } as never, [], "dataset-new") as unknown as Record<string, unknown>;
  assert.deepEqual(sameDataset.recentTurns, []);
  assert.deepEqual(sameDataset.displayedProducts, []);

  const restored = buildDialogueContext({
    datasetVersion: "dataset-new", ranking: { ranked: [], referenceOnly: [], rejected: [], evaluatedCount: 0 },
    explanation: { kind: "REVIEW_SUMMARY", text: "상품을 선택해 주세요.", items: [], limitations: [],
      reviewSummary: { status: "AMBIGUOUS", focus: "CONS", choices: [{ productId: "p-choice", name: "선택 상품" }], evidence: [] } },
    shoppingPlan: { query: "수분크림", maxTotalWon: null, requiredConditions: [], currentPreferences: {}, revision: 1,
      lastDisplayedProducts: [{ productId: "p-choice", variantId: "v-choice", name: "선택 상품", displayIndex: 1 }] },
    pendingReview: { productId: "p-choice", variantId: "v-choice", focus: "CONS" },
  } as never, [], "dataset-new") as unknown as Record<string, unknown>;
  assert.deepEqual(restored.displayedProducts, [{ productId: "p-choice", variantId: "v-choice", name: "선택 상품" }]);
  assert.deepEqual(restored.pendingReview, { productId: "p-choice", variantId: "v-choice", focus: "CONS" });

  const unknownVersion = buildDialogueContext({
    datasetVersion: undefined, recentTurns: [{ user: "old words", assistant: "old answer" }],
  } as never, [], "dataset-new") as Record<string, unknown>;
  assert.deepEqual(unknownVersion.recentTurns, [], "unknown old dataset version is treated as a mismatch");
});
