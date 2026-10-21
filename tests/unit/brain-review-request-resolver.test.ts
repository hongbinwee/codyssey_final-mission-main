import test from "node:test";
import assert from "node:assert/strict";
import type {Provider} from "../../src/llm.ts";
import type {ResearchResult} from "../../src/brain/read-flow.ts";
import type {DialogueContext} from "../../src/brain/dialogue-context.ts";
import {createReviewRequestResolver} from "../../src/brain/review-request-resolver.ts";
import {parseContextReviewRequest} from "../../src/brain/review-reference.ts";

type ModelResult={
 mode:"SUMMARY"|"SEMANTIC"|"COUNT"|"NONE";
 focus:"ALL"|"CONS";
 selection:"CURRENT"|"INDEX"|"INDEXES"|"ALL_DISPLAYED"|"NAME"|"NONE";
 index?:number;
 indexes?:number[];
 name?:string;
 query?:string;
 semanticQuery?:string;
 aspect?:string;
 compare?:boolean;
};
const rows=[
 {productId:"p-mask",variantId:"v-mask",name:"노프랍 하이드로겔 마스크팩",displayIndex:1},
 {productId:"p-cream",variantId:"v-cream",name:"히알 수분 크림",displayIndex:2},
 {productId:"p-pad",variantId:"v-pad",name:"넘버즈인 1번-5번 진정 패드",displayIndex:3},
];
function prior(patch:Record<string,unknown>={}):ResearchResult{
 return {datasetVersion:"dataset-1",conversationId:"c",messageId:"m",
  shoppingPlan:{query:"마스크팩",lastDisplayedProductIds:rows.map(row=>row.productId),lastDisplayedProducts:rows},
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
  explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:rows.map(row=>({
   productId:row.productId,variantId:row.variantId,name:row.name,totalPriceWon:10000,evidenceIds:[],indicators:[],
  })),limitations:[]},
  ...patch,
 } as unknown as ResearchResult;
}
function context(patch:Partial<DialogueContext>={}):DialogueContext{
 return {recentTurns:[],displayedProducts:rows.map(({productId,variantId,name})=>({productId,variantId,name})),
  approvedPreferences:[],...patch};
}
function resolverFor(result:ModelResult|Error){
 const calls:{messages:unknown;tools:unknown;options:unknown}[]=[];
 const provider:Pick<Provider,"chat">={async chat(messages,tools,options){
  calls.push({messages,tools,options});
  if(result instanceof Error)throw result;
  return {content:JSON.stringify(result)};
 }};
 const resolver=createReviewRequestResolver(provider);
 return {resolver,calls};
}
const model=(patch:Partial<ModelResult>={}):ModelResult=>({
 mode:"SUMMARY",focus:"ALL",selection:"NAME",name:"노프랍 하이드로겔 마스크팩",...patch,
});

test("named demonstrative review selects the unique verified prior product without exposing IDs to the model",async()=>{
 const {resolver,calls}=resolverFor(model());
 const route=await resolver({message:"노프랍 이거는 리뷰가 어떻게 돼",previous:prior(),context:context()});
 assert.equal(route?.kind,"REVIEW_SUMMARY");
 assert.deepEqual(route?.reviewSummary,{productId:"p-mask",variantId:"v-mask",focus:"ALL"});
 const request=calls[0]!;
 assert.deepEqual(request.tools,[]);
 assert.ok((request.options as {signal?:AbortSignal}).signal);
 assert.doesNotMatch(JSON.stringify(request.messages),/p-mask|p-cream|v-mask/);
});

test("semantic drawback request can target all validated displayed products",async()=>{
 const {resolver}=resolverFor(model({mode:"SEMANTIC",focus:"CONS",selection:"ALL_DISPLAYED",
  semanticQuery:"상품 리뷰에서 아쉬운 사용 경험과 불편한 점"}));
 const route=await resolver({message:"리뷰에 단점 있는거",previous:prior(),context:context()});
 assert.equal(route?.kind,"REVIEW_SUMMARY");
 assert.deepEqual(route?.reviewSummary,{productIds:["p-mask","p-cream","p-pad"],
  semanticQuery:"상품 리뷰에서 아쉬운 사용 경험과 불편한 점",focus:"CONS"});
});

