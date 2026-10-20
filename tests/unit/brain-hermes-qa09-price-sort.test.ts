import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {resolveTurnPlan,retrieveTurn,type ResearchDeps} from "../../src/brain/read-flow.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {buildGroundedExplanation} from "../../src/brain/grounded-response.ts";
import {rankProducts} from "../../src/brain/personalization.ts";
import type {ShoppingPlan} from "../../src/brain/shopping-plan.ts";
import type {ProductCandidate,EvidenceRecord} from "../../src/brain/contracts.ts";

const candidate=(id:string,price:number,shipping:number|null=3000):ProductCandidate=>({
 productId:id,variantId:"v-"+id,productName:"세럼 "+id,unitPriceWon:price,shippingFeeWon:shipping,
 rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{},sourceKind:"REAL",commerceVerified:true,datasetVersion:"qa-price"
});
const products=[candidate("expensive-cart",26000),candidate("cheap",16000)];
const evidence=(id:string,productId:string):EvidenceRecord=>({id,sourceId:id,productId,variantId:null,
 kind:"REVIEW",sourceKind:"REAL",sourceRef:"commerce",text:"피부가 촉촉해서 좋아요.",verified:true,datasetVersion:"qa-price"});
const reviews=[evidence("r1","cheap"),evidence("r2","cheap"),evidence("r3","expensive-cart")];
const base:ShoppingPlan={query:"세럼",revision:1,minTotalWon:10000,maxTotalWon:39999,
 requiredConditions:[],currentPreferences:{}};
const extracted={query:"세럼",queryMode:"KEEP" as const,budgetMode:"KEEP" as const,requirementsMode:"KEEP" as const,
 context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};
const prepared=()=>({messageId:crypto.randomUUID(),memories:[],startedAt:performance.now(),memoryMs:0});
const req=(userMessage:string)=>({actorUserId:"actor",conversationId:"thread",requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage});
const deps=(rows=products,changes:Partial<ResearchDeps>={}):ResearchDeps=>({
 conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
 memory:{list:async()=>[],put:async()=>{},delete:async()=>false},intent:{extract:async()=>extracted},
 retriever:{search:async()=>({candidates:rows,evidence:reviews})},
 activity:async()=>({cartProductIds:["expensive-cart"],wishlistProductIds:["expensive-cart"]}),...changes
});
const ids=(ranking:Awaited<ReturnType<typeof retrieveTurn>>["result"]["ranking"])=>ranking.ranked.map(r=>r.candidate.productId);
const priceDirection=(plan:ShoppingPlan)=>(plan as ShoppingPlan&{priceSortOrder?:string}).priceSortOrder;
async function run(message:string,rows=products,previous=base,changes:Partial<ResearchDeps>={}){
 const d=deps(rows,changes),request=req(message),p=prepared();
 const plan=await resolveTurnPlan(request,p,previous,d);
 return {plan,...await retrieveTurn(request,p,plan,d)};
}

test("QA09 price ASC and DESC override cart/wishlist affinity using 19k and 29k totals",async()=>{
 const asc=await run("가격 낮은 순으로 추천해줘");
 assert.deepEqual(ids(asc.result.ranking),["cheap","expensive-cart"]);
 assert.equal(priceDirection(asc.plan),"ASC");
 const desc=await run("가격 높은 순으로 추천해줘");
 assert.deepEqual(ids(desc.result.ranking),["expensive-cart","cheap"]);
 assert.equal(priceDirection(desc.plan),"DESC");
});

test("QA09 price ordering uses shipping-inclusive totals rather than item prices",async()=>{
 const rows=[candidate("low-item",15000,10000),candidate("low-total",19000,0)];
 assert.deepEqual(ids((await run("가격 낮은 순",rows)).result.ranking),["low-total","low-item"]);
 assert.deepEqual(ids((await run("가격 높은 순",rows)).result.ranking),["low-item","low-total"]);
});

test("QA09 price order excludes missing shipping, unverified Commerce and unsafe totals",async()=>{
 const rows=[...products,candidate("unknown-shipping",10000,null),
 {...candidate("unverified",18000),commerceVerified:undefined},
 candidate("overflow",Number.MAX_SAFE_INTEGER,1)];
 const result=await run("가격 높은 순",rows,{...base,maxTotalWon:null});
 assert.deepEqual(ids(result.result.ranking),["expensive-cart","cheap"]);
 for(const id of ["unknown-shipping","unverified","overflow"])
  assert.ok(result.result.ranking.rejected.some(r=>r.candidate.productId===id),id);
});

test("QA09 price sort keeps budget and mandatory-condition gates before ordering",async()=>{
 const allowed={...candidate("allowed",20000),conditions:{fragrance_free:["spec"]}};
 const spec:EvidenceRecord={id:"spec",productId:"allowed",variantId:"v-allowed",kind:"SPEC",sourceKind:"REAL"};
 const result=await run("가격 높은 순",[allowed,candidate("over-budget",42000),candidate("missing-condition",18000)],
 {...base,requiredConditions:["fragrance_free"]},{retriever:{search:async()=>({candidates:[allowed,candidate("over-budget",42000),candidate("missing-condition",18000)],evidence:[spec]})}});
 assert.deepEqual(ids(result.result.ranking),["allowed"]);
});

