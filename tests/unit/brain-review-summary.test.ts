import test from "node:test";
import assert from "node:assert/strict";
import type {ResearchResult} from "../../src/brain/read-flow.ts";
import {createReviewSummaryLookup} from "../../src/brain/review-summary.ts";
import {getReviews as getCatalogReviews} from "../../src/catalog.ts";

const ok=(data:unknown)=>({ok:true as const,data,observed_at:"2026-10-20T00:00:00.000Z",trace_id:"trace"});
const notFound=()=>({ok:false as const,error:{code:"NOT_FOUND",message:"missing",recovery_action:"STOP" as const},trace_id:"trace"});
const summary=(id:string,name:string,availability:"AVAILABLE"|"SOLD_OUT"|"UNAVAILABLE"="AVAILABLE")=>({
 product_id:id,name,brand:"브랜드",category:"digital",image:`/${id}.jpg`,matched_variants:[],
 rating_summary:{avg:4,count:9},availability,
});
const detail=(id:string,name:string,active=true)=>ok({product:{id,name,brand:"브랜드",category:"digital",description:"",
 images:[`/${id}.jpg`],specs:{},active,version:1,availability:active?"SOLD_OUT":"UNAVAILABLE"},variants:[],shipping_fee_won:3000});
const review=(id:string,productId:string,variantId:string|null,rating:number,body:string,sourceKind:"REAL"|"SYNTHETIC"="REAL")=>({
 id,product_id:productId,variant_id:variantId,rating,body,source_kind:sourceKind,source_ref:`ref:${id}`,written_at:"2026-10-19T00:00:00.000Z",
});
const previous=(patch:Record<string,unknown>={}):ResearchResult=>({
 conversationId:"c",messageId:"m",ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
 shoppingPlan:{query:"수분크림",lastDisplayedProductIds:["p-1","p-2"]},
 explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:[{productId:"p-1",variantId:"v-1",name:"제품 1",totalPriceWon:20000,evidenceIds:[],indicators:[]},
  {productId:"p-2",variantId:"v-2",name:"제품 2",totalPriceWon:30000,evidenceIds:[],indicators:[]}],limitations:[]},
 ...patch,
} as unknown as ResearchResult);
function catalogStub(options:{matches?:unknown[];products?:Record<string,unknown>;reviews?:(input:{product_id:string;variant_id?:string;sort?:string;limit?:number})=>unknown[]}={}){
 const calls:{search:unknown[];products:string[];reviews:{product_id:string;variant_id?:string;sort?:string;limit?:number}[]}={search:[],products:[],reviews:[]};
 const catalog={
  searchProducts:async(input:unknown)=>{calls.search.push(input);return ok({items:options.matches??[],shipping_fee_won:3000,next_cursor:null,has_more:false});},
  getProduct:async(input:{product_id:string})=>{calls.products.push(input.product_id);return options.products?.[input.product_id]??notFound();},
  getReviews:async(input:{product_id:string;variant_id?:string;sort?:string;limit?:number})=>{
   calls.reviews.push(input);return ok({reviews:options.reviews?.(input)??[],total_matching:0,returned_count:0,next_cursor:null,has_more:false,sort:input.sort??"LATEST"});
  },
 };
 return {catalog,calls};
}

test("exact name directly reads balanced Commerce reviews for a sold-out product",async()=>{
 const rows=[review("r-1","p-1","v-1",5,"좋아요"),review("r-2","p-1",null,1,"아쉬워요"),review("r-3","p-1",null,5,"합성 의견","SYNTHETIC")];
 const {catalog,calls}=catalogStub({matches:[summary("p-1","수분크림 A","SOLD_OUT")],products:{"p-1":detail("p-1","수분크림 A",true)},
  reviews:input=>input.sort==="LATEST"?rows:input.sort==="RATING_ASC"?[rows[1]!,rows[0]!]:[rows[0]!,rows[1]!]});
 const lookup=createReviewSummaryLookup(catalog as never,"dataset-7");
 const result=await lookup({query:"수분크림 A",focus:"ALL"});
 assert.equal(result.status,"READY");
 assert.deepEqual(result.product,{id:"p-1",name:"수분크림 A",image:"/p-1.jpg"});
 assert.deepEqual(result.evidence.map(row=>row.id),["r-1","r-2","r-3"]);
 assert.equal(result.evidence[1]?.variantId,null,"product-level source variant must remain null");
 assert.equal(result.evidence[0]?.sourceId,"r-1");
 assert.equal(result.evidence[0]?.sourceKind,"REAL");
 assert.equal(result.evidence[0]?.datasetVersion,"dataset-7");
 assert.equal(result.evidence[2]?.sourceKind,"SYNTHETIC");
 assert.equal(result.evidence[0]?.sourceRef,"ref:r-1");
 assert.deepEqual(calls.reviews.map(call=>call.sort).sort(),["LATEST","RATING_ASC","RATING_DESC"]);
 assert.ok(calls.reviews.reduce((sum,call)=>sum+(call.limit??0),0)<=20);
 assert.equal(calls.products[0],"p-1");
});

test("review name selection resolves a unique verified lastDisplayedProducts entry before catalog search",async()=>{
 const prior=previous({shoppingPlan:{
  query:"수분크림",lastDisplayedProductIds:["p-1","p-2"],
  lastDisplayedProducts:[
   {productId:"p-1",variantId:"v-1",name:"노프랍 수분 진정 대용량 하이드로겔 패드 [NEW3종/5+1매] 마스크팩 기획 6종",displayIndex:1},
   {productId:"p-2",variantId:"v-2",name:"노프랍 수분 크림",displayIndex:2},
  ],
 }});
 const {catalog,calls}=catalogStub({products:{"p-1":detail("p-1","노프랍 수분 진정 대용량 하이드로겔 패드 [NEW3종/5+1매] 마스크팩 기획 6종")}});
 const lookup=createReviewSummaryLookup(catalog as never,"dataset-7");
 const result=await lookup({query:"노프랍 하이드로겔 마스크팩",focus:"ALL"},prior);
 assert.equal(result.status,"NO_REVIEWS");
 assert.equal(calls.search.length,0);
 assert.equal(calls.products.at(-1),"p-1");
});

test("ambiguous exact names ask for a choice, and only a previous choice ID can select it",async()=>{
 const choices=[summary("p-1","수분크림"),summary("p-2","수분크림")];
 const {catalog,calls}=catalogStub({matches:choices,products:{"p-2":detail("p-2","수분크림")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const ambiguous=await lookup({query:"수분크림",focus:"ALL"});
 assert.equal(ambiguous.status,"AMBIGUOUS");
 assert.deepEqual(ambiguous.choices,[{productId:"p-1",name:"수분크림"},{productId:"p-2",name:"수분크림"}]);
 assert.equal(calls.products.length,0);
 const prior=previous({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:ambiguous}});
 const selected=await lookup({query:"리뷰 요약 상품 선택: p-2",focus:"CONS"},prior);
 assert.equal(selected.status,"NO_REVIEWS");
 assert.equal(selected.product?.id,"p-2");
 assert.ok(calls.products.includes("p-2"));
 const invalid=await lookup({query:"리뷰 요약 상품 선택: p-9",focus:"ALL"},prior);
 assert.equal(invalid.status,"NOT_FOUND");
 assert.ok(!calls.products.includes("p-9"));
});

test("fuzzy search results cannot select a different product, and raw product IDs require prior scope",async()=>{
 const {catalog,calls}=catalogStub({matches:[summary("p-other","다른 제품 이름")],products:{"p-1":detail("p-1","제품 1")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const fuzzy=await lookup({query:"정확히 다른 수분크림",focus:"ALL"});
 assert.equal(fuzzy.status,"NOT_FOUND");
 const unknown=await lookup({productId:"p-1",focus:"ALL"});
 assert.equal(unknown.status,"NOT_FOUND");
 assert.deepEqual(calls.products,[]);
 const allowed=await lookup({productId:"p-1",focus:"ALL"},previous());
 assert.ok(["READY","NO_REVIEWS"].includes(allowed.status));
 assert.equal(calls.products.at(-1),"p-1");
});

test("displayIndex is one-based and current selection prefers the prior review-summary product",async()=>{
 const {catalog,calls}=catalogStub({products:{"p-1":detail("p-1","제품 1"),"p-2":detail("p-2","제품 2"),"p-3":detail("p-3","제품 3")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const indexPrior=previous({
  shoppingPlan:{query:"수분크림",lastDisplayedProductIds:["p-1","p-2"]},
  explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:[{productId:"p-1",variantId:"v-1",name:"제품 1",totalPriceWon:1,evidenceIds:[],indicators:[]},
   {productId:"p-3",variantId:"v-3",name:"제품 3",totalPriceWon:1,evidenceIds:[],indicators:[]}],limitations:[]},
 });
 await lookup({displayIndex:2,focus:"ALL"},indexPrior);
 assert.equal(calls.products.at(-1),"p-3","explanation display order takes precedence over fallback IDs");
 const current=previous({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[{productId:"p-2",variantId:"v-2",name:"제품 2",totalPriceWon:0,evidenceIds:[],indicators:[]}],
  limitations:[],reviewSummary:{status:"READY",focus:"ALL",product:{id:"p-1",name:"제품 1"},evidence:[]}}});
 await lookup({useCurrent:true,focus:"ALL"},current);
 assert.equal(calls.products.at(-1),"p-1");
});

test("explicit variant scopes reads but never overwrites a product-level review variant",async()=>{
 const rows=[review("r-null","p-1",null,5,"상품 전체"),review("r-v","p-1","v-1",1,"옵션 의견")];
 const {catalog,calls}=catalogStub({products:{"p-1":detail("p-1","제품 1")},reviews:()=>rows});
 const lookup=createReviewSummaryLookup(catalog as never,"dataset-explicit");
 const result=await lookup({productId:"p-1",variantId:"v-1",focus:"ALL"},previous());
 assert.equal(result.status,"READY");
 assert.deepEqual(result.product,{id:"p-1",name:"제품 1",variantId:"v-1",image:"/p-1.jpg"});
 assert.equal(calls.reviews[0]?.variant_id,"v-1");
 assert.equal(result.evidence.find(row=>row.id==="r-null")?.variantId,null);
 assert.equal(result.evidence.find(row=>row.id==="r-v")?.variantId,"v-1");
});

test("conflicting copies of one source ID across variants are excluded",async()=>{
 const normal=review("r-1","p-1",null,4,"same source");
 const conflict=review("r-1","p-1","v-other",1,"conflicting source");
 const {catalog}=catalogStub({products:{"p-1":detail("p-1","제품 1")},reviews:input=>input.sort==="RATING_ASC"?[normal,conflict]:[normal]});
 const lookup=createReviewSummaryLookup(catalog as never,"dataset-exact");
 const result=await lookup({productId:"p-1",focus:"CONS"},previous());
 assert.equal(result.status,"NO_REVIEWS");
 assert.deepEqual(result.evidence,[]);
});
test("unmatched query and empty review set return honest statuses",async()=>{
 const empty={catalog_context:undefined,items:[],shipping_fee_won:3000,next_cursor:null,has_more:false};
 const {catalog}=catalogStub({matches:[summary("p-1","수분크림")],products:{"p-1":detail("p-1","수분크림")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const missing=await lookup({query:"없는 상품의 충분히 긴 이름",focus:"ALL"});
 assert.equal(missing.status,"NOT_FOUND");
 const noReviews=await lookup({query:"수분크림",focus:"ALL"},previous());
 assert.equal(noReviews.status,"NO_REVIEWS");
 assert.deepEqual(noReviews.evidence,[]);
});


test("a sanitized current page product overrides prior selection without inferring a variant",async()=>{
 const {catalog,calls}=catalogStub({products:{"p-page":detail("p-page","페이지 상품"),"p-1":detail("p-1","이전 상품")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const prior=previous({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],
  reviewSummary:{status:"READY",focus:"ALL",product:{id:"p-1",name:"이전 상품",variantId:"v-prior"},evidence:[]}}});
 const result=await lookup({useCurrent:true,pageProductId:"p-page",productId:"p-1",focus:"ALL"} as never,prior);
 assert.equal(calls.products.at(-1),"p-page");
 assert.deepEqual(result.product,{id:"p-page",name:"페이지 상품",image:"/p-page.jpg"});
 const ignored=await lookup({useCurrent:false,pageProductId:"p-page",focus:"ALL"} as never,prior);
 assert.equal(ignored.status,"NOT_FOUND");
});
test("useCurrent asks among multiple previous products instead of choosing the first",async()=>{
 const {catalog,calls}=catalogStub({products:{"p-1":detail("p-1","제품 1"),"p-2":detail("p-2","제품 2")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const ambiguous=await lookup({useCurrent:true,focus:"ALL"},previous());
 assert.equal(ambiguous.status,"AMBIGUOUS");
 assert.deepEqual(ambiguous.choices,[{productId:"p-1",name:"제품 1"},{productId:"p-2",name:"제품 2"}]);
 assert.deepEqual(calls.products,["p-1","p-2"]);
 assert.equal(calls.reviews.length,0);
 const single=previous({shoppingPlan:{query:"수분크림",lastDisplayedProductIds:["p-1"]},
  explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:[{productId:"p-1",variantId:"v-1",name:"제품 1",totalPriceWon:1,evidenceIds:[],indicators:[]}],limitations:[]}});
 await lookup({useCurrent:true,focus:"ALL"},single);
 assert.equal(calls.products.at(-1),"p-1");
});

test("an exact short product name is still eligible",async()=>{
 const {catalog,calls}=catalogStub({matches:[summary("p-tv","TV")],products:{"p-tv":detail("p-tv","TV")}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const result=await lookup({query:"TV",focus:"ALL"});
 assert.equal(result.status,"NO_REVIEWS");
 assert.equal(calls.products[0],"p-tv");
});

test("allowlisted inactive products remain review-readable by direct ID",async()=>{
 const {catalog,calls}=catalogStub({products:{"p-1":detail("p-1","비활성 상품",false)}});
 const lookup=createReviewSummaryLookup(catalog as never);
 const prior=previous({explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:[{productId:"p-1",variantId:"v-1",name:"비활성 상품",
  totalPriceWon:0,evidenceIds:[],indicators:[]}],limitations:[]}});
 const result=await lookup({productId:"p-1",focus:"ALL"},prior);
 assert.equal(result.status,"NO_REVIEWS");
 assert.equal(result.product?.id,"p-1");
 assert.equal(calls.search.length,0);
});

test("review sample remains bounded at twenty records across balanced sorts",async()=>{
 const {catalog,calls}=catalogStub({products:{"p-1":detail("p-1","제품 1")},
  reviews:input=>Array.from({length:30},(_,i)=>review(`${input.sort}-${i}`,"p-1",null,1+i%5,`후기 ${input.sort} ${i}`))});
 const lookup=createReviewSummaryLookup(catalog as never);
 const result=await lookup({productId:"p-1",focus:"CONS"},previous());
 assert.equal(result.evidence.length,20);
 assert.deepEqual(calls.reviews.map(call=>call.sort).sort(),["LATEST","RATING_ASC","RATING_DESC"]);
 assert.equal(calls.reviews.reduce((sum,call)=>sum+(call.limit??0),0),20);
});

test("the real Commerce getReviews service rejects a foreign variant before review reads",async()=>{
 const queries:string[]=[];
 const db={unsafe:async(query:string)=>{
  queries.push(query);
  if(query.includes("FROM public.products"))return [{id:"p-1"}];
  if(query.includes("FROM public.product_variants"))return [];
  return [];
 }};
 const base=catalogStub({products:{"p-1":detail("p-1","제품 1")}});
 const catalog={...base.catalog,getReviews:(input:{product_id:string;variant_id?:string;sort?:string;limit?:number})=>getCatalogReviews(input,db as never)};
 const lookup=createReviewSummaryLookup(catalog as never);
 const result=await lookup({productId:"p-1",variantId:"foreign-variant",focus:"ALL"},previous());
 assert.equal(result.status,"NOT_FOUND");
 assert.equal(queries.filter(query=>query.includes("FROM public.product_variants")).length,3,"variant FK validation runs once per review sort");
 assert.equal(queries.some(query=>query.includes("FROM public.reviews")),false);
});
test("getProduct name drift cannot silently change an exact query or prior choice",async()=>{
 const queryCatalog=catalogStub({matches:[summary("p-1","정확한 상품명")],products:{"p-1":detail("p-1","변경된 상품명")}});
 const queryLookup=createReviewSummaryLookup(queryCatalog.catalog as never);
 const queried=await queryLookup({query:"정확한 상품명",focus:"ALL"});
 assert.equal(queried.status,"NOT_FOUND");
 assert.equal(queryCatalog.calls.reviews.length,0);
 const choiceCatalog=catalogStub({products:{"p-1":detail("p-1","변경된 상품명")}});
 const choiceLookup=createReviewSummaryLookup(choiceCatalog.catalog as never);
 const prior=previous({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],
  reviewSummary:{status:"AMBIGUOUS",focus:"ALL",choices:[{productId:"p-1",name:"기존 상품명"}],evidence:[]}}});
 const selected=await choiceLookup({query:"리뷰 요약 상품 선택: p-1",focus:"ALL"},prior);
 assert.equal(selected.status,"NOT_FOUND");
 assert.equal(choiceCatalog.calls.reviews.length,0);
});
