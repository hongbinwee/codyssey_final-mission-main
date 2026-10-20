import test from "node:test";
import assert from "node:assert/strict";
import { ok } from "../../src/contracts.ts";
import { createIntentPort } from "../../src/brain/intent.ts";
import { providerIntentModel } from "../../src/brain/provider-intent.ts";
import { prepareTurn, resolveTurnPlan, retrieveTurn } from "../../src/brain/read-flow.ts";
import { verifiedRagRetriever,localRagFetcher } from "../../src/brain/rag-adapter.ts";
import { brainRagConnectionFromEnv } from "../../src/server.ts";
import { createLlmGroundedResponder } from "../../src/brain/grounded-response.ts";
import { createPersistentResearchGraph } from "../../src/brain/graph.ts";
import { MemorySaver } from "@langchain/langgraph";
import { BRAIN_SERVICE_RIGHTS,verifyPreparedBrainStorage } from "../../src/brain/runtime.ts";
import * as runtime from "../../src/brain/runtime.ts";
import {createBrainApi} from "../../src/brain/api.ts";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ResearchDeps } from "../../src/brain/read-flow.ts";
import type { Provider } from "../../src/llm.ts";

test("restored history is server actor scoped, bounded and never exposes raw checkpoint fields",async()=>{
 const calls:{query:string;args?:unknown[]}[]=[];
 const db={async unsafe(query:string,args?:unknown[]){
   calls.push({query,args});assert.match(query.trim(),/^SELECT/);
   if(query.includes("SELECT id FROM"))return args?.[0]==="tester_01"?[{id:"conv-1"}]:[];
   assert.deepEqual(args,["conv-1","tester_01"]);assert.match(query,/LIMIT 20/);
   return [{message_id:"m-1",client_action_id:"action-1",content:"합성 크림 질문",completed_result:JSON.stringify({conversationId:"conv-1",messageId:"m-1",clientActionId:"action-1",
     ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},shoppingPlan:{query:"크림"},
     explanation:{text:"합성 참고 답변",kind:"REFERENCE_ONLY"},trace:{totalMs:1},internalContext:"PRIVATE_CHECKPOINT"})}];
 }};
 const restored=await runtime.readBrainHistory(db as never,"tester_01");
 assert.equal(restored.conversationId,"conv-1");assert.equal(restored.entries[0].text,"합성 크림 질문");
 assert.equal(restored.entries[0].reply.message_id,"m-1");
 assert.ok(!JSON.stringify(restored).includes("PRIVATE_CHECKPOINT"));
 assert.deepEqual(await runtime.readBrainHistory(db as never,"tester_02"),{conversationId:null,entries:[]});
 const api=createBrainApi({recentHistory:(actor:string)=>runtime.readBrainHistory(db as never,actor)} as never);
 const result=await api("GET","/api/brain/history","tester_02",{actorUserId:"tester_01"});
 assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true,data:{conversationId:null,entries:[]}});
});

test("persistent local query encoder warms once and keeps secrets out of its child environment",async()=>{
 const stdout=new PassThrough(),stdin=new PassThrough(),stderr=new PassThrough();
 const child=Object.assign(new EventEmitter(),{stdout,stdin,stderr,kill(){child.emit("close",0);return true;}});
 const revision="a".repeat(40),queries:string[]=[];
 stdin.on("data",chunk=>{
   queries.push(JSON.parse(chunk.toString()).query);
   setImmediate(()=>stdout.write(JSON.stringify({model:"sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
     revision,dimensions:384,embedding:Array(384).fill(0.25)})+"\n"));
 });
 const factory=(runtime as unknown as {createLocalQueryEncoder:(options:unknown,spawn:unknown)=>Promise<{
   embedQuery:(query:string)=>Promise<number[]>;close:()=>void}>}).createLocalQueryEncoder;
 assert.equal(typeof factory,"function");
 const encoder=await factory({pythonPath:process.execPath,revision,modelCache:process.cwd()},
   (_exe:unknown,_args:unknown,options:{env:Record<string,string>})=>{
     assert.equal(options.env.HF_HUB_OFFLINE,"1");assert.equal(options.env.CODEX_V4_MODEL_REVISION,revision);
     assert.equal(options.env.LLM_API_KEY,undefined);assert.equal(options.env.DATABASE_URL,undefined);
     return child;
   });
 assert.equal(queries.length,1);
 const results=await Promise.all([encoder.embedQuery("보습"),encoder.embedQuery("자극")]);
 assert.deepEqual(results.map(x=>x.length),[384,384]);
 assert.deepEqual(queries.slice(1),["보습","자극"]);
 encoder.close();
 await assert.rejects(()=>encoder.embedQuery("closed"));
});

