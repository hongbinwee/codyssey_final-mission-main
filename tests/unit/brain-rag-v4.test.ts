import test from "node:test";
import assert from "node:assert/strict";
import { ok } from "../../src/contracts.ts";
import * as rag from "../../src/brain/rag-adapter.ts";
import * as catalog from "../../src/catalog.ts";
import { retrieveTurn } from "../../src/brain/read-flow.ts";

const DATASET_VERSION = "fixture-v4-version";
const REVIEW_BODY = "피부가 편안하고 보습이 오래 유지됩니다.";
const EVIDENCE_TEXT = "보습이 오래 유지됩니다.";

function v4Response() {
  return {
    dataset_version: DATASET_VERSION,
    items: [{
      product_id: "p-v4-1",
      rrf_score: 0.987,
      evidence: [{
        source_id: "r-v4-1",
        evidence_text: EVIDENCE_TEXT,
        source_metadata: {
          variant_id: "v-v4-1",
          source_kind: "SYNTHETIC",
          synthetic: true,
        },
      }],
    }],
  };
}

function productDetail(productId = "p-v4-1", variantId = "v-v4-1", options: {
  simulatedCatalog?: boolean; images?: string[]; effectiveSpecs?: Record<string, string>;
  productName?:string; productSpecs?:Record<string,string>;
} = {}) {
  return ok({
    ...(options.simulatedCatalog ? { catalog_context: {
      source: "test_items" as const, read_only: true as const, is_simulated: true as const,
    } } : {}),
    product: {
      id: productId, name: options.productName??"Commerce product", brand: "Brand", category: "beauty",
      description: "", images: options.images ?? [], specs: options.productSpecs??{}, active: true, version: 3,
      availability: "AVAILABLE" as const,
    },
    variants: [{
      variant_id: variantId, option_values: {}, effective_specs: options.effectiveSpecs ?? {},
      unit_price_won: 39_900, stock_qty: 4, availability: "AVAILABLE" as const, version: 2,
    }],
    shipping_fee_won: 3_000,
  }, "trace");
}

type FixtureReview = {
  id: string; product_id: string; variant_id: string|null; rating: number; body: string;
  source_kind: "REAL" | "SYNTHETIC"; source_ref: string; written_at: string;
};