test("an explicit earlier recommendation reference keeps all displayed products after a single-product summary",async()=>{
 const summarized=prior({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:{
  status:"READY",focus:"ALL",product:{id:"p-mask",name:"노프랍 하이드로겔 마스크팩"},evidence:[],
 }}});
 const {resolver}=resolverFor(model({mode:"SEMANTIC",focus:"ALL",selection:"ALL_DISPLAYED",
  semanticQuery:"몇 시간 지나면 건조해지는지"}));
 const route=await resolver({message:"아까 추천한 세 개 중 몇 시간 지나면 건조하다는 리뷰 찾아줘",
  previous:summarized,context:context()});
 assert.deepEqual(route?.reviewSummary,{productIds:["p-mask","p-cream","p-pad"],
  semanticQuery:"몇 시간 지나면 건조해지는지",focus:"ALL"});
});

test("a product name containing 1번-5번 is never treated as an ordinal but an explicit first rank is",async()=>{
 const {resolver,calls}=resolverFor(model({name:"넘버즈인 1번-5번 진정 패드"}));
 const named=await resolver({message:"넘버즈인 1번-5번 진정 패드 리뷰 요약해줘",previous:prior(),context:context()});
 assert.deepEqual(named?.reviewSummary,{productId:"p-pad",variantId:"v-pad",focus:"ALL"});
 const rankedResolver=resolverFor(model({selection:"INDEX",index:1}));
 const ranked=await rankedResolver.resolver({message:"1순위 상품 리뷰 요약해줘",previous:prior(),context:context()});
 assert.deepEqual(ranked?.reviewSummary,{productId:"p-mask",variantId:"v-mask",focus:"ALL"});
 assert.equal(calls.length,1);
});

test("only explicit rank wording selects a displayed product",async()=>{
 const numbered=resolverFor(model({selection:"INDEX",index:1})).resolver;
 const plainNumber=await numbered({message:"1번 상품 리뷰 요약해줘",previous:prior(),context:context()});
 assert.deepEqual(plainNumber?.reviewSummary,{focus:"ALL"});
 const firstRecommendation=await resolverFor(model({selection:"INDEX",index:1})).resolver({
  message:"추천 첫 제품 리뷰 요약해줘",previous:prior(),context:context(),
 });
 assert.deepEqual(firstRecommendation?.reviewSummary,{productId:"p-mask",variantId:"v-mask",focus:"ALL"});
});

test("review searches stay with the resolver while clear new product recommendations pass through",async()=>{
 const {resolver,calls}=resolverFor(model({mode:"SEMANTIC",selection:"ALL_DISPLAYED",focus:"CONS",
  semanticQuery:"몇 시간 지나면 건조하다는 리뷰"}));
 const resolved=await resolver({message:"이중 몇시간지나면건조하다는 리뷰 찾아줘",previous:prior(),context:context()});
 assert.deepEqual(resolved?.reviewSummary,{productIds:["p-mask","p-cream","p-pad"],
  semanticQuery:"몇 시간 지나면 건조하다는 리뷰",focus:"CONS"});
 assert.equal(calls.length,1);
 await resolver({message:"이 중 몇시간지나면 건조하다는 리뷰 찾아해줘",previous:prior(),context:context()});
 assert.equal(calls.length,2);
 const fresh=resolverFor(model());
 assert.equal(await fresh.resolver({message:"새 마스크팩 추천해줘",previous:prior(),context:context()}),undefined);
 assert.equal(fresh.calls.length,0);
});

test("a distinctive product token resolves one of several displayed names sharing 마스크팩",async()=>{
 const products=[
  {productId:"p-no",variantId:"v-no",name:"[NEW 3종/5+1매] 노프랍 하이드로겔 마스크팩 5+1매 기획 6종",displayIndex:1},
  {productId:"p-num",variantId:"v-num",name:"넘버즈인 마스크팩 10매",displayIndex:2},
  {productId:"p-medi",variantId:"v-medi",name:"메디힐 마스크팩",displayIndex:3},
 ];
 const p=prior({shoppingPlan:{query:"마스크팩",lastDisplayedProductIds:products.map(row=>row.productId),lastDisplayedProducts:products},
  explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:products.map(row=>({...row,totalPriceWon:10000,evidenceIds:[],indicators:[]})),limitations:[]}});
 const ctx=context({displayedProducts:products.map(({productId,variantId,name})=>({productId,variantId,name}))});
 const {resolver}=resolverFor(model({name:"노프랍 하이드로겔 마스크팩"}));
 const route=await resolver({message:"노프랍 하이드로겔 마스크팩 리뷰 요약해줘",previous:p,context:ctx});
 assert.deepEqual(route?.reviewSummary,{productId:"p-no",variantId:"v-no",focus:"ALL"});
});

test("an explicit review ordering request for a displayed rank stays on review analysis",async()=>{
 const message="1순위 상품 촉촉한 리뷰가 많은 순으로 알려줘";
 const {resolver,calls}=resolverFor(model({selection:"INDEX",index:1}));
 assert.equal(await resolver({message,previous:prior(),context:context()}),undefined);
 assert.equal(calls.length,0);
 assert.deepEqual(parseContextReviewRequest(message),{
  displayIndexes:[1],aspect:"moisturizing",focus:"ALL",compare:false,
 });
});

test("a model index conflicting with an explicit product name is held for clarification",async()=>{
 const {resolver}=resolverFor(model({selection:"INDEX",index:1,name:"히알 수분 크림"}));
 const route=await resolver({message:"2순위 히알 수분 크림 리뷰 요약해줘",previous:prior(),context:context()});
 assert.deepEqual(route,{kind:"REVIEW_SUMMARY",search:false,reviewSummary:{focus:"ALL"}});
});

test("a pending review name correction preserves its focus and resolves only a unique prior name",async()=>{
 const pending={query:"노프랍 마스크",focus:"CONS"} as const;
 const p=prior({pendingReview:pending});
 const {resolver}=resolverFor(model({focus:"ALL",name:"노프랍 하이드로겔 마스크팩"}));
 const route=await resolver({message:"아까 노프랍 하이드로겔 마스크팩이라고 말했어요",previous:p,
  context:context({pendingReview:pending})});
 assert.deepEqual(route?.reviewSummary,{productId:"p-mask",variantId:"v-mask",focus:"CONS",
  semanticQuery:"해당 상품의 아쉬운 사용 경험과 불편한 점"});
});

test("count mode routes canonical aspect and validated display indexes to rule-based review analysis",async()=>{
 const {resolver}=resolverFor(model({mode:"COUNT",selection:"INDEX",index:1,focus:"CONS",aspect:"보습력"}));
 const route=await resolver({message:"1순위 상품 보습력 단점 리뷰 몇 개야?",previous:prior(),context:context()});
 assert.equal(route?.kind,"REVIEW_ANALYSIS");
 assert.deepEqual(route?.reviewAnalysis,{displayIndexes:[1],aspect:"moisturizing",focus:"CONS",compare:false});
});

test("an explicitly named unknown product becomes a name-only lookup query",async()=>{
 const {resolver}=resolverFor(model({focus:"CONS",name:"독립 브랜드 수딩 크림"}));
 const route=await resolver({message:"독립 브랜드 수딩 크림 후기 단점 정리해줘",previous:prior(),context:context()});
 assert.deepEqual(route?.reviewSummary,{query:"독립 브랜드 수딩 크림",
  semanticQuery:"해당 상품의 아쉬운 사용 경험과 불편한 점",focus:"CONS"});
});