test("local encoder rejects mismatched model provenance before returning query vectors",async()=>{
 const factory=(runtime as unknown as {createLocalQueryEncoder:(options:unknown,spawn:unknown)=>Promise<unknown>}).createLocalQueryEncoder;
 const revision="a".repeat(40);
 for(const override of [{model:"different-model"},{revision:"b".repeat(40)},{dimensions:383},{embedding:[1]}]){
   const stdout=new PassThrough(),stdin=new PassThrough(),stderr=new PassThrough();
   let killed=0;
   const child=Object.assign(new EventEmitter(),{stdout,stdin,stderr,kill(){killed++;return true;}});
   stdin.on("data",()=>setImmediate(()=>stdout.write(JSON.stringify({
     model:"sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",revision,dimensions:384,
     embedding:Array(384).fill(.25),...override})+"\n")));
   await assert.rejects(()=>factory({pythonPath:process.execPath,revision,modelCache:process.cwd()},()=>child),/warmup failed/);
   assert.equal(killed,1);
 }
});

test("deployment manifest cannot be bypassed with an injected search or unverified encoder",async()=>{
 const dbUrl=new URL("postgres://127.0.0.1/brain_manifest_test");dbUrl.username="fixture";dbUrl.password="unit-only";
 const base={brainDatabaseUrl:dbUrl.toString(),provider:{name:"live:unit"},
  catalogSource:"test_items",rag:{mode:"local",contract:"v4",endpoint:"http://127.0.0.1/local",
   dataDir:process.cwd(),datasetVersion:"fixture",manifestPath:process.execPath}};
 await assert.rejects(()=>runtime.createBrainRuntime({...base,localRagSearch:async()=>({})} as never),/manifest.*injected/i);
 await assert.rejects(()=>runtime.createBrainRuntime({...base,embedQuery:async()=>[1]} as never),/manifest.*injected/i);
});

test("offline encoder uses manifest-selected model and dimensions without exposing secrets",async()=>{
 const stdout=new PassThrough(),stdin=new PassThrough(),stderr=new PassThrough();
 const child=Object.assign(new EventEmitter(),{stdout,stdin,stderr,kill(){return true;}});
 stdin.on("data",()=>setImmediate(()=>stdout.write(JSON.stringify({model:"org/audio-encoder",revision:"a".repeat(40),
  dimensions:2,embedding:[1,.5]})+"\n")));
 const encoder=await runtime.createLocalQueryEncoder({pythonPath:process.execPath,modelCache:process.cwd(),
  revision:"a".repeat(40),model:"org/audio-encoder",dimensions:2},((_file:unknown,_args:unknown,opts:{env:Record<string,string>})=>{
   assert.equal(opts.env.CODEX_RAG_MODEL_ID,"org/audio-encoder");assert.equal(opts.env.CODEX_RAG_DIMENSIONS,"2");
   assert.equal(opts.env.LLM_API_KEY,undefined);return child;
  }) as never);
 try{assert.deepEqual(await encoder.embedQuery("audio"),[1,.5]);}finally{encoder.close();}
});

test("runtime verifies pre-provisioned storage using SELECT only and fails closed without bootstrap rights",async()=>{
 const calls:string[]=[];
 const rights=Object.keys(BRAIN_SERVICE_RIGHTS).map(table_name=>({table_name,ready:true}));
 const probe=(rows:unknown[]=rights,version:number|null=5,task_path=true)=>({async unsafe(query:string){
   calls.push(query);assert.match(query.trim(),/^SELECT/);
   assert.doesNotMatch(query,/\b(?:CREATE|ALTER|GRANT|INSERT INTO|UPDATE\s+shopping_brain|DELETE FROM)\b/i);
   return query.includes("max(v)")?[{version,task_path}]:rows;
 }});
 await verifyPreparedBrainStorage(probe() as never);
 assert.equal(calls.length,2);
 assert.equal(Object.keys(BRAIN_SERVICE_RIGHTS).includes("rate_limit_windows"),false);
 await assert.rejects(()=>verifyPreparedBrainStorage(probe(rights.slice(1)) as never),/bootstrap/);
 await assert.rejects(()=>verifyPreparedBrainStorage(probe(rights.map((r,i)=>i===0?{...r,ready:false}:r)) as never),/permissions/);
 await assert.rejects(()=>verifyPreparedBrainStorage(probe(rights,4) as never),/migration/);
 await assert.rejects(()=>verifyPreparedBrainStorage(probe(rights,5,false) as never),/migration/);
 assert.deepEqual(BRAIN_SERVICE_RIGHTS.checkpoint_migrations,["SELECT"]);
});

