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
 assert.ok(ranked.referenceOnly.some(x=>x.reasons.includes("missing_critical_aspect:performance")));
});
test("unverified whole review count cannot pass G2",()=>{
 const ps=products();ps[0].wholeReviewCountVerified=false;ps[0].wholeReviewCount=null as never;
 assert.equal(rankProducts(ps,evidence,ctx(),[]).ranked.length,1);
});
test("rating and review-count gates match strict thresholds",()=>{
 const p=products()[0];p.rating=3.5;assert.ok(eligibility(p).includes("rating_below_G2"));
 p.rating=3.6;p.wholeReviewCount=9;assert.ok(eligibility(p).includes("whole_review_count_below_G2"));
 p.wholeReviewCount=10;assert.deepEqual(eligibility(p),[]);
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