function review(overrides: Partial<FixtureReview> = {}): FixtureReview {
  return {
    id: "r-v4-1", product_id: "p-v4-1", variant_id: "v-v4-1",
    rating: 5, body: REVIEW_BODY, source_kind: "SYNTHETIC",
    source_ref: "fixture-v4-review", written_at: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

test('remote profile is explicit, response profile is checked and low relevance never becomes recommendations',async()=>{
 let sent:any;const connection={endpoint:'https://rag.example.invalid/v1/rag/search',mode:'remote' as const,contract:'v4' as const,profile:'test_items2',datasetVersion:DATASET_VERSION,category:'beauty'};
 const fetcher=(reply:unknown)=>(async(_u:unknown,init:RequestInit)=>{sent=JSON.parse(init.body as string);return new Response(JSON.stringify(reply));}) as typeof fetch;
 const raw={...v4Response(),profile_name:'test_items2',status:'ok'};
 const build=(reply:unknown)=>rag.verifiedRagRetriever(connection,async()=>productDetail(),fetcher(reply),async()=>[review()]);
 const request={query:'수분크림',originalQuestion:'수분크림 추천해줘',requestId:'remote-test',maxTotalWon:null,requiredConditions:[]};
 assert.equal((await build(raw).search(request)).candidates.length,1);
 assert.equal(sent.profile,'test_items2');
 const global=rag.verifiedRagRetriever({...connection,category:'',categories:['beauty','fashion','food','living']},async()=>productDetail(),fetcher(raw),async()=>[review()]);
 await global.search(request);assert.equal(Object.hasOwn(sent,'category'),false,'unknown category must be omitted, never sent as empty string');
  await global.search({...request,maxTotalWon:20000,preferences:['가성비 중심','선물용'],requiredConditions:['무향']});
  assert.deepEqual(sent.preferences,['가성비 중심','선물용']);
  assert.deepEqual(sent.filters,{in_stock:true,price_max:20000,currency:'KRW'});
  assert.deepEqual(sent.required_conditions,['무향']);
  await assert.rejects(()=>global.search({...request,preferences:['x'.repeat(129)]}),/context/);
 await assert.rejects(()=>build({...raw,profile_name:'all_products'}).search(request),/profile/);
 assert.deepEqual(await build({...raw,status:'low_relevance'}).search(request),{candidates:[],evidence:[]});
 await assert.rejects(()=>build({...raw,status:'error',error_code:'database_unavailable'}).search(request),/failed/);
});
test('product-only remote hits keep Commerce facts without inventing reviews or accepting an unknown selected variant',async()=>{
 const raw={...v4Response(),items:[{product_id:'p-v4-1',rrf_score:0.1,commerce:{variant_id:'v-v4-1'},evidence:[{source_type:'product',source_id:'p-v4-1',evidence_text:'Untrusted marketing copy'}]}]};
 let reviewCalls=0;
 const build=()=>rag.verifiedRagRetriever({endpoint:'https://rag.example.invalid/search',contract:'v4',datasetVersion:DATASET_VERSION,category:'beauty',catalogSource:'test_items'},async()=>productDetail('p-v4-1','v-v4-1',{simulatedCatalog:true}),(async()=>new Response(JSON.stringify(raw))) as typeof fetch,async()=>{reviewCalls++;return [];});
 const request={query:'세탁세제',originalQuestion:'세탁세제 추천해줘',requestId:'product-only',maxTotalWon:null,requiredConditions:[]};
 const result=await build().search(request);assert.equal(result.candidates.length,1);assert.equal(result.evidence.filter(e=>e.kind==='REVIEW').length,0);assert.equal(reviewCalls,0);assert.equal(result.candidates[0].unitPriceWon,39900);
 assert.doesNotMatch(JSON.stringify(result),/Untrusted marketing/);
 raw.items[0].commerce.variant_id='wrong-variant';assert.deepEqual((await build().search(request)).candidates,[]);
});

test("source-only v4 parser preserves configured dataset and synthetic evidence metadata", () => {
  const parse = (rag as unknown as {
    parseV4Response?: (raw: unknown, expectedVersion: string) => {
      datasetVersion: string;
      items: Array<{ productId: string; rrfScore: number; evidence: Array<{
        sourceId: string; evidenceText: string; variantId: string;
        sourceKind: string; synthetic: boolean;
      }> }>;
    };
  }).parseV4Response;
  assert.equal(typeof parse, "function");
  if (!parse) return;

  const parsed = parse(v4Response(), DATASET_VERSION);
  assert.equal(parsed.datasetVersion, DATASET_VERSION);
  assert.equal(parsed.items[0].productId, "p-v4-1");
  assert.equal(parsed.items[0].rrfScore, 0.987);
  assert.deepEqual(parsed.items[0].evidence[0], {
    sourceId: "r-v4-1",
    evidenceText: EVIDENCE_TEXT,
    variantId: "v-v4-1",
    sourceKind: "SYNTHETIC",
    synthetic: true,
  });
});

test("versioned RAG preserves REAL evidence and rejects inconsistent provenance", () => {
  const parse = (rag as unknown as {
    parseV4Response?: (raw: unknown, expectedVersion: string) => unknown;
  }).parseV4Response;
  assert.equal(typeof parse, "function");
  if (!parse) return;

  assert.throws(() => parse({ ...v4Response(), dataset_version: "other-version" }, DATASET_VERSION), /version/i);
  const realSource = v4Response();
  realSource.items[0].evidence[0].source_metadata.source_kind = "REAL";
  realSource.items[0].evidence[0].source_metadata.synthetic = false;
  const parsed=rag.parseV4Response(realSource,DATASET_VERSION);
  assert.equal(parsed.items[0].evidence[0].sourceKind,"REAL");
  assert.equal(parsed.items[0].evidence[0].synthetic,false);
  realSource.items[0].evidence[0].source_metadata.synthetic=true;
  assert.throws(()=>parse(realSource,DATASET_VERSION),/inconsistent/i);
});

test("v4 live mixed chunks keep synthetic reviews and skip product-description chunks", () => {
  const response=v4Response();
  const review=response.items[0].evidence[0];
  const scopedReview={...review,product_id:"p-v4-1",source_type:"review",source_version:DATASET_VERSION};
  const productChunk={product_id:"p-v4-1",source_type:"product",source_id:"p-v4-1",
    source_version:DATASET_VERSION,evidence_text:"상품 설명",source_metadata:{}};
  const parsed=rag.parseV4Response({...response,items:[{...response.items[0],
    evidence:[productChunk,scopedReview,productChunk]}]},DATASET_VERSION);
  assert.equal(parsed.items[0].evidence.length,1);
  assert.equal(parsed.items[0].evidence[0].sourceId,"r-v4-1");
  const productOnly=rag.parseV4Response({...response,items:[{...response.items[0],
    evidence:[productChunk]}]},DATASET_VERSION);
  assert.deepEqual(productOnly.items[0].evidence,[]);
});

test("v4 live review scope rejects cross-product and cross-version evidence", () => {
  const response=v4Response();
  for(const override of [{product_id:"other-product"},{source_version:"other-version"}]){
    const review={...response.items[0].evidence[0],product_id:"p-v4-1",
      source_type:"review",source_version:DATASET_VERSION,...override};
    assert.throws(()=>rag.parseV4Response({...response,items:[{...response.items[0],
      evidence:[review]}]},DATASET_VERSION),/scope|version/i);
  }
});

test("unknown source_version is not confused with the verified dataset envelope",()=>{
 const response=v4Response();
 const withUnknown={...response,items:[{...response.items[0],evidence:[{...response.items[0].evidence[0],source_version:null}]}]};
 assert.equal(rag.parseV4Response(withUnknown,DATASET_VERSION).items[0].evidence[0].sourceId,"r-v4-1");
 assert.throws(()=>rag.parseV4Response({...withUnknown,dataset_version:"other"},DATASET_VERSION),/version/);
});

test("read flow forwards the trace id and unmodified question separately from the intent query", async () => {
  let observed: Record<string, unknown> | undefined;
  await retrieveTurn(
    {
      actorUserId: "user-1",
      conversationId: "00000000-0000-4000-8000-000000000001",
      requestId: "trace-request-42",
      userMessage: "원문 질문: 민감 피부용 보습 크림을 찾아줘",
      clientActionId: "action-1",
    },
    { messageId: "message-1", memories: [], startedAt: performance.now(), memoryMs: 0 } as never,
    { query: "보습 크림", maxTotalWon: null, requiredConditions: [], currentPreferences: {}, revision: 1 },
    {
      retriever: {
        search: async (input: Record<string, unknown>) => {
          observed = input;
          return { candidates: [], evidence: [] };
        },
      },
    } as never,
  );

  assert.equal(observed?.requestId, "trace-request-42");
  assert.equal(observed?.originalQuestion, "원문 질문: 민감 피부용 보습 크림을 찾아줘");
  assert.equal(observed?.query, "보습 크림");
});

test("read-flow exposes only condition-unverified synthetic references and keeps budget failures rejected", async () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    productName: "Commerce product", productId: "p-v4-1", variantId: "v-v4-1",
    unitPriceWon: 39_900, shippingFeeWon: 3_000, rating: null, ratingScale: null,
    wholeReviewCount: null, wholeReviewCountVerified: false, conditions: {}, facets: {},
    sourceKind: "SYNTHETIC", datasetVersion: DATASET_VERSION, commerceVerified: true,
    ...overrides,
  });
  const run = async (item: Record<string, unknown>, evidence: Array<Record<string, unknown>> = [], maxTotalWon: number | null = null) =>
    retrieveTurn(
      {
        actorUserId: "user-1", conversationId: "00000000-0000-4000-8000-000000000001",
        requestId: "trace-request-42", userMessage: "민감 피부용 보습 크림", clientActionId: "action-1",
      },
      { messageId: "message-1", memories: [], startedAt: performance.now(), memoryMs: 0 } as never,
      { query: "보습 크림", maxTotalWon, requiredConditions: ["민감성 피부"], currentPreferences: {}, revision: 1 },
      { retriever: { search: async () => ({ candidates: [item], evidence }) } } as never,
    );

  const conditionOnly = await run(candidate());
  assert.equal(conditionOnly.result.ranking.ranked.length, 0);
  assert.deepEqual(conditionOnly.result.ranking.referenceOnly.map((row) => row.candidate.productId), ["p-v4-1"]);
  assert.deepEqual(conditionOnly.result.ranking.referenceOnly[0].reasons, ["unverified_required_condition:민감성 피부"]);
  assert.deepEqual(conditionOnly.result.ranking.rejected, []);

  const approvedQaButMissingCondition = await run(candidate({ isSimulated: true }), [{
    id: "qa-review", sourceId: "qa-review", productId: "p-v4-1", variantId: "v-v4-1",
    kind: "REVIEW", sourceKind: "SYNTHETIC", verified: true,
    datasetVersion: DATASET_VERSION, rating: 5,
  }]);
  assert.equal(approvedQaButMissingCondition.result.ranking.ranked.length, 0);
  assert.deepEqual(approvedQaButMissingCondition.result.ranking.referenceOnly, []);
  assert.deepEqual(approvedQaButMissingCondition.result.ranking.rejected[0].reasons,
    ["unverified_required_condition:민감성 피부"]);

  const overBudget = await run(candidate({ unitPriceWon: 120_000 }), [], 100_000);
  assert.equal(overBudget.result.ranking.ranked.length, 0);
  assert.deepEqual(overBudget.result.ranking.referenceOnly, []);
  assert.deepEqual(overBudget.result.ranking.rejected[0].reasons, [
    "over_total_budget", "unverified_required_condition:민감성 피부",
  ]);

  const crossProductCondition = await run(
    candidate({ conditions: { "민감성 피부": ["cross-product-evidence"] } }),
    [{ id: "cross-product-evidence", productId: "another-product", variantId: null, kind: "SPEC" }],
  );
  assert.deepEqual(crossProductCondition.result.ranking.referenceOnly, []);
  assert.deepEqual(crossProductCondition.result.ranking.rejected[0].reasons, [
    "unverified_required_condition:민감성 피부",
  ]);
});