test("QA09 budget-only request retains ordinary personalized ranking",async()=>{
 const result=await run("1~3만원대에서 추천해줘");
 assert.equal(priceDirection(result.plan),undefined);
 assert.deepEqual(ids(result.result.ranking),["expensive-cart","cheap"]);
});

test("QA09 price criterion survives follow-up and switches mutually exclusively with review sort",async()=>{
 const first=await run("가격 높은 순");
 const next=await run("향이 은은한 것만",products,first.plan);
 assert.equal(priceDirection(next.plan),"DESC");
 assert.deepEqual(ids(next.result.ranking),["expensive-cart","cheap"]);
 const review=await run("촉촉하다는 리뷰가 많은 순으로 추천해줘",products,next.plan);
 assert.equal(priceDirection(review.plan),undefined);assert.equal(review.plan.reviewSortAspect,"촉촉");
 assert.deepEqual(ids(review.result.ranking),["cheap","expensive-cart"]);
 const price=await run("이번엔 가격순으로",products,review.plan);
 assert.equal(priceDirection(price.plan),"ASC");assert.equal(price.plan.reviewSortAspect,undefined);
 assert.deepEqual(ids(price.result.ranking),["cheap","expensive-cart"]);
});

test("QA09 explicit sort cancellation restores personalization without clearing other conditions",async()=>{
 const initial=(await run("가격 낮은 순")).plan;
 for(const message of ["그냥 추천해줘","정렬 취소해줘","가격순 말고 그냥 추천해줘","가격 낮은 순 취소해줘","낮은 가격순 취소해줘","저렴한 순 말고 그냥 추천해줘"]){
  const result=await run(message,products,initial);
  assert.equal(priceDirection(result.plan),undefined,message);assert.equal(result.plan.reviewSortAspect,undefined,message);
  assert.equal(result.plan.minTotalWon,10000);assert.equal(result.plan.maxTotalWon,39999);
  assert.deepEqual(ids(result.result.ranking),["expensive-cart","cheap"],message);
 }
 const review={...initial,reviewSortAspect:"촉촉"};
 assert.equal((await run("그냥 추천해줘",products,review)).plan.reviewSortAspect,undefined);
});

test("QA09 cancellation and review/price transitions preserve unrelated required conditions",async()=>{
 const p={...(await run("가격 높은 순")).plan,requiredConditions:["fragrance_free"]};
 const cancelled=await resolveTurnPlan(req("그냥 추천해줘"),prepared(),p,deps());
 assert.deepEqual(cancelled.requiredConditions,["fragrance_free"]);assert.equal(cancelled.maxTotalWon,39999);
});

test("QA09 new query or category task cannot inherit old explicit sort",async()=>{
 const old=(await run("가격 높은 순")).plan;
 for(const extract of [{...extracted,query:"립밤",queryMode:"SET" as const,budgetMode:"KEEP" as const},
  {...extracted,queryMode:"SET" as const,budgetMode:"KEEP" as const},
  {...extracted,context:{...extracted.context,category:"electronics"}}]){
  const p=await resolveTurnPlan(req("새 상품 찾아줘"),prepared(),{...old,category:"beauty"},deps(products,{intent:{extract:async()=>extract}}));
  assert.equal(priceDirection(p),undefined);assert.equal(p.reviewSortAspect,undefined);
 }
});

test("QA09 price expressions distinguish ordering from budget or cancelled direction",async()=>{
 for(const message of ["가격순으로","낮은 가격순으로","가격 오름차순으로","저렴한 순으로"])
  assert.equal(priceDirection((await run(message)).plan),"ASC",message);
 for(const message of ["높은 가격순으로","가격 내림차순으로","비싼 순으로"])
  assert.equal(priceDirection((await run(message)).plan),"DESC",message);
 assert.equal(priceDirection((await run("가격 낮은 순 말고 높은 순으로")).plan),"DESC");
 for(const message of ["3만원 이하 추천","가격은 1~3만원대","저렴한 상품 추천"])
  assert.equal(priceDirection((await run(message)).plan),undefined,message);
});

test("QA09 interview skips also clear an explicit sort without losing its budget",async()=>{
 const p={...(await run("가격 높은 순")).plan,interview:{answered:[],pending:["purpose"]}} as ShoppingPlan;
 const cancelled=await resolveTurnPlan(req("그냥 추천해줘"),prepared(),p,deps(products,{clarifyBeforeSearch:true}));
 assert.equal(priceDirection(cancelled),undefined);assert.equal(cancelled.maxTotalWon,39999);
});