test("mocked v4 read-flow to grounded response stays reference-only without running LangGraph", async () => {
  let providerCalls = 0;
  let ragCalls = 0;
  let commerceCalls = 0;
  let reviewCalls = 0;
  const quote = "향이 순해서 좋아요.";
  const provider: Pick<Provider, "chat"> = {
    async chat(_messages, tools) {
      providerCalls++;
      assert.deepEqual(tools, []);
      return { content: providerCalls === 1
        ? JSON.stringify({ query: "보습 크림", maxTotalWon: 50000, requiredConditions: ["민감성 피부"], currentPreferences: {}, queryMode: "SET", budgetMode: "SET" })
        : JSON.stringify({claims:[{ sourceKind: "SYNTHETIC", productId: "p-v4-1", variantId: "v-v4-1", sourceId: "r-v4-1", quote, polarity:"PRO", claim:"향이 순하다는 의견이 있어요." }]}) };
    },
  };
  const payload = {
    dataset_version: "fixture-v4-version",
    items: [{ product_id: "p-v4-1", rrf_score: 0.9, evidence: [{ source_id: "r-v4-1", evidence_text: quote,
      source_metadata: { variant_id: "v-v4-1", source_kind: "SYNTHETIC", synthetic: true } }] }],
  };
  const retriever = verifiedRagRetriever({ endpoint: "http://127.0.0.1:7888/rag", contract: "v4",
    datasetVersion: "fixture-v4-version", category: "beauty" }, async ({ product_id }) => {
    commerceCalls++;
    return ok({ product: { id: product_id, name: "Demo 보습 크림", brand: "Demo", category: "beauty",
      description: "", images: [], specs: {}, active: true, version: 1, availability: "AVAILABLE" as const },
      variants: [{ variant_id: "v-v4-1", option_values: {}, effective_specs: {}, unit_price_won: 39900,
        stock_qty: 2, availability: "AVAILABLE" as const, version: 1 }], shipping_fee_won: 3000 }, "trace");
  }, localRagFetcher(async (body) => {
    ragCalls++;
    assert.equal(body.original_question,"민감 피부에 맞는 보습 크림, 5만원 이하");
    return payload;
  }), async ({ product_id, review_ids }) => {
    reviewCalls++;
    assert.equal(product_id, "p-v4-1");
    assert.deepEqual(review_ids, ["r-v4-1"]);
    return [{ id: "r-v4-1", product_id, variant_id: "v-v4-1", rating: 5,
      body: "합성 참고 리뷰: 향이 순해서 좋아요. 보습감도 편안합니다.", source_kind: "SYNTHETIC",
      source_ref: "fixture-v4-review", written_at: "2026-10-17T00:00:00.000Z" }];
  });
  const deps = { conversations: { assertOwned: async () => {}, appendUserMessage: async () => "message-1" },
    memory: { list: async () => [] }, retriever, intent: createIntentPort(providerIntentModel(provider)) } as unknown as ResearchDeps;
  const request = { actorUserId: "user-1", conversationId: "conversation-1", requestId: "request-1",
    clientActionId: "action-1", userMessage: "민감 피부에 맞는 보습 크림, 5만원 이하" };
  const prepared = await prepareTurn(request, deps);
  const plan = await resolveTurnPlan(request, prepared, null, deps);
  const { result, evidence } = await retrieveTurn(request, prepared, plan, deps);
  const answer = await createLlmGroundedResponder(provider)({ originalQuestion: request.userMessage,
    ranking: result.ranking, evidence, plan });
  assert.equal(result.ranking.ranked.length, 0);
  assert.equal(result.ranking.referenceOnly.length, 1);
  assert.equal(answer.kind, "REFERENCE_ONLY");
  assert.equal(answer.items.length, 0);
  assert.equal(answer.citations?.[0]?.quote, quote);
  assert.match(answer.text, /시연 데이터 참고/);
  assert.match(answer.text, /향이 순하다는 의견/);
  assert.match(answer.text, /39,900원.*3,000원.*42,900원/);
  assert.deepEqual([providerCalls, ragCalls, commerceCalls, reviewCalls], [2, 1, 1, 1]);
});