test("v4 request follows the fixed contract and only verified Commerce data becomes a candidate", async () => {
  let requestBody: Record<string, unknown> | undefined;
  let commerceCalls = 0;
  let reviewCalls = 0;
  const factory = (rag as unknown as { verifiedRagRetriever: (...args: unknown[]) => {
    search(input: Record<string, unknown>): Promise<{ candidates: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> }>;
  } }).verifiedRagRetriever;
  let retriever: ReturnType<typeof factory> | undefined;
  assert.doesNotThrow(() => {
    retriever = factory(
      {
        endpoint: "http://127.0.0.1:7888/rag",
        contract: "v4",
        datasetVersion: DATASET_VERSION,
        category: "beauty",
        catalogSource: "test_items",
        timeoutMs: 1_000,
      },
      async ({ product_id }: { product_id: string }) => {
        commerceCalls++;
        return productDetail(product_id);
      },
      async (_url: unknown, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(v4Response()), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
      async ({ product_id, review_ids }: { product_id: string; review_ids: string[] }) => {
        reviewCalls++;
        assert.equal(product_id, "p-v4-1");
        assert.deepEqual(review_ids, ["r-v4-1"]);
        return [review()];
      },
    );
  });
  assert.ok(retriever);

  const result = await retriever!.search({
    requestId: "trace-request-42",
    originalQuestion: "원문 질문: 민감 피부용 보습 크림을 찾아줘",
    query: "보습 크림",
    maxTotalWon: 100_000,
    requiredConditions: [],
  });

  assert.deepEqual(requestBody, {
    request_id: "trace-request-42",
    original_question: "원문 질문: 민감 피부용 보습 크림을 찾아줘",
    query: "보습 크림",
    category: "beauty",
    filters: {},
    required_conditions: [],
    preferences: [],
    top_k: 5,
  });
  assert.equal(Object.hasOwn(requestBody!, "profile"), false);
  assert.equal(Object.hasOwn(requestBody!, "catalogSource"), false);
  assert.equal(commerceCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].unitPriceWon, 39_900);
  assert.equal(result.candidates[0].shippingFeeWon, 3_000);
  assert.equal(result.candidates[0].rating, null);
  assert.equal(result.candidates[0].wholeReviewCount, null);
  assert.equal(result.candidates[0].wholeReviewCountVerified, false);
  assert.equal(result.candidates[0].sourceKind, "SYNTHETIC");
  assert.equal(result.candidates[0].isSimulated, undefined, "public/default scope cannot enable simulated ranking");
  assert.equal(result.candidates[0].datasetVersion, DATASET_VERSION);
  assert.deepEqual(result.candidates[0].facets, { retrieved_review_rating: {
    score: 1, evidenceIds: ["r-v4-1"],
  } });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].id, "r-v4-1");
  assert.equal(result.evidence[0].sourceId, "r-v4-1");
  assert.equal(result.evidence[0].text, EVIDENCE_TEXT);
  assert.equal(result.evidence[0].verified, true);
  assert.equal(result.evidence[0].sourceKind, "SYNTHETIC");
  assert.equal(result.evidence[0].datasetVersion, DATASET_VERSION);
});

