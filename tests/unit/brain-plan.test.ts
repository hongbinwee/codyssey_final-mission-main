import test from "node:test";
import assert from "node:assert/strict";
import {parseShoppingIntent,createIntentPort} from "../../src/brain/intent.ts";
import {resolveShoppingPlan} from "../../src/brain/shopping-plan.ts";
import {buildGroundedExplanation} from "../../src/brain/grounded-response.ts";
import {rankProducts} from "../../src/brain/personalization.ts";

const oldPlan={query:"monitor",maxTotalWon:500000,requiredConditions:["FHD"],
 currentPreferences:{price_priority:"value" as const},revision:1};
const intent=(x={})=>({
 query:"monitor",context:{maxTotalWon:null,requiredConditions:[],
 currentPreferences:{}},...x
});
test("follow-up retains old budget and hard requirements; merges explicitly stated preference",()=>{
 const next=resolveShoppingPlan(oldPlan,intent({queryMode:"KEEP",budgetMode:"KEEP",
  requirementsMode:"KEEP",context:{maxTotalWon:null,requiredConditions:[],
    currentPreferences:{eye_comfort:"important" as const}}}));
 assert.equal(next.maxTotalWon,500000);
 assert.deepEqual(next.requiredConditions,["FHD"]);
 assert.equal(next.currentPreferences.price_priority,"value");
 assert.equal(next.currentPreferences.eye_comfort,"important");
 assert.equal(oldPlan.revision,1);
 assert.equal(next.revision,2);
});
test("budget CLEAR and new-category plan require explicit modes",()=>{
 assert.throws(()=>resolveShoppingPlan(oldPlan,intent({query:"headphones",queryMode:"SET"})),/decide budget/);
 const next=resolveShoppingPlan(oldPlan,intent({query:"headphones",queryMode:"SET",
   budgetMode:"CLEAR",requirementsMode:"CLEAR"}));
 assert.equal(next.query,"headphones");
 assert.equal(next.maxTotalWon,null);
 assert.deepEqual(next.requiredConditions,[]);
 assert.deepEqual(next.currentPreferences,{});
});
test("subsequent budget change does not mutate previous state",()=>{
 const newer=resolveShoppingPlan(oldPlan,intent({budgetMode:"SET",
  context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}}}));
 assert.equal(newer.maxTotalWon,300000);
 assert.equal(oldPlan.maxTotalWon,500000);
 const cleared=resolveShoppingPlan(newer,intent({budgetMode:"CLEAR"}));
 assert.equal(cleared.maxTotalWon,null);
});
test("invalid operations and negative hard budgets are rejected by parser",()=>{
 assert.throws(()=>parseShoppingIntent(JSON.stringify({
   query:"monitor",maxTotalWon:-5,requiredConditions:[],currentPreferences:{},budgetMode:"SET"
 })),/budget/);
 assert.throws(()=>parseShoppingIntent(JSON.stringify({
   query:"monitor",maxTotalWon:null,requiredConditions:[],currentPreferences:{},queryMode:"ADMIN"
 })),/plan operation/);
});
test("intent model receives previous plan as lower-trust context, never a system override",async()=>{
 let observed="";
 const model={complete:async(system:string,user:string)=>{
   assert.match(system,/UNTRUSTED CONTEXT/);
   observed=user;
   return JSON.stringify({query:"monitor",maxTotalWon:null,requiredConditions:[],
     currentPreferences:{eye_comfort:"important"},queryMode:"KEEP",budgetMode:"KEEP"});
 }};
 const port=createIntentPort(model);
 const parsed=await port.extract("눈 피로도 중요해",[],oldPlan);
 assert.match(observed,/untrusted_previous_shopping_plan/);
 assert.match(observed,/500000/);
 assert.equal(resolveShoppingPlan(oldPlan,parsed).maxTotalWon,500000);
});
const candidate=(id:string,unit:number)=>({
 productName:"Mock "+id,productId:"p-"+id,variantId:"v-"+id,
 unitPriceWon:unit,shippingFeeWon:3000,rating:4.5,ratingScale:5,
 wholeReviewCount:20,wholeReviewCountVerified:true,
 conditions:{FHD:["fhd-"+id]},
 facets:{
  performance:{score:id==="a"?.4:.95,evidenceIds:["perf-"+id]},
  eye_comfort:{score:id==="a"?.4:.9,evidenceIds:["eye-"+id]},
  noise:{score:.6,evidenceIds:["noise-"+id]}
 }
});
test("grounded response references only matching evidence IDs and never invents review conclusions",()=>{
 const products=[candidate("a",100000),candidate("b",400000)];
 const evidence=["perf","eye","noise","fhd"].flatMap(aspect=>["a","b"].map(id=>({
    id:aspect+"-"+id,productId:"p-"+id,variantId:null,
    kind:aspect==="fhd"?"SPEC" as const:"REVIEW" as const,sourceKind:"REAL" as const
 })));
 const ranked=rankProducts(products,evidence,oldPlan,[]);
 assert.equal(ranked.ranked.length,2);
 const explanation=buildGroundedExplanation(ranked,evidence,oldPlan);
 assert.equal(explanation.kind,"VERIFIED_CANDIDATES");
 assert.match(explanation.text,/500,000원/);
 assert.ok(explanation.items.every(it=>it.evidenceIds.every(eid=>eid.endsWith(it.productId.slice(-1)))));
 assert.doesNotMatch(explanation.text,/눈 피로가 확실히 줄|객관적으로 최고/);
});
test("nonqualifying candidates receive no fabricated recommendation",()=>{
 const p=candidate("a",90000);p.wholeReviewCountVerified=false;
 const evidence=["perf","eye","noise"].map(name=>({
   id:name+"-a",productId:"p-a",variantId:null,kind:"REVIEW" as const,sourceKind:"REAL" as const
 }));
 const result=rankProducts([p],evidence,{...oldPlan,requiredConditions:[]},[]);
 const explanation=buildGroundedExplanation(result,evidence,oldPlan);
 assert.equal(explanation.kind,"REFERENCE_ONLY");
 assert.equal(explanation.items.length,0);
 assert.match(explanation.text,/참고 정보/);
});

test("synthetic review evidence cannot satisfy recommendation ranking",()=>{
 const p=candidate("a",90000);
 const evidence=["perf","eye","noise","fhd"].map(name=>({
   id:name+"-a",productId:"p-a",variantId:null,
   kind:name==="fhd"?"SPEC" as const:"REVIEW" as const,sourceKind:"SYNTHETIC" as const
 }));
 const ranking=rankProducts([p],evidence,oldPlan,[]);
 assert.equal(ranking.ranked.length,0);
 assert.ok(ranking.rejected.some(x=>x.reasons.some(r=>r.includes("invalid_or_cross_product_facet"))));
});