test("QA09 explicit price graph preserves order and truthful explanation through checkpoint follow-ups",async()=>{
 let modelCalls=0;
 const graph=createPersistentResearchGraph(deps(),new MemorySaver() as never,undefined,undefined,
 async()=>{modelCalls++;throw Error("explicit validated order must not use generic model claims");});
 const conversationId=crypto.randomUUID();
 const invoke=(message:string)=>graph.invoke({...req(message),conversationId});
 const asc=await invoke("1~3만원대 가격 낮은 순으로 추천해줘");
 assert.deepEqual(ids(asc.ranking),["cheap","expensive-cart"]);
 assert.deepEqual(asc.explanation?.items.map(x=>x.totalPriceWon),[19000,29000]);
 assert.match(asc.explanation?.text??"",/배송비 포함 합계.*낮은 순/);
 const desc=await invoke("가격 높은 순으로");
 assert.deepEqual(ids(desc.ranking),["expensive-cart","cheap"]);
 assert.match(desc.explanation?.text??"",/배송비 포함 합계.*높은 순/);
 const follow=await invoke("같은 조건으로 다시 보여줘");
 assert.equal(priceDirection(follow.shoppingPlan!),"DESC");
 assert.deepEqual(ids(follow.ranking),["expensive-cart","cheap"]);assert.equal(modelCalls,0);
});

test("QA09 no eligible price candidates never claim a successful sort",async()=>{
 const result=await run("가격 낮은 순",[candidate("unknown",19000,null)]);
 const explanation=buildGroundedExplanation(result.result.ranking,[],result.plan);
 assert.equal(explanation.items.length,0);assert.doesNotMatch(explanation.text,/정렬했어요/);
});

test("QA09 stable price ties keep deterministic existing score order and one option per product",async()=>{
 const rows=[candidate("a",16000),candidate("b",16000),{...candidate("a",17000),variantId:"a-other"}];
 const result=await run("가격 낮은 순",rows);
 assert.deepEqual(ids(result.result.ranking),["a","b"]);
 assert.equal(result.result.ranking.ranked[0].candidate.variantId,"v-a");
});


test("QA09 price order during product-type interview is not mistaken for a new product query",async()=>{
 const previous={...base,interview:{answered:[],pending:["product_type"]}} as ShoppingPlan;
 const plan=await resolveTurnPlan(req("가격 높은 순으로"),prepared(),previous,deps(products,{clarifyBeforeSearch:true}));
 assert.equal(plan.query,"세럼");assert.equal(priceDirection(plan),"DESC");
});

test("QA09 invalid or unordered totals cannot produce a successful sort claim",()=>{
 const plan={...base,priceSortOrder:"ASC"} as ShoppingPlan;
 const ranking=rankProducts(products,[],base,[]);
 const wrong={...ranking,ranked:[...ranking.ranked].reverse()};
 assert.doesNotMatch(buildGroundedExplanation(wrong,[],plan).text,/정렬했어요/);
});


test("QA09 a newly selected product type does not inherit the previous product sort",async()=>{
 const p={...(await run("가격 높은 순")).plan,interview:{answered:[],pending:["product_type"]}} as ShoppingPlan;
 const next=await resolveTurnPlan(req("립밤으로"),prepared(),p,deps(products,{clarifyBeforeSearch:true}));
 assert.equal(next.query,"립밤");assert.equal(priceDirection(next),undefined);
});


test("QA09 pure price-sort follow-up cannot be recast as a new query by the model",async()=>{
 let calls=0;
 const changes:Partial<ResearchDeps>={intent:{extract:async()=>{calls++;return {...extracted,query:"가격 높은 순",queryMode:"SET",budgetMode:"CLEAR",requirementsMode:"CLEAR"};}},clarifyBeforeSearch:true};
 const previous={...base,requiredConditions:["fragrance_free"],interview:{answered:[],pending:["product_type"]}} as ShoppingPlan;
 const plan=await resolveTurnPlan(req("이번엔 가격 높은 순으로 추천해줘"),prepared(),previous,deps(products,changes));
 assert.equal(plan.query,"세럼");assert.equal(priceDirection(plan),"DESC");assert.equal(plan.maxTotalWon,39999);
 assert.deepEqual(plan.requiredConditions,["fragrance_free"]);assert.equal(calls,0);
 const newQuery=await resolveTurnPlan(req("립밤 가격 높은 순으로 추천해줘"),prepared(),previous,deps(products,{intent:{extract:async()=>({...extracted,query:"립밤",queryMode:"SET",budgetMode:"KEEP"})}}));
 assert.equal(newQuery.query,"립밤");assert.equal(priceDirection(newQuery),"DESC");
});


test("QA09 polite sort-only follow-ups also preserve the product task without model extraction",async()=>{
 for(const message of ["가격 높은 순으로 추천해주세요","가격 높은 순으로 보여주세요","가격 낮은 순으로 정렬해 주세요"]){
  const plan=await resolveTurnPlan(req(message),prepared(),base,deps(products,{intent:{extract:async()=>{throw Error("sort-only request reached model");}}}));
  assert.equal(plan.query,"세럼");assert.equal(priceDirection(plan),message.includes("낮은")?"ASC":"DESC");
 }
});