test("QA v4 maps only verified Commerce conditions and uses exact retrieved ratings as a synthetic facet", async () => {
  const payload = v4Response();
  payload.items[0].evidence.push({
    source_id: "r-v4-2", evidence_text: "피부가 편안하고",
    source_metadata: { variant_id: "v-v4-1", source_kind: "SYNTHETIC", synthetic: true },
  });
  let requestBody: Record<string, unknown> | undefined;
  const retriever = rag.verifiedRagRetriever({ endpoint: "http://127.0.0.1:7888/rag",
    contract: "v4", datasetVersion: DATASET_VERSION, category: "beauty", catalogSource: "test_items" },
    async ({ product_id }) => productDetail(product_id, "v-v4-1", {
      simulatedCatalog: true, images: ["https://cdn.example.test/cream.png"],
      effectiveSpecs: {
        scent: "무향",
        "원본 목록 세부 카테고리": "스킨케어/메이크업",
        "상품명 표기 용량 (SKU 미확인)": "200ml",
        "상품명 표기 제품 유형 (미확인)": "...",
        real_stock_verified: "false",
        real_variant_verified: "false",
        price_evidence: "MOCK_HISTORICAL",
        fragrance_free: "아니요",
      },
    }), async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(payload), { status: 200,
        headers: { "content-type": "application/json" } });
    }, async ({ product_id, review_ids }) => [
      review({ id: "r-v4-1", product_id, rating: 4, body: REVIEW_BODY }),
      review({ id: "r-v4-2", product_id, rating: 2, body: "피부가 편안하고 자극이 적습니다." }),
    ]);

  const result = await retriever.search({ requestId: "request-1", originalQuestion: "무향 크림",
    query: "크림", maxTotalWon: null,
    requiredConditions: ["무향", "200ml", "false", "MOCK_HISTORICAL", "아니요", "피부 효능"] });
  const candidate = result.candidates[0];
  assert.equal(candidate.sourceKind, "SYNTHETIC");
  assert.equal(candidate.isSimulated, true);
  assert.equal(candidate.commerceVerified, true);
  assert.equal(candidate.productImage, "https://cdn.example.test/cream.png");
  assert.ok(candidate.keywords?.includes("scent: 무향"));
  assert.ok(!candidate.keywords?.some(value => /200ml|false|MOCK_HISTORICAL|아니요/.test(value)));
  assert.deepEqual(Object.keys(candidate.conditions), ["무향"]);
  const condition = result.evidence.find(row => row.id === candidate.conditions["무향"]?.[0]);
  assert.deepEqual([condition?.kind, condition?.productId, condition?.variantId,
    condition?.sourceKind, condition?.verified, condition?.datasetVersion],
  ["SPEC", "p-v4-1", "v-v4-1", "SYNTHETIC", true, DATASET_VERSION]);
  assert.deepEqual(Object.keys(candidate.facets), ["retrieved_review_rating"]);
  assert.equal(candidate.facets.retrieved_review_rating?.score, 0.6);
  assert.deepEqual(candidate.facets.retrieved_review_rating?.evidenceIds, ["r-v4-1", "r-v4-2"]);
  assert.deepEqual(result.evidence.filter(row => row.kind === "REVIEW").map(row => row.rating), [4, 2]);
  assert.equal(candidate.rating, null);
  assert.equal(candidate.wholeReviewCountVerified, false);
  assert.deepEqual(requestBody?.preferences, []);
  assert.equal(requestBody?.top_k, 5);
  assert.equal(Object.hasOwn(requestBody ?? {}, "isSimulated"), false);
});

