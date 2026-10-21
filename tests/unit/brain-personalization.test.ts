import test from "node:test";
import assert from "node:assert/strict";
import {rankProducts,effectivePreferences,eligibility} from "../../src/brain/personalization.ts";
import {rememberExplicitPreference,InMemoryMemoryRepository} from "../../src/brain/memory.ts";
const ctx=(currentPreferences:Partial<Record<"price_priority"|"eye_comfort"|"noise_sensitivity","value"|"balanced"|"performance"|"important"|"normal">>={},maxTotalWon=500000)=>({currentPreferences,requiredConditions:["FHD"],maxTotalWon});
const proof=(id:string,productId:string,kind:"SPEC"|"REVIEW"="REVIEW")=>({id,productId,variantId:null,kind,sourceKind:"REAL" as const});
const evidence=[proof("a-spec","p-a","SPEC"),proof("b-spec","p-b","SPEC"),...["performance","eye_comfort","noise"].flatMap(a=>["a","b"].map(i=>proof(a+"-"+i,"p-"+i)))];
const candidate=(id:string,price:number,performance:number,eye:number)=>({
 productId:"p-"+id,variantId:"v-"+id,unitPriceWon:price,shippingFeeWon:5000,rating:4.5,ratingScale:5,wholeReviewCount:40,wholeReviewCountVerified:true,
 conditions:{FHD:[id+"-spec"]},
 facets:{performance:{score:performance,evidenceIds:["performance-"+id]},eye_comfort:{score:eye,evidenceIds:["eye_comfort-"+id]},noise:{score:.8,evidenceIds:["noise-"+id]}}
});
const products=()=>[candidate("a",180000,.52,.35),candidate("b",440000,.94,.95)];
test("ranking changes with explicit current preference while candidates stay identical",()=>{
 assert.equal(rankProducts(products(),evidence,ctx({price_priority:"value"}),[]).ranked[0].candidate.productId,"p-a");
 assert.equal(rankProducts(products(),evidence,ctx({price_priority:"performance"}),[]).ranked[0].candidate.productId,"p-b");
});
test("current preference overrides saved value",()=>{
 const saved=[{userId:"u",key:"price_priority" as const,value:"value" as const,sourceConversationId:"c",sourceMessageId:"m",updatedAt:"2026-10-16T00:00:00Z"}];
 assert.equal(effectivePreferences(saved,{price_priority:"performance"}).price_priority,"performance");
 assert.equal(saved[0].value,"value");
});
test("missing critical facet cannot be rewarded by shrinking denominator",()=>{
 const ps=products();delete (ps[0].facets as Partial<typeof ps[0]["facets"]>).performance;ps[0].unitPriceWon=1000;
 const ranked=rankProducts(ps,evidence,ctx({price_priority:"performance"}),[]);
 assert.equal(ranked.ranked[0].candidate.productId,"p-b");
 assert.ok(ranked.ranked.find(x=>x.candidate.productId==="p-a")?.missingAspects.includes("performance"));
});
test("unverified whole count remains unknown without excluding price-verified candidates",()=>{
 const ps=products();ps[0].wholeReviewCountVerified=false;ps[0].wholeReviewCount=null as never;
 const r=rankProducts(ps,evidence,ctx(),[]);assert.equal(r.ranked.length,2);assert.ok(r.ranked.find(x=>x.candidate.productId==="p-a")?.limitations?.includes("whole_review_count_unverified"));
});
test("low ratings and small review counts are signals, invalid values remain unknown",()=>{
 const p=products()[0];p.rating=3.5;assert.deepEqual(eligibility(p),[]);
 p.rating=3.6;p.wholeReviewCount=9;assert.deepEqual(eligibility(p),[]);
 p.rating=NaN;assert.ok(eligibility(p).includes("rating_unverified"));
});
test("cross-product evidence blocks unsupported facet",()=>{
 const ps=products();ps[0].facets.performance.evidenceIds=["performance-b"];
 assert.ok(rankProducts(ps,evidence,ctx(),[]).rejected[0].reasons.includes("invalid_or_cross_product_facet:performance"));
});
test("memory cannot be written on caller-claimed confirmation",async()=>{
 const store=new InMemoryMemoryRepository();
 await assert.rejects(()=>rememberExplicitPreference(store,{verify:async()=>false},{actorUserId:"u",key:"price_priority",value:"value",conversationId:"c",userMessageId:"m",confirmationId:"fake"}));
 assert.deepEqual(await store.list("u"),[]);
});
test("memory test double keeps different actors separated and supports deletion",async()=>{
 const store=new InMemoryMemoryRepository();
 await rememberExplicitPreference(store,{verify:async x=>x.actorUserId==="u-a"},{actorUserId:"u-a",key:"price_priority",value:"value",conversationId:"c",userMessageId:"m",confirmationId:"server-proof"});
 assert.equal((await store.list("u-a"))[0].value,"value");
 assert.deepEqual(await store.list("u-b"),[]);
 assert.equal(await store.delete("u-a","price_priority"),true);
});
test("budget constraints are enforced before personalized ranking",()=>{
 const r=rankProducts(products(),evidence,ctx({price_priority:"performance"},200000),[]);
 assert.equal(r.ranked[0].candidate.productId,"p-a");
 assert.ok(r.rejected.some(x=>x.reasons.includes("over_total_budget")));
});