test("a single product named after a semantic multi-result is resolved through the validated review products",async()=>{
 const p=prior({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:{
  status:"READY",focus:"CONS",products:[
   {productId:"p-extra",variantId:"v-extra",name:"프레시 리페어 세럼"},
   {productId:"p-mask",variantId:"v-mask",name:"노프랍 하이드로겔 마스크팩"},
  ],evidence:[],
 }}});
 const ctx=context({displayedProducts:[...rows.map(({productId,variantId,name})=>({productId,variantId,name})),
  {productId:"p-extra",variantId:"v-extra",name:"프레시 리페어 세럼"}]});
 const {resolver}=resolverFor(model({focus:"CONS",name:"프레시 리페어 세럼"}));
 const route=await resolver({message:"프레시 리페어 세럼 단점만 정리해줘",previous:p,context:ctx});
 assert.deepEqual(route?.reviewSummary,{productId:"p-extra",variantId:"v-extra",focus:"CONS",
  semanticQuery:"해당 상품의 아쉬운 사용 경험과 불편한 점"});
});

test("CURRENT requires a single validated review product or a safe product page",async()=>{
 const multi=prior({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:{
  status:"READY",focus:"CONS",products:[
   {productId:"p-mask",variantId:"v-mask",name:"노프랍 하이드로겔 마스크팩"},
   {productId:"p-cream",variantId:"v-cream",name:"히알 수분 크림"},
  ],evidence:[],
 }}});
 const {resolver}=resolverFor(model({selection:"CURRENT",focus:"CONS"}));
 const ambiguous=await resolver({message:"이 제품 단점만 알려줘",previous:multi,context:context()});
 assert.deepEqual(ambiguous,{kind:"REVIEW_SUMMARY",search:false,reviewSummary:{focus:"CONS"}});
 const current=prior({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:{
  status:"READY",focus:"ALL",product:{id:"p-mask",name:"노프랍 하이드로겔 마스크팩"},evidence:[],
 }}});
 const direct=await resolver({message:"이거 단점만 알려줘",previous:current,context:context()});
 assert.deepEqual(direct?.reviewSummary,{productId:"p-mask",variantId:"v-mask",focus:"CONS",
  semanticQuery:"해당 상품의 아쉬운 사용 경험과 불편한 점"});
 const pageResolver=resolverFor(model({selection:"CURRENT",focus:"ALL"})).resolver;
 const page=await pageResolver({message:"이 제품 리뷰 요약해줘",previous:multi,context:context(),
  pageContext:{screen:"reviews",product_id:"page-product"}});
 assert.deepEqual(page?.reviewSummary,{useCurrent:true,pageProductId:"page-product",focus:"ALL"});
});

test("missing displayed context never reuses an older ID",async()=>{
 const stale=context({displayedProducts:[]});
 const {resolver}=resolverFor(model());
 const route=await resolver({message:"노프랍 하이드로겔 마스크팩 리뷰 요약해줘",previous:prior(),context:stale});
 assert.deepEqual(route?.reviewSummary,{query:"노프랍 하이드로겔 마스크팩",focus:"ALL"});
});

test("COUNT requires an explicit count question and malformed IDs are rejected",async()=>{
 const countResolver=resolverFor(model({mode:"COUNT",selection:"INDEX",index:1,aspect:"moisturizing"})).resolver;
 const notCount=await countResolver({message:"1순위 상품 보습력 리뷰 알려줘",previous:prior(),context:context()});
 assert.equal(notCount?.kind,"UNCERTAIN");
 const idResolver=resolverFor({...model(),productId:"p-mask"} as ModelResult).resolver;
 const rawId=await idResolver({message:"노프랍 하이드로겔 마스크팩 리뷰 요약해줘",previous:prior(),context:context()});
 assert.equal(rawId?.kind,"UNCERTAIN");
});

test("provider failure is safe and non-review messages do not call it",async()=>{
 const {resolver,calls}=resolverFor(new Error("provider unavailable"));
 const route=await resolver({message:"이 제품 리뷰 요약해줘",previous:prior(),context:context()});
 assert.deepEqual(route,{kind:"UNCERTAIN",search:false,text:"리뷰 요청을 안전하게 해석하지 못했어요. 어떤 상품의 어떤 리뷰를 확인할지 다시 말씀해 주세요."});
 assert.equal(await resolver({message:"이 제품 추천해줘",previous:prior(),context:context()}),undefined);
 assert.equal(calls.length,1);
});