test("getReviewsByIds scopes parameterized lookup to the exact product and review IDs", async () => {
  const getReviewsByIds = (catalog as unknown as {
    getReviewsByIds?: (input: { product_id: string; review_ids: string[] }, db?: unknown) => Promise<Array<Record<string, unknown>>>;
  }).getReviewsByIds;
  assert.equal(typeof getReviewsByIds, "function");
  if (!getReviewsByIds) return;

  let query = "";
  let params: unknown[] = [];
  const rows = await getReviewsByIds({
    product_id: "p-v4-1",
    review_ids: ["r-v4-1"],
  }, {
    unsafe: async (sql: string, args: unknown[]) => {
      query = sql;
      params = args;
      return [review()];
    },
  });

  assert.match(query, /WHERE product_id\s*=\s*\$1\s+AND id\s*=\s*ANY\(\$2\)/i);
  assert.deepEqual(params, ["p-v4-1", ["r-v4-1"]]);
  assert.equal(rows[0].id, "r-v4-1");
  assert.equal(rows[0].product_id, "p-v4-1");
});


function makeV4Retriever({
  payload = v4Response(),
  getProduct = async ({ product_id }: { product_id: string }) => productDetail(product_id),
  reviewLookup = async () => [review()],
  fetcher,
  timeoutMs = 1_000,
  datasetVersion = DATASET_VERSION,
}: {
  payload?: unknown;
  getProduct?: (input: { product_id: string }) => Promise<unknown>;
  reviewLookup?: (input: { product_id: string; review_ids: string[] }) => Promise<unknown[]>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  datasetVersion?: string;
} = {}) {
  const factory = (rag as unknown as {
    verifiedRagRetriever: (...args: unknown[]) => {
      search(input: Record<string, unknown>): Promise<{ candidates: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> }>;
    };
  }).verifiedRagRetriever;
  return factory(
    {
      endpoint: "http://127.0.0.1:7888/rag",
      contract: "v4",
      datasetVersion,
      category: "beauty",
      timeoutMs,
    },
    getProduct,
    fetcher ?? (async () => new Response(JSON.stringify(payload), { status: 200 })),
    reviewLookup,
  );
}

