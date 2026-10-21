import test from "node:test";
import assert from "node:assert/strict";
import {ok} from "../../src/contracts.ts";
import {verifiedRagRetriever,validateRagEndpoint} from "../../src/brain/rag-adapter.ts";
import {rankProducts} from "../../src/brain/personalization.ts";

const proof=(id:string,productId:string,kind:"REVIEW"|"SPEC"="REVIEW")=>({
  id,productId,variantId:null,kind,sourceKind:kind==="REVIEW"?"REAL":undefined,
  sourceRef:"https://data.example.org/evidence/"+id
});
function resultRows(){
 const evidence=[
   ...["performance","eye_comfort","noise"].flatMap(a=>["a","b"].map(id=>proof(a+"-"+id,"p-"+id)))
 ];
 const candidates=[
   {productId:"p-a",variantId:"v-a",sourceProductId:"source-a",reviewCountAuditId:"qa-v1",
     wholeReviewCount:50,rating:4.6,ratingScale:5,unitPriceWon:1,shippingFeeWon:0,
     facets:{performance:{score:.45,evidenceIds:["performance-a"]},eye_comfort:{score:.55,evidenceIds:["eye_comfort-a"]},noise:{score:.6,evidenceIds:["noise-a"]}}},
   {productId:"p-b",variantId:"v-b",sourceProductId:"source-b",reviewCountAuditId:"qa-v1",
     wholeReviewCount:30,rating:4.7,ratingScale:5,unitPriceWon:1,shippingFeeWon:0,
     facets:{performance:{score:.96,evidenceIds:["performance-b"]},eye_comfort:{score:.92,evidenceIds:["eye_comfort-b"]},noise:{score:.6,evidenceIds:["noise-b"]}}}
 ];
 return {version:"brain-rag-v1",candidates,evidence};
}
function commerce(productId:string){
 const id=productId.split("-").pop();
 return ok({product:{id:productId,name:"Mock "+id,brand:"QA",category:"monitor",description:"",
   images:[],specs:{},active:true,version:1,availability:"AVAILABLE" as const},
   variants:[{variant_id:"v-"+id,option_values:{},effective_specs:{},unit_price_won:id==="a"?100_000:390_000,
     stock_qty:5,availability:"AVAILABLE" as const,version:1}],shipping_fee_won:3000},"ci-trace");
}
const ctx=(price_priority:"value"|"performance")=>({maxTotalWon:500000,requiredConditions:[],currentPreferences:{price_priority}});
function create(payload:ReturnType<typeof resultRows>,lookup=commerce){
 let calls=0,headers:HeadersInit|undefined;
 const fetcher:typeof fetch=async(_url,init)=>{
   calls++;
   headers=init?.headers;
   return new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}});
 };
 const retriever=verifiedRagRetriever({endpoint:"http://127.0.0.1:7888/rag",auditId:"qa-v1",token:"ci-only",timeoutMs:3000},async({product_id})=>lookup(product_id),fetcher);
 return {retriever,calls:()=>calls,headers:()=>headers};
}
test("RAG ranking actually changes by user preference while candidate set is identical",async()=>{
 const adapter=create(resultRows());
 const r=await adapter.retriever.search({query:"모니터",maxTotalWon:500000,requiredConditions:[]});
 assert.equal(adapter.calls(),1);
 assert.equal(r.candidates.length,2);
 assert.equal(r.candidates[0].unitPriceWon,100000,"Commerce quote must override spoofed RAG price");
 assert.equal(r.candidates[0].productName,"Mock a","name must also come from Commerce");
 assert.equal(r.candidates[0].shippingFeeWon,3000,"Commerce must own shipping");
 assert.equal(r.candidates[0].wholeReviewCountVerified,true);
 assert.equal(rankProducts(r.candidates,r.evidence,ctx("value"),[]).ranked[0].candidate.productId,"p-a");
 assert.equal(rankProducts(r.candidates,r.evidence,ctx("performance"),[]).ranked[0].candidate.productId,"p-b");
 assert.match(JSON.stringify(adapter.headers()),/ci-only/);
});

test("RAG accepts data-defined attribute keys while retaining product-scoped evidence checks",async()=>{
 const payload=resultRows();
 for(const row of payload.candidates)(row as unknown as {facets:unknown}).facets={battery_life:{score:.8,evidenceIds:["performance-"+row.productId.slice(-1)]}};
 const result=await create(payload).retriever.search({query:"headphones",maxTotalWon:null,requiredConditions:[]});
 assert.equal(result.candidates[0].facets.battery_life?.score,.8);
 assert.equal(result.candidates[0].facets.performance,undefined);
 (payload.candidates[0] as unknown as {facets:unknown}).facets={battery_life:{score:.8,evidenceIds:["performance-b"]}};
 await assert.rejects(()=>create(payload).retriever.search({query:"headphones",maxTotalWon:null,requiredConditions:[]}),/cross-product/);
});
test("unsupported rating provenance is discarded instead of fabricated",async()=>{
 const payload=resultRows();
 payload.candidates[0].reviewCountAuditId="unreviewed";
 const r=await create(payload).retriever.search({query:"모니터",maxTotalWon:null,requiredConditions:[]});
 assert.equal(r.candidates[0].wholeReviewCountVerified,false);
 const rank=rankProducts(r.candidates,r.evidence,ctx("value"),[]);
 assert.equal(r.candidates[0].rating,null);assert.equal(r.candidates[0].wholeReviewCount,null);assert.ok(rank.ranked.some(x=>x.candidate.productId==="p-a"&&x.limitations?.includes("whole_review_count_unverified")));
});
test("out-of-stock and mismatched variants never become eligible candidates",async()=>{
 const payload=resultRows();
 payload.candidates[0].variantId="v-not-in-catalog";
 const lookup=(id:string)=>{
   const p=commerce(id);
   if(p.ok&&id==="p-b")p.data.variants[0].stock_qty=0;
   return p;
 };
 const r=await create(payload,lookup).retriever.search({query:"모니터",maxTotalWon:null,requiredConditions:[]});
 assert.deepEqual(r.candidates,[]);
});
test("injected or synthetic review evidence is rejected rather than ranked",async()=>{
 const payload=resultRows();
 payload.evidence[0].sourceKind="SYNTHETIC";
 await assert.rejects(()=>create(payload).retriever.search({query:"모니터",maxTotalWon:null,requiredConditions:[]}),/RAG evidence/);
});
test("RAG response contract version and duplicate review IDs fail closed",async()=>{
 const payload=resultRows();
 payload.version="unknown";
 await assert.rejects(()=>create(payload).retriever.search({query:"monitor",maxTotalWon:null,requiredConditions:[]}),/version/);
 const duplicate=resultRows();duplicate.evidence.push({...duplicate.evidence[0]});
 await assert.rejects(()=>create(duplicate).retriever.search({query:"monitor",maxTotalWon:null,requiredConditions:[]}),/duplicate/);
});
test("remote retrieval URL must be HTTPS or loopback; no credentials embedded",()=>{
 assert.throws(()=>validateRagEndpoint("http://external.example.org/rag"),/HTTPS/);
 assert.throws(()=>validateRagEndpoint("https://user:password@external.example.org/rag"),/HTTPS/);
 assert.equal(validateRagEndpoint("https://retriever.example.org/v1/search").protocol,"https:");
});
test("unavailable upstream never silently falls back to unverified Commerce rankings",async()=>{
 const failing:typeof fetch=async()=>{throw new Error("RAG unavailable");};
 const adapter=verifiedRagRetriever({endpoint:"https://retriever.example.org/v1",auditId:"qa-v1"},async()=>commerce("p-a"),failing);
 await assert.rejects(()=>adapter.search({query:"monitor",maxTotalWon:null,requiredConditions:[]}),/RAG unavailable/);
});

test("M13 RAG must reject a facet citation borrowed from another product",async()=>{
 const payload=resultRows();
 payload.evidence[0].productId="p-b";
 await assert.rejects(()=>create(payload).retriever.search({
  query:"monitor",maxTotalWon:null,requiredConditions:[]
 }),/cross-product evidence mismatch/);
});
test("M13 RAG rejects evidence for a different Commerce variant",async()=>{
 const payload=resultRows();
 (payload.evidence[0] as {variantId:string|null}).variantId="v-obsolete";
 await assert.rejects(()=>create(payload).retriever.search({
  query:"monitor",maxTotalWon:null,requiredConditions:[]
 }),/cross-product evidence mismatch/);
});
test("M13 RAG rejects a hard-condition proof belonging to another product",async()=>{
 const payload=resultRows();
 Object.assign(payload.candidates[0],{conditions:{FHD:["performance-b"]}});
 await assert.rejects(()=>create(payload).retriever.search({
  query:"monitor",maxTotalWon:500000,requiredConditions:["FHD"]
 }),/cross-product evidence mismatch/);
});
test("M13 duplicate product/variant responses do not inflate candidate rankings",async()=>{
 const payload=resultRows();
 payload.candidates.push({...payload.candidates[0]});
 await assert.rejects(()=>create(payload).retriever.search({
  query:"monitor",maxTotalWon:null,requiredConditions:[]
 }),/duplicate RAG candidate/);
});