test("category ranking uses requested evidence-backed attributes without monitor defaults",()=>{
 const p={...candidate("a",180000,.5,.5),facets:{battery_life:{score:.9,evidenceIds:["battery-a"]}}};
 const scope={maxTotalWon:500000,requiredConditions:[],currentPreferences:{},category:"audio",attributePreferences:["battery_life"]};
 const result=rankProducts([p] as never,[proof("battery-a","p-a")],scope,[]);
 assert.equal(result.ranked.length,1);assert.deepEqual(result.ranked[0].missingAspects,[]);
 const missing=rankProducts([{...p,facets:{}}] as never,[],scope,[]);
 assert.equal(missing.ranked.length,1);assert.deepEqual(missing.ranked[0].missingAspects,["battery_life"]);assert.ok(missing.ranked[0].evidenceCoverage<1);
 const cross=rankProducts([p] as never,[proof("battery-a","p-b")],scope,[]);
 assert.equal(cross.ranked.length,0);assert.equal(cross.rejected.length,1);
});

test("missing soft attribute is disclosed without becoming a hard exclusion or shrinking the score denominator",()=>{
 const p={...candidate("a",180000,.5,.5),facets:{battery_life:{score:.9,evidenceIds:["battery-a"]},comfort:{score:.8,evidenceIds:["comfort-a"]}}};
 const result=rankProducts([p] as never,[proof("battery-a","p-a"),proof("comfort-a","p-a")],{
  maxTotalWon:500000,requiredConditions:[],currentPreferences:{},category:"audio",
  attributePreferences:["battery_life","comfort","portability"]},[]);
 assert.equal(result.ranked.length,1);assert.deepEqual(result.ranked[0].missingAspects,["portability"]);
 assert.ok(result.ranked[0].evidenceCoverage<1);
 assert.ok(result.ranked[0].score<result.ranked[0].evidenceCoverage);
});

test("approved QA synthetic candidates rank and respond to price priority only with exact verified evidence",()=>{
 const version="qa-v4-demo";
 const simulated=[
  {...candidate("a",180000,.5,.5),conditions:{FHD:["spec-a"]},
   facets:{retrieved_review_rating:{score:.6,evidenceIds:["rating-a"]}},sourceKind:"SYNTHETIC" as const,
   datasetVersion:version,commerceVerified:true,isSimulated:true,qaRankingEligible:true},
  {...candidate("b",440000,.9,.9),conditions:{FHD:["spec-b"]},
   facets:{retrieved_review_rating:{score:1,evidenceIds:["rating-b"]}},sourceKind:"SYNTHETIC" as const,
   datasetVersion:version,commerceVerified:true,isSimulated:true,qaRankingEligible:true},
 ];
 const demoEvidence=[
  {id:"spec-a",productId:"p-a",variantId:"v-a",kind:"SPEC",sourceKind:"SYNTHETIC",verified:true,datasetVersion:version},
  {id:"rating-a",sourceId:"review-a",productId:"p-a",variantId:"v-a",kind:"REVIEW",sourceKind:"SYNTHETIC",verified:true,datasetVersion:version,rating:3},
  {id:"spec-b",productId:"p-b",variantId:"v-b",kind:"SPEC",sourceKind:"SYNTHETIC",verified:true,datasetVersion:version},
  {id:"rating-b",sourceId:"review-b",productId:"p-b",variantId:"v-b",kind:"REVIEW",sourceKind:"SYNTHETIC",verified:true,datasetVersion:version,rating:5},
 ] as Array<Record<string,unknown>>;
 const context=(price_priority:"value"|"performance")=>({
  maxTotalWon:500000,requiredConditions:["FHD"],currentPreferences:{price_priority},
  category:"audio",attributePreferences:["battery_life"],
 });
 const value=rankProducts(simulated as never,demoEvidence as never,context("value"),[]);
 const performance=rankProducts(simulated as never,demoEvidence as never,context("performance"),[]);
 assert.deepEqual(value.ranked.map(row=>row.candidate.productId),["p-a","p-b"]);
 assert.deepEqual(performance.ranked.map(row=>row.candidate.productId),["p-b","p-a"]);
 assert.ok(performance.ranked[0].missingAspects.includes("battery_life"));

 const publicScope=rankProducts(simulated.map(row=>({...row,isSimulated:false})) as never,
  demoEvidence as never,context("value"),[]);
 assert.equal(publicScope.ranked.length,0);
 assert.equal(publicScope.referenceOnly.length,2);
 const sourceOnly=rankProducts(simulated.map(row=>({...row,qaRankingEligible:false})) as never,
  demoEvidence as never,context("value"),[]);
 assert.equal(sourceOnly.ranked.length,0);
 assert.equal(sourceOnly.referenceOnly.length,2,"simulated provenance alone never authorizes QA ranking");
 const unverified=rankProducts([simulated[0]] as never,[
  {...demoEvidence[0],verified:false},demoEvidence[1],
 ] as never,context("value"),[]);
 assert.equal(unverified.ranked.length,0);
 assert.ok(unverified.rejected.some(row=>row.reasons.includes("unverified_required_condition:FHD")));
});