const searchInput = {
  requestId: "trace-request-42",
  originalQuestion: "원문 질문",
  query: "보습 크림",
  maxTotalWon: null,
  requiredConditions: [],
};

test("a matching spec key alone cannot prove a mandatory condition with a different value", async()=>{
  const retriever=makeV4Retriever({getProduct:async()=>productDetail("p-v4-1","v-v4-1",{
    effectiveSpecs:{"무향":"유향",skin_type:"민감성 피부",waterproof:"true"},
  })});
  const result=await retriever.search({...searchInput,requiredConditions:["무향","민감성 피부","waterproof"]});
  const conditions=result.candidates[0].conditions as Record<string,string[]>;
  assert.equal(conditions["무향"],undefined);
  assert.ok(conditions["민감성 피부"].length>0);
  assert.ok(conditions.waterproof.length>0);
});

test("simulation provenance stays true even when the server has not authorized QA ranking",async()=>{
  const retriever=makeV4Retriever({getProduct:async()=>productDetail("p-v4-1","v-v4-1",{simulatedCatalog:true})});
  const result=await retriever.search(searchInput);
  assert.equal(result.candidates[0].isSimulated,true);
  assert.notEqual(result.candidates[0].qaRankingEligible,true);
});

test("local trace counts reviews separately from Commerce spec evidence",async()=>{
  const retriever=rag.verifiedRagRetriever({mode:"local",endpoint:"http://127.0.0.1/local",contract:"v4",datasetVersion:DATASET_VERSION,catalogSource:"test_items"},
    async()=>productDetail("p-v4-1","v-v4-1",{simulatedCatalog:true,effectiveSpecs:{scent:"무향",finish:"보송"}}),
    rag.localRagFetcher(async()=>v4Response()),async()=>[review()]);
  const result=await retriever.search(searchInput);
  assert.equal(result.evidence.length,3);
  assert.equal(result.trace?.verifiedReviewCount,1);
});

