import assert from "node:assert/strict";
import { test } from "node:test";
import { decideHermesAction } from "../../src/brain/hermes-agent-step.ts";

test("Hermes opts into serial tool choice and rejects multi-call responses", async () => {
  let requestOptions: unknown;
  const provider = {
    async chat(_messages: unknown, _tools: unknown, options: unknown) {
      requestOptions = options;
      return {
        content: null,
        tool_calls: [
          { id: "call_history", name: "get_purchase_history", arguments: "{}" },
          { id: "call_search", name: "search_products", arguments: "{}" },
        ],
      };
    },
  };
  const decision = await decideHermesAction({
    provider: provider as never,
    message: "추천 상품 찾아줘",
    memories: [],
    plan: undefined,
    task: null,
    observations: [],
    tools: { purchases: async () => [], search: async () => ({ products: [] }) },
    offerSearch: true,
    startedAt: Date.now(),
  });
  assert.equal((requestOptions as { parallelToolCalls?: boolean } | undefined)?.parallelToolCalls, false);
  assert.deepEqual(decision, { kind: "FINISH", reason: "INVALID" });
});