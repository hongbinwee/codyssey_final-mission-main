import test from "node:test";
import assert from "node:assert/strict";
import {classifyReviewOpinion,createReviewAnalysisLookup,getReviewComparisonEligibility} from "../../src/brain/review-analysis.ts";
import {buildReviewAnalysisExplanation} from "../../src/brain/review-analysis-response.ts";
import type {AnalyzedReviewProduct,ReviewAnalysisCounts,ReviewAnalysisData} from "../../src/brain/review-analysis.ts";

const ok=(data:unknown)=>({ok:true as const,data,observed_at:"2026-10-20T00:00:00.000Z",trace_id:"trace"});
const notFound=()=>({ok:false as const,error:{code:"NOT_FOUND",message:"not found",recovery_action:"STOP" as const},trace_id:"trace"});
const variant=(id:string)=>({variant_id:id,option_values:{size:"standard"},effective_specs:{},unit_price_won:10000,stock_qty:1,availability:"AVAILABLE" as const,version:1});
const product=(id:string,name:string,variants:string[]=["v-1"],catalogContext?:unknown)=>ok({
 catalog_context:catalogContext,
 product:{id,name,brand:"brand",category:"beauty",description:"",images:[],specs:{},active:true,version:1,availability:"AVAILABLE"},
 variants:variants.map(variant),shipping_fee_won:0,
});
const review=(id:string,productId:string,variantId:string|null,sourceKind:"REAL"|"SYNTHETIC",sourceRef:string,body:string,rating=5)=>({
 id,product_id:productId,variant_id:variantId,source_kind:sourceKind,source_ref:sourceRef,body,rating,written_at:"2026-10-19T00:00:00.000Z",
});
const catalogContext={source:"test_items2",read_only:true,is_simulated:true};
function catalogStub(options:{products?:Record<string,unknown>;pages?:Record<string,unknown>;page?:(input:{product_id:string;variant_id?:string;sort?:string;cursor?:string;limit?:number})=>unknown}={}){
 const calls:{products:string[];reviews:{product_id:string;variant_id?:string;sort?:string;cursor?:string;limit?:number}[]}={products:[],reviews:[]};
 const catalog={
  getProduct:async(input:{product_id:string})=>{calls.products.push(input.product_id);return options.products?.[input.product_id]??notFound();},
  getReviews:async(input:{product_id:string;variant_id?:string;sort?:string;cursor?:string;limit?:number})=>{
   calls.reviews.push(input);return options.page?.(input)??options.pages?.[input.cursor??"first"]??ok({catalog_context:catalogContext,
    reviews:[],total_matching:0,returned_count:0,next_cursor:null,has_more:false,sort:input.sort??"LATEST"});
  },
 };
 return {catalog,calls};
}
const request=(patch:Record<string,unknown>={})=>({focus:"ALL" as const,compare:false,aspect:"moisturizing",...patch});
const target=(patch:Record<string,unknown>={})=>({productId:"p-1",name:"수분크림 A",displayIndex:1,...patch});
const counts=(patch:Partial<ReviewAnalysisCounts>={}):ReviewAnalysisCounts=>({positive:0,negative:0,mixed:0,unrelated:0,uncertain:0,...patch});
function comparisonProduct(id:string,displayIndex:number,real:Partial<ReviewAnalysisCounts>,synthetic:Partial<ReviewAnalysisCounts>={},status:AnalyzedReviewProduct["status"]="COMPLETE"):AnalyzedReviewProduct{
 const countsBySource={REAL:counts(real),SYNTHETIC:counts(synthetic)};
 const all=counts({positive:countsBySource.REAL.positive+countsBySource.SYNTHETIC.positive,
  negative:countsBySource.REAL.negative+countsBySource.SYNTHETIC.negative,mixed:countsBySource.REAL.mixed+countsBySource.SYNTHETIC.mixed,
  unrelated:countsBySource.REAL.unrelated+countsBySource.SYNTHETIC.unrelated,uncertain:countsBySource.REAL.uncertain+countsBySource.SYNTHETIC.uncertain});
 const total=Object.values(all).reduce((sum,value)=>sum+value,0);
 return {productId:id,name:`상품 ${id}`,displayIndex,status,totalMatching:total,fetchedCount:total,uniqueCount:total,duplicateCount:0,excludedCount:0,
  counts:all,countsBySource,evidence:[],limitations:[]};
}
function comparisonData(products:AnalyzedReviewProduct[],status:ReviewAnalysisData["status"]="READY"):ReviewAnalysisData{
 return {status,aspect:"moisturizing",aspectLabel:"보습력",focus:"ALL",compare:true,method:"CONSERVATIVE_RULES",datasetVersion:"qa13",products};
}

test("moisture and comfort classifications distinguish positive, negative, mixed, unrelated and uncertain reviews",()=>{
 const cases:[string,string,string][]=[
  ["촉촉해서 좋아요.","moisturizing","POSITIVE"],
  ["보습력이 좋아서 만족해요.","보습력","POSITIVE"],
  ["촉촉하지만 끈적여요.","moisturizing","POSITIVE"],
  ["촉촉하지만 끈적여요.","comfort","NEGATIVE"],
  ["촉촉하다고 해서 샀는데 건조해요.","수분감","NEGATIVE"],
  ["촉촉하지 않아요.","moisturizing","NEGATIVE"],
  ["촉촉하지만 사용 후 건조해요.","moisturizing","MIXED"],
  ["보습력이 좋지 않아요.","moisturizing","NEGATIVE"],
  ["수분감이 충분하지 않아요.","moisturizing","NEGATIVE"],
  ["건조하지 않아서 좋아요.","moisturizing","POSITIVE"],
  ["촉촉하긴 하지만 금방 말라요.","moisturizing","MIXED"],
  ["촉촉한 건 맞지만 제게는 향이 별로예요.","moisturizing","UNCERTAIN"],
  ["건조한 피부에 쓰려고 샀어요. 배송은 좋아요.","moisturizing","UNCERTAIN"],
  ["배송이 빨라요.","moisturizing","UNRELATED"],
  ["촉촉한 편이에요.","moisturizing","UNCERTAIN"],
  ["착용감이 잘 맞아요.","fit","POSITIVE"],
 ];
 for(const [text,aspect,expected] of cases)assert.equal(classifyReviewOpinion(text,aspect),expected,`${aspect}: ${text}`);
});

test("full catalog pagination includes product and selected-variant reviews but excludes other variants",async()=>{
 const rows=[
  review("real-null","p-1",null,"REAL","oliveyoung:A0001:review:9001","촉촉해서 좋아요."),
  review("real-v1","p-1","v-1","REAL","oliveyoung:A0001:review:9002","보습이 부족하고 건조해요."),
  review("other-v","p-1","v-other","REAL","oliveyoung:A0001:review:9003","수분감이 좋아요."),
  review("synthetic-1","p-1",null,"SYNTHETIC","synthetic:v5.2:oliveyoung:A0001","수분감이 좋아요."),
  review("synthetic-2","p-1",null,"SYNTHETIC","synthetic:v5.2:oliveyoung:A0001","촉촉해서 좋아요.",4),
 ];
 const {catalog,calls}=catalogStub({products:{"p-1":product("p-1","수분크림 A",["v-1","v-other"],catalogContext)},
  page:input=>{
   const data=input.cursor?rows.slice(2):rows.slice(0,2);
   return ok({catalog_context:catalogContext,reviews:data,total_matching:rows.length,returned_count:data.length,
    next_cursor:input.cursor?null:"next-page",has_more:!input.cursor,sort:input.sort??"LATEST"});
  }});
 const lookup=createReviewAnalysisLookup(catalog as never,"test_items2:v6.1-review-refined");
 const result=await lookup({request:request({aspect:"수분감"}),products:[target({variantId:"v-1"})]});
 const analyzed=result.products[0]!;
 assert.equal(result.status,"READY");
 assert.equal(result.aspect,"moisturizing");
 assert.equal(result.aspectLabel,"보습력");
 assert.equal(result.datasetVersion,"test_items2:v6.1-review-refined");
 assert.equal(analyzed.status,"COMPLETE");
 assert.equal(analyzed.totalMatching,4,"selected option plus product-level reviews are the analysis denominator");
 assert.equal(analyzed.fetchedCount,5,"all product reviews are paged before option filtering");
 assert.equal(analyzed.uniqueCount,4);
 assert.equal(analyzed.excludedCount,1);
 assert.deepEqual(analyzed.counts,{positive:3,negative:1,mixed:0,unrelated:0,uncertain:0});
 assert.deepEqual(analyzed.countsBySource,{REAL:{positive:1,negative:1,mixed:0,unrelated:0,uncertain:0},SYNTHETIC:{positive:2,negative:0,mixed:0,unrelated:0,uncertain:0}});
 assert.deepEqual(analyzed.evidence.map(item=>item.id),["real-null","real-v1","synthetic-1","synthetic-2"]);
 assert.deepEqual(analyzed.evidence.slice(-2).map(item=>item.sourceRef),["synthetic:v5.2:oliveyoung:A0001","synthetic:v5.2:oliveyoung:A0001"]);
 assert.equal(analyzed.evidence[0]?.variantId,null);
 assert.equal(analyzed.evidence[1]?.variantId,"v-1");
 assert.ok(calls.reviews.every(input=>input.product_id==="p-1"&&input.sort==="LATEST"&&input.limit===50&&!input.variant_id));
 assert.deepEqual(calls.reviews.map(input=>input.cursor??"first"),["first","next-page"]);
});

test("duplicate IDs and identical known REAL source refs deduplicate, while synthetic refs do not",async()=>{
 const rows=[
  review("id-copy","p-1",null,"REAL","oliveyoung:A0001:review:1","촉촉해서 좋아요."),
  review("id-copy","p-1",null,"REAL","oliveyoung:A0001:review:1","촉촉해서 좋아요."),
  review("real-copy-a","p-1",null,"REAL","oliveyoung:A0001:review:2","보습력이 좋아요."),
  review("real-copy-b","p-1",null,"REAL","oliveyoung:A0001:review:2","보습력이 좋아요."),
  review("syn-a","p-1",null,"SYNTHETIC","synthetic:v5.2:oliveyoung:A0001","수분감이 좋아요."),
  review("syn-b","p-1",null,"SYNTHETIC","synthetic:v5.2:oliveyoung:A0001","수분감이 좋아요.",4),
 ];
 const {catalog}=catalogStub({products:{"p-1":product("p-1","수분크림 A",[],catalogContext)},
  page:()=>ok({catalog_context:catalogContext,reviews:rows,total_matching:rows.length,returned_count:rows.length,next_cursor:null,has_more:false,sort:"LATEST"})});
 const result=await createReviewAnalysisLookup(catalog as never)({request:request(),products:[target({variantId:undefined})]});
 const analyzed=result.products[0]!;
 assert.equal(result.status,"READY");
 assert.equal(analyzed.uniqueCount,4);
 assert.equal(analyzed.duplicateCount,2);
 assert.equal(analyzed.counts.positive,4);
 assert.equal(analyzed.evidence.filter(item=>item.sourceKind==="SYNTHETIC").length,2);
});

test("conflicting known REAL references become uncertain rather than merging or inflating polarity",async()=>{
 const rows=[
  review("real-a","p-1",null,"REAL","oliveyoung:A0001:review:99","촉촉해서 좋아요."),
  review("real-b","p-1","v-1","REAL","oliveyoung:A0001:review:99","건조해서 아쉬워요."),
 ];
 const {catalog}=catalogStub({products:{"p-1":product("p-1","수분크림 A",["v-1"],catalogContext)},
  page:()=>ok({catalog_context:catalogContext,reviews:rows,total_matching:2,returned_count:2,next_cursor:null,has_more:false,sort:"LATEST"})});
 const result=await createReviewAnalysisLookup(catalog as never)({request:request(),products:[target()]});
 const analyzed=result.products[0]!;
 assert.equal(analyzed.uniqueCount,2);
 assert.equal(analyzed.counts.positive,0);
 assert.equal(analyzed.counts.negative,0);
 assert.equal(analyzed.counts.uncertain,2);
 assert.deepEqual(analyzed.evidence.map(item=>item.opinion),["UNCERTAIN","UNCERTAIN"]);
});

test("cursor loops, count drift, and mid-scan failures return only partial analysis",async(t)=>{
 await t.test("repeated cursor",async()=>{
  const {catalog}=catalogStub({products:{"p-1":product("p-1","수분크림 A",[],catalogContext)},
   page:input=>ok({catalog_context:catalogContext,reviews:[review(`r-${input.cursor??"first"}`,"p-1",null,"REAL","unknown-ref","촉촉해서 좋아요.")],
    total_matching:10,returned_count:1,next_cursor:"loop",has_more:true,sort:"LATEST"})});
  const result=await createReviewAnalysisLookup(catalog as never)({request:request(),products:[target()]});
  assert.equal(result.status,"PARTIAL");
  assert.equal(result.products[0]?.status,"PARTIAL");
  assert.equal(result.products[0]?.uniqueCount,2);
  assert.ok(result.products[0]?.limitations.some(text=>/cursor|pagination|page|전체/i.test(text)));
 });
 await t.test("count drift",async()=>{
  const {catalog}=catalogStub({products:{"p-1":product("p-1","수분크림 A",[],catalogContext)},
   page:input=>ok({catalog_context:catalogContext,reviews:[review("r","p-1",null,"REAL","unknown-ref","촉촉해서 좋아요.")],
    total_matching:input.cursor?2:3,returned_count:1,next_cursor:input.cursor?null:"next",has_more:!input.cursor,sort:"LATEST"})});
  const result=await createReviewAnalysisLookup(catalog as never)({request:request(),products:[target()]});
  assert.equal(result.status,"PARTIAL");
  assert.equal(result.products[0]?.status,"PARTIAL");
  assert.equal(result.products[0]?.counts.positive,1);
  assert.ok(result.products[0]?.limitations.some(text=>/count|total|수|통계/i.test(text)));
 });
 await t.test("review service failure after a page",async()=>{
  let calls=0;
  const {catalog}=catalogStub({products:{"p-1":product("p-1","수분크림 A",[],catalogContext)},
   page:()=>++calls===1?ok({catalog_context:catalogContext,reviews:[review("r","p-1",null,"REAL","unknown-ref","촉촉해서 좋아요.")],
    total_matching:2,returned_count:1,next_cursor:"next",has_more:true,sort:"LATEST"}):{ok:false,error:{code:"INTERNAL",message:"failed",recovery_action:"STOP"},trace_id:"trace"}});
  const result=await createReviewAnalysisLookup(catalog as never)({request:request(),products:[target()]});
  assert.equal(result.status,"PARTIAL");
  assert.equal(result.products[0]?.status,"PARTIAL");
  assert.equal(result.products[0]?.counts.positive,1);
 });
});

test("invalid product identity or an unverified selected variant is unavailable without review reads",async()=>{
 const mismatched=catalogStub({products:{"p-1":product("p-2","다른 상품",["v-1"],catalogContext)}});
 const mismatch=await createReviewAnalysisLookup(mismatched.catalog as never)({request:request(),products:[target()]});
 assert.equal(mismatch.status,"UNAVAILABLE");
 assert.equal(mismatched.calls.reviews.length,0);
 const foreign=catalogStub({products:{"p-1":product("p-1","수분크림 A",["v-other"],catalogContext)}});
 const wrongVariant=await createReviewAnalysisLookup(foreign.catalog as never)({request:request(),products:[target({variantId:"v-1"})]});
 assert.equal(wrongVariant.products[0]?.status,"UNAVAILABLE");
 assert.equal(foreign.calls.reviews.length,0);
});

test("more than three targets is refused; CONS returns only non-positive representative evidence",async()=>{
 const {catalog,calls}=catalogStub({products:{"p-1":product("p-1","수분크림 A",[],catalogContext)},
  page:()=>ok({catalog_context:catalogContext,reviews:[
   review("positive","p-1",null,"REAL","unknown:1","촉촉해서 좋아요."),
   review("negative","p-1",null,"REAL","unknown:2","건조해서 아쉬워요."),
   review("unrelated","p-1",null,"REAL","unknown:3","배송이 빨라요."),
  ],total_matching:3,returned_count:3,next_cursor:null,has_more:false,sort:"LATEST"})});
 const lookup=createReviewAnalysisLookup(catalog as never);
 const refused=await lookup({request:request(),products:[target(),target({productId:"p-2",displayIndex:2}),target({productId:"p-3",displayIndex:3}),target({productId:"p-4",displayIndex:4})]});
 assert.equal(refused.status,"NEEDS_TARGET");
 assert.equal(calls.reviews.length,0);
 const result=await lookup({request:request({focus:"CONS"}),products:[target()]});
 assert.deepEqual(result.products[0]?.counts,{positive:1,negative:1,mixed:0,unrelated:1,uncertain:0});
 assert.deepEqual(result.products[0]?.evidence.map(item=>item.id),["negative"]);
});

test("page safety cap keeps incomplete status and counts all fetched rows separately from six quotes",async()=>{
 let pageNumber=0;
 const {catalog,calls}=catalogStub({products:{"p-1":product("p-1","수분크림 A",[],catalogContext)},
  page:input=>{
   pageNumber++;
   const rows=Array.from({length:50},(_,index)=>review(`r-${pageNumber}-${index}`,"p-1",null,"REAL",`unknown:${pageNumber}:${index}`,"촉촉해서 좋아요."));
   return ok({catalog_context:catalogContext,reviews:rows,total_matching:2000,returned_count:50,next_cursor:`cursor-${pageNumber}`,has_more:true,sort:input.sort??"LATEST"});
  }});
 const result=await createReviewAnalysisLookup(catalog as never)({request:request(),products:[target()]});
 const analyzed=result.products[0]!;
 assert.equal(result.status,"PARTIAL");
 assert.equal(analyzed.status,"PARTIAL");
 assert.equal(calls.reviews.length,20);
 assert.equal(analyzed.fetchedCount,1000);
 assert.equal(analyzed.uniqueCount,1000);
 assert.equal(analyzed.counts.positive,1000,"aggregate counts cover all fetched unique reviews");
 assert.equal(analyzed.evidence.length,6,"representative quotes are separately bounded");
});

test("shared positive-comparison eligibility permits verified zero-positive ties and holds uncertain, partial, or synthetic-only sets",async t=>{
 await t.test("REAL unrelated, negative, and mixed rows remain comparable when every positive count is zero",()=>{
  const data=comparisonData([comparisonProduct("unrelated",1,{unrelated:2}),comparisonProduct("negative",2,{negative:1}),comparisonProduct("mixed",3,{mixed:1})]);
  assert.equal(getReviewComparisonEligibility(data),"COMPARABLE");
  const explanation=buildReviewAnalysisExplanation(data);
  assert.equal(explanation.text.match(/공동 1위/g)?.length,3);
  const unrelatedLine=explanation.text.split("\n").find(line=>line.includes("상품 unrelated"))??"";
  assert.match(unrelatedLine,/긍정 0건, 부정 0건, 혼재 0건/);
  assert.match(unrelatedLine,/관련 긍정·부정·혼재 의견을 찾지 못했어요/);
 });
 await t.test("zero positive plus uncertain REAL reviews is held without claiming a verified zero",()=>{
  const data=comparisonData([comparisonProduct("uncertain",1,{uncertain:1}),comparisonProduct("negative",2,{negative:1})]);
  assert.equal(getReviewComparisonEligibility(data),"UNCERTAIN");
  const explanation=buildReviewAnalysisExplanation(data);
  assert.match(explanation.text,/긍정·부정을 판단하기 어려워 의견 수를 확정하지 않았어요/);
  assert.doesNotMatch(explanation.text,/(?:공동\s*)?\d+위/);
  assert.doesNotMatch(explanation.text.split("\n").find(line=>line.includes("상품 uncertain"))??"",/긍정 0건/);
 });
 await t.test("a partial target makes the set incomplete",()=>{
  const data=comparisonData([comparisonProduct("partial",1,{positive:1}, {},"PARTIAL"),comparisonProduct("complete",2,{positive:1})],"PARTIAL");
  assert.equal(getReviewComparisonEligibility(data),"INCOMPLETE");
  assert.doesNotMatch(buildReviewAnalysisExplanation(data).text,/(?:공동\s*)?\d+위/);
 });
 await t.test("synthetic-only reviews never qualify for REAL ranking",()=>{
  const data=comparisonData([comparisonProduct("synthetic-a",1,{}, {positive:2}),comparisonProduct("synthetic-b",2,{}, {positive:1})]);
  assert.equal(getReviewComparisonEligibility(data),"NO_REAL_REVIEWS");
  const explanation=buildReviewAnalysisExplanation(data);
  assert.match(explanation.text,/합성 후기/);
  assert.doesNotMatch(explanation.text,/(?:공동\s*)?\d+위/);
 });
});

test("comparison eligibility refuses negative, NaN, and missing REAL aggregate counts",()=>{
 const malformed:unknown[]=[{...counts({positive:1}),negative:-1},{...counts({positive:1}),negative:Number.NaN},undefined];
 for(const realCounts of malformed){
  const data=comparisonData([comparisonProduct("malformed",1,{positive:1}),comparisonProduct("valid",2,{positive:1})]);
  (data.products[0]!.countsBySource as unknown as Record<string,unknown>).REAL=realCounts;
  assert.equal(getReviewComparisonEligibility(data),"INCOMPLETE");
 }
});