test("v4 parser rejects another version and duplicate products but accepts zero items", () => {
  const parse = (rag as unknown as {
    parseV4Response?: (raw: unknown, expectedVersion: string) => { items: unknown[] };
  }).parseV4Response;
  assert.equal(typeof parse, "function");
  if (!parse) return;

  assert.throws(() => parse({ ...v4Response(), dataset_version: "other-version" }, DATASET_VERSION), /version/i);

  const duplicateProduct = v4Response();
  duplicateProduct.items.push(structuredClone(duplicateProduct.items[0]));
  assert.throws(() => parse(duplicateProduct, DATASET_VERSION), /duplicate/i);

  assert.deepEqual(parse({ dataset_version: DATASET_VERSION, items: [] }, DATASET_VERSION).items, []);
  const fiveItems={dataset_version:DATASET_VERSION,items:Array.from({length:5},(_,index)=>({
    product_id:`p-${index}`,rrf_score:.5,evidence:[],
  }))};
  assert.equal(parse(fiveItems,DATASET_VERSION).items.length,5);
  const sixItems={...fiveItems,items:[...fiveItems.items,{product_id:"p-5",rrf_score:.5,evidence:[]}]};
  assert.throws(()=>parse(sixItems,DATASET_VERSION),/shape|limit/i);
});

test("v4 deduplicates one original review only within matching product, option and provenance", () => {
  const response = v4Response();
  response.items[0].evidence.push(structuredClone(response.items[0].evidence[0]));
  const parsed = rag.parseV4Response(response, DATASET_VERSION);
  assert.equal(parsed.items[0].evidence.length, 1);
  assert.equal(parsed.items[0].evidence[0].sourceId, response.items[0].evidence[0].source_id);

  const otherProduct = structuredClone(response);
  otherProduct.items.push({ ...structuredClone(otherProduct.items[0]), product_id: "different-product" });
  assert.throws(() => rag.parseV4Response(otherProduct, DATASET_VERSION), /collision|scope/i);

  const otherOption = structuredClone(response);
  otherOption.items[0].evidence[1].source_metadata.variant_id = "different-option";
  assert.throws(() => rag.parseV4Response(otherOption, DATASET_VERSION), /collision/i);

  const otherSource = structuredClone(response);
  otherSource.items[0].evidence[1].source_metadata.source_kind = "REAL";
  otherSource.items[0].evidence[1].source_metadata.synthetic = false;
  assert.throws(() => rag.parseV4Response(otherSource, DATASET_VERSION), /collision/i);
});

test("v4 requires an exact configured version and ReviewLookup", () => {
  const factory = (rag as unknown as { verifiedRagRetriever: (...args: unknown[]) => unknown }).verifiedRagRetriever;
  assert.throws(() => factory({
    endpoint: "http://127.0.0.1:7888/rag",
    contract: "v4",
    category: "beauty",
  }, async () => productDetail(), async () => new Response("{}"), async () => [review()]), /dataset.?version/i);

  assert.throws(() => factory({
    endpoint: "http://127.0.0.1:7888/rag",
    contract: "v4",
    datasetVersion: DATASET_VERSION,
    category: "beauty",
  }, async () => productDetail(), async () => new Response("{}")), /ReviewLookup/i);
});