test("local opt-in preserves remote config and rejects incomplete or network-fallback wiring",async()=>{
 const remote={BRAIN_RAG_URL:"http://127.0.0.1:18082/v1/rag/search",BRAIN_RAG_CONTRACT:"v4",BRAIN_RAG_DATASET_VERSION:"fixture-v4-version"};
 assert.equal(brainRagConnectionFromEnv(remote)?.endpoint,remote.BRAIN_RAG_URL);
 const local=brainRagConnectionFromEnv({...remote,BRAIN_RAG_MODE:"local",BRAIN_RAG_DATA_DIR:process.cwd()})!;
 assert.equal(local.mode,"local");assert.equal(local.dataDir,process.cwd());
 assert.throws(()=>brainRagConnectionFromEnv({...remote,BRAIN_RAG_MODE:"other"}));
 assert.throws(()=>brainRagConnectionFromEnv({...remote,BRAIN_RAG_MODE:"local",BRAIN_RAG_DATA_DIR:"relative"}));
 assert.throws(()=>verifiedRagRetriever(local,async()=>{throw Error("not called");},undefined,async()=>[]),/injected/);
 let calls=0;
 const transport=localRagFetcher(async body=>{calls++;return {dataset_version:"fixture-v4-version",items:[],request_id:body.request_id};});
 const response=await transport(local.endpoint,{method:"POST",body:JSON.stringify({request_id:"test"})});
 assert.deepEqual(await response.json(),{dataset_version:"fixture-v4-version",items:[],request_id:"test"});
 await assert.rejects(()=>transport(local.endpoint,{method:"GET"}),/invalid/);
 await assert.rejects(()=>transport(local.endpoint,{method:"POST",body:"{}",signal:AbortSignal.abort()}));
 assert.equal(calls,1);
});

test("LangGraph ranks server-approved QA v4 candidates and preserves plan while grounding synthetic sources", async () => {
  let providerCalls = 0, messageCount = 0, ragCalls = 0, commerceCalls = 0, reviewCalls = 0;
  const ragRequests: Record<string, unknown>[] = [];
  const quote = "향이 순해서 좋아요.";
  const intent1 = JSON.stringify({ query: "보습 크림", maxTotalWon: 50000,
    requiredConditions: ["민감성 피부"], currentPreferences: {}, queryMode: "SET",
    budgetMode: "SET", requirementsMode: "REPLACE" });
  const intent2 = JSON.stringify({ query: "보습 크림", maxTotalWon: null,
    requiredConditions: [], currentPreferences: {}, queryMode: "KEEP",
    budgetMode: "KEEP", requirementsMode: "KEEP" });
  const citation = JSON.stringify({recommendations:[{productId:"p-v4-1",variantId:"v-v4-1",factIds:["budget"],
    reviewClaims:[{sourceKind:"SYNTHETIC",productId:"p-v4-1",variantId:"v-v4-1",sourceId:"r-v4-1",quote,polarity:"PRO",claim:"향이 순하다는 의견이에요."}]}]});
  const provider: Pick<Provider, "chat"> = { async chat(_messages, tools) {
    assert.deepEqual(tools, []);
    providerCalls++;
    const outputs = [intent1, citation, intent2, citation];
    assert.ok(outputs[providerCalls - 1], "unexpected extra provider call");
    return { content: outputs[providerCalls - 1] };
  } };
  const payload = { dataset_version: "fixture-v4-version", items: [{ product_id: "p-v4-1",
    rrf_score: 0.9, evidence: [{ source_id: "r-v4-1", evidence_text: quote,
      source_metadata: { variant_id: "v-v4-1", source_kind: "SYNTHETIC", synthetic: true } }] }] };
  const retriever = verifiedRagRetriever({ endpoint: "http://127.0.0.1:7888/rag", contract: "v4",
    datasetVersion: "fixture-v4-version", category: "beauty", catalogSource: "test_items" }, async ({ product_id }) => {
    commerceCalls++;
    return ok({ catalog_context: { source: "test_items", read_only: true, is_simulated: true },
      product: { id: product_id, name: "Demo 보습 크림", brand: "Demo", category: "beauty",
      description: "", images: [], specs: {}, active: true, version: 1, availability: "AVAILABLE" as const },
      variants: [{ variant_id: "v-v4-1", option_values: {}, effective_specs: {
        skin_type: "민감성 피부", real_stock_verified: "false", real_variant_verified: "false",
        "상품명 표기 용량 (SKU 미확인)": "200ml", price_evidence: "MOCK_HISTORICAL",
      }, unit_price_won: 39900,
        stock_qty: 2, availability: "AVAILABLE" as const, version: 1 }], shipping_fee_won: 3000 }, "trace");
  }, async (url, init) => {
    ragCalls++;
    assert.equal(String(url), "http://127.0.0.1:7888/rag");
    ragRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(payload), { status: 200,
      headers: { "content-type": "application/json" } });
  }, async ({ product_id, review_ids }) => {
    reviewCalls++;
    assert.equal(product_id, "p-v4-1");
    assert.deepEqual(review_ids, ["r-v4-1"]);
    return [{ id: "r-v4-1", product_id, variant_id: "v-v4-1", rating: 5,
      body: "합성 참고 리뷰: 향이 순해서 좋아요. 보습감도 편안합니다.", source_kind: "SYNTHETIC",
      source_ref: "fixture-v4-review", written_at: "2026-10-17T00:00:00.000Z" }];
  });
  const deps = { conversations: {
    assertOwned: async (actor: string, conversation: string) => {
      assert.equal(actor, "user-1"); assert.equal(conversation, "conversation-1");
    },
    appendUserMessage: async () => `message-${++messageCount}`,
  }, memory: { list: async () => [] }, retriever,
  intent: createIntentPort(providerIntentModel(provider)) } as unknown as ResearchDeps;
  const graph = createPersistentResearchGraph(deps, new MemorySaver() as never, undefined,
    undefined, createLlmGroundedResponder(provider));
  const first = await graph.invoke({ actorUserId: "user-1", conversationId: "conversation-1",
    requestId: "request-1", clientActionId: "action-1",
    userMessage: "민감 피부 보습 크림, 5만원 이하" });
  const second = await graph.invoke({ actorUserId: "user-1", conversationId: "conversation-1",
    requestId: "request-2", clientActionId: "action-2", userMessage: "보습감도 알려줘" });
  for (const result of [first, second]) {
    assert.equal(result.ranking.ranked.length, 1);
    assert.equal(result.ranking.ranked[0].candidate.isSimulated, true);
    assert.equal(result.ranking.referenceOnly.length, 0);
    assert.equal(result.explanation?.kind, "LLM_GROUNDED");
    assert.deepEqual(result.explanation?.items.map(item => [item.productId, item.variantId,
      item.totalPriceWon, item.evidenceIds]), [["p-v4-1", "v-v4-1", 42_900, ["r-v4-1"]]]);
    assert.deepEqual(result.explanation?.citations?.map(c => [c.sourceId, c.sourceKind, c.quote]),
      [["r-v4-1", "SYNTHETIC", quote]]);
    assert.match(result.explanation?.items[0].reason ?? "", /42,900원.*예산/);
    assert.match(result.explanation?.items[0].reason ?? "", /합성 리뷰.*향이 순하다는 의견/);
    assert.doesNotMatch(result.explanation?.text ?? "", /p-v4-1|v-v4-1|r-v4-1/);
  }
  assert.equal(first.shoppingPlan?.maxTotalWon, 50000);
  assert.deepEqual(first.shoppingPlan?.requiredConditions, ["민감성 피부"]);
  assert.equal(second.shoppingPlan?.maxTotalWon, 50000);
  assert.deepEqual(second.shoppingPlan?.requiredConditions, ["민감성 피부"]);
  assert.deepEqual(ragRequests.map(r => r.required_conditions), [["민감성 피부"], ["민감성 피부"]]);
  assert.deepEqual(ragRequests.map(r => [r.preferences, r.top_k]), [[[ ], 10], [[ ], 10]]);
  assert.ok(ragRequests.every(r => !Object.hasOwn(r, "isSimulated")));
  assert.deepEqual([providerCalls, ragCalls, commerceCalls, reviewCalls, messageCount], [4, 2, 2, 2, 2]);
});