test("unmapped products and unavailable or mismatched variants contribute no candidate or evidence", async () => {
  const missingProduct = makeV4Retriever({
    getProduct: async () => ({ ok: false, error: { code: "NOT_FOUND" } }),
  });
  const noProduct = await missingProduct.search(searchInput);
  assert.deepEqual(noProduct.candidates, []);
  assert.deepEqual(noProduct.evidence, []);

  const wrongProduct = makeV4Retriever({
    getProduct: async () => productDetail("another-product", "v-v4-1"),
  });
  const crossProduct = await wrongProduct.search(searchInput);
  assert.deepEqual(crossProduct.candidates, []);
  assert.deepEqual(crossProduct.evidence, []);

  const noVariant = makeV4Retriever({
    getProduct: async () => productDetail("p-v4-1", "another-variant"),
  });
  const crossVariant = await noVariant.search(searchInput);
  assert.deepEqual(crossVariant.candidates, []);
  assert.deepEqual(crossVariant.evidence, []);

  const soldOut = makeV4Retriever({
    getProduct: async () => {
      const got = productDetail();
      if (got.ok) got.data.variants[0].stock_qty = 0;
      return got;
    },
  });
  const unavailable = await soldOut.search(searchInput);
  assert.deepEqual(unavailable.candidates, []);
  assert.deepEqual(unavailable.evidence, []);
});

test("review ID, product, variant, source, and forged-text mismatches fail closed", async () => {
  const mismatches = [
    review({ id: "different-review" }),
    review({ product_id: "different-product" }),
    review({ variant_id: "different-variant" }),
    review({ source_kind: "REAL" }),
    review({ body: "본문에 없는 조작된 문장입니다." }),
  ];
  for (const badReview of mismatches) {
    const retriever = makeV4Retriever({
      reviewLookup: async () => [badReview],
    });
    await assert.rejects(() => retriever.search(searchInput), /review|evidence|source|text/i);
  }
});

test("empty v4 result is normal and does not call Commerce or review lookup", async () => {
  let commerceCalls = 0;
  let reviewCalls = 0;
  const retriever = makeV4Retriever({
    payload: { dataset_version: DATASET_VERSION, items: [] },
    getProduct: async () => { commerceCalls++; return productDetail(); },
    reviewLookup: async () => { reviewCalls++; return [review()]; },
  });
  const result = await retriever.search(searchInput);
  assert.deepEqual(result, { candidates: [], evidence: [] });
  assert.equal(commerceCalls, 0);
  assert.equal(reviewCalls, 0);
});

test("v4 timeout aborts the injected fetch without making a network request", async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const retriever = makeV4Retriever({ timeoutMs: 100, fetcher });
  await assert.rejects(() => retriever.search(searchInput), { name: "TimeoutError" });
});

test("getReviewsByIds rejects more than its bounded ID batch before querying", async () => {
  const getReviewsByIds = (catalog as unknown as {
    getReviewsByIds?: (input: { product_id: string; review_ids: string[] }, db?: unknown) => Promise<unknown[]>;
  }).getReviewsByIds;
  assert.equal(typeof getReviewsByIds, "function");
  if (!getReviewsByIds) return;

  let queried = false;
  await assert.rejects(() => getReviewsByIds({
    product_id: "p-v4-1",
    review_ids: Array.from({ length: 301 }, (_, i) => "r-" + i),
  }, { unsafe: async () => { queried = true; return []; } }), /limit|maximum/i);
  assert.equal(queried, false);
});

test("QA category-independent gender requirement uses only verified product taxonomy or title, not fashion alone",async()=>{
 const find=async(name:string,specs:Record<string,string>={})=>{
   const retriever=makeV4Retriever({getProduct:async()=>productDetail("p-v4-1","v-v4-1",
     {productName:name,effectiveSpecs:specs})});
   return (await retriever.search({...searchInput,requiredConditions:["남성용"]})).candidates[0].conditions["남성용"];
 };
 assert.ok((await find("남성 어위크 드로즈 팬티"))?.length);
 assert.ok((await find("다슈 맨즈 에어핏 니플 밴드"))?.length);
 assert.ok((await find("드로즈 팬티",{"원본 목록 세부 카테고리":"속옷/홈웨어 > 남성 속옷"}))?.length);
 assert.equal(await find("여성용 팬티"),undefined);
 assert.equal(await find("팬티"),undefined);
 assert.equal(await find("남녀 공용 팬티",{"원본 목록 세부 카테고리":"여성 속옷"}),undefined);
});
