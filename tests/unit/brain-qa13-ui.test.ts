import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {registerHooks} from "node:module";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {JsxEmit,ModuleKind,transpileModule} from "typescript";
import type {AnalyzedReviewProduct,ReviewAnalysisData} from "../../src/brain/review-analysis.ts";

const loader=registerHooks({
 load(url,context,nextLoad){
  if(!url.endsWith(".tsx"))return nextLoad(url,context);
  return {format:"module",shortCircuit:true,source:transpileModule(readFileSync(new URL(url),"utf8"),{
   compilerOptions:{jsx:JsxEmit.ReactJSX,module:ModuleKind.ESNext},
  }).outputText};
 },
});
const {BrainReviewAnalysis}=await import("../../src/web/components/BrainReviewAnalysis.tsx");
loader.deregister();

const emptyCounts=()=>({positive:0,negative:0,mixed:0,unrelated:0,uncertain:0});
const product=(overrides:Partial<AnalyzedReviewProduct>):AnalyzedReviewProduct=>({
 productId:"qa-product-1",variantId:"qa-variant-1",name:"상품 A",displayIndex:1,status:"COMPLETE",
 totalMatching:3,fetchedCount:3,uniqueCount:3,duplicateCount:0,excludedCount:0,
 counts:{...emptyCounts(),positive:1,negative:1,mixed:1},
 countsBySource:{REAL:{...emptyCounts(),positive:1,negative:1},SYNTHETIC:{...emptyCounts(),mixed:1}},
 evidence:[
  {id:"evidence-real",sourceId:"raw-source-id-real",productId:"qa-product-1",variantId:null,sourceKind:"REAL",sourceRef:"raw-source-ref-shared",text:"상품 단위 수집 리뷰 원문이에요.",opinion:"POSITIVE"},
  {id:"evidence-synthetic-a",sourceId:"raw-source-id-synthetic-a",productId:"qa-product-1",variantId:"qa-variant-1",sourceKind:"SYNTHETIC",sourceRef:"raw-source-ref-shared",text:"옵션 합성 리뷰 원문 하나예요.",opinion:"MIXED"},
  {id:"evidence-synthetic-b",sourceId:"raw-source-id-synthetic-b",productId:"qa-product-1",variantId:"qa-variant-1",sourceKind:"SYNTHETIC",sourceRef:"raw-source-ref-shared",text:"옵션 합성 리뷰 원문 둘이에요.",opinion:"NEGATIVE"},
 ],limitations:["규칙 기반 판정이라 의미를 정확히 확정하지 못할 수 있어요."],...overrides,
});
const analysis=(products:AnalyzedReviewProduct[],overrides:Partial<ReviewAnalysisData>={}):ReviewAnalysisData=>({
 status:"READY",aspect:"moisturizing",aspectLabel:"보습력",focus:"ALL",compare:products.length>1,
 method:"CONSERVATIVE_RULES",products,...overrides,
});

test("review analysis preserves product/variant evidence and REAL/SYNTHETIC labels without exposing source identifiers",()=>{
 const result=analysis([product({})]);
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:result}));
 assert.match(html,/상품 A/);
 assert.match(html,/상품 단위 수집 리뷰 원문이에요/);
 assert.match(html,/옵션 합성 리뷰 원문 하나예요/);
 assert.match(html,/옵션 합성 리뷰 원문 둘이에요/);
 assert.match(html,/수집 리뷰/);assert.match(html,/합성 리뷰/);
 assert.match(html,/긍정/);assert.match(html,/부정/);assert.match(html,/혼합/);
 assert.match(html,/규칙 분류/);
 assert.doesNotMatch(html,/raw-source-id|raw-source-ref|qa-product-1|qa-variant-1/);
 assert.doesNotMatch(html,/추천 상품|다른 상품 보기|순위 추천/);
});

test("comparison ranks by REAL positive opinions and keeps synthetic counts separate",()=>{
 const first=product({name:"상품 A",displayIndex:1,counts:{...emptyCounts(),positive:52,negative:1,mixed:1},uniqueCount:54,
  countsBySource:{REAL:{...emptyCounts(),positive:2,negative:1},SYNTHETIC:{...emptyCounts(),positive:50,mixed:1}}});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,counts:{...emptyCounts(),positive:3},uniqueCount:3,
  countsBySource:{REAL:{...emptyCounts(),positive:3},SYNTHETIC:emptyCounts()},evidence:[]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{compare:true})}));
 assert.match(html,/상품 간 비교/);
 assert.match(html,/2위/);assert.match(html,/1위/);assert.doesNotMatch(html,/공동 1위/);
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.ok(comparison.indexOf("상품 B")<comparison.indexOf("상품 A"));
 assert.match(comparison,/수집 리뷰/);assert.match(comparison,/합성 리뷰/);
 assert.doesNotMatch(comparison,/52/);
 assert.doesNotMatch(html,/qa-product-1|qa-product-2/);
});

test("comparison sorts equal REAL positive counts by display index without mutating product order",()=>{
 const first=product({name:"상품 A",displayIndex:2,countsBySource:{REAL:{...emptyCounts(),positive:3},SYNTHETIC:emptyCounts()}});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:1,
  countsBySource:{REAL:{...emptyCounts(),positive:3},SYNTHETIC:emptyCounts()},evidence:[]});
 const result=analysis([first,second],{compare:true});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:result}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.ok(comparison.indexOf("상품 B")<comparison.indexOf("상품 A"));
 assert.equal((comparison.match(/공동 1위/g)??[]).length,2);
 assert.equal(result.products[0]?.name,"상품 A");assert.equal(result.products[1]?.name,"상품 B");
});

test("comparison with any incomplete target holds every rank",()=>{
 const first=product({name:"상품 A",displayIndex:1,countsBySource:{REAL:{...emptyCounts(),positive:2},SYNTHETIC:emptyCounts()}});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,status:"PARTIAL",
  countsBySource:{REAL:{...emptyCounts(),positive:7},SYNTHETIC:emptyCounts()},evidence:[]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{status:"PARTIAL",compare:true})}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.equal((comparison.match(/비교 보류/g)??[]).length,2);
 assert.doesNotMatch(comparison,/[1-9]위|공동 \d+위/);
});

test("complete REAL reviews with zero positive and no uncertainty share rank one",()=>{
 const first=product({name:"상품 A",displayIndex:1,counts:{...emptyCounts(),positive:20},
  countsBySource:{REAL:{...emptyCounts(),unrelated:4},SYNTHETIC:{...emptyCounts(),positive:20}},
  evidence:[{id:"real-a",sourceId:"raw-real-a",productId:"qa-product-1",variantId:null,sourceKind:"REAL",sourceRef:"ref-real-a",text:"보습과 무관한 수집 리뷰예요.",opinion:"UNRELATED"}]});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,counts:{...emptyCounts(),positive:1},
  countsBySource:{REAL:{...emptyCounts(),negative:2},SYNTHETIC:{...emptyCounts(),positive:1}},
  evidence:[{id:"real-b",sourceId:"raw-real-b",productId:"qa-product-2",variantId:null,sourceKind:"REAL",sourceRef:"ref-real-b",text:"보습이 부족한 수집 리뷰예요.",opinion:"NEGATIVE"}]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{compare:true})}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.equal((comparison.match(/공동 1위/g)??[]).length,2);
 assert.match(comparison,/순위/);
});

test("uncertain REAL opinions hold every comparison rank",()=>{
 const first=product({name:"상품 A",displayIndex:1,countsBySource:{REAL:{...emptyCounts(),positive:2},SYNTHETIC:emptyCounts()}});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,
  countsBySource:{REAL:{...emptyCounts(),uncertain:1},SYNTHETIC:emptyCounts()},evidence:[]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{compare:true})}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.equal((comparison.match(/비교 보류/g)??[]).length,2);
 assert.match(comparison,/<th scope="row">수집 리뷰<\/th><td>0<\/td><td>0<\/td><td>0<\/td><td>0<\/td><td>1<\/td>/);
 assert.doesNotMatch(comparison,/[1-9]위|공동 \d+위/);
});

test("positive REAL counts remain rankable when uncertain opinions are also shown",()=>{
 const first=product({name:"상품 A",displayIndex:1,countsBySource:{REAL:{...emptyCounts(),positive:2,uncertain:1},SYNTHETIC:emptyCounts()}});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,
  countsBySource:{REAL:{...emptyCounts(),positive:1,uncertain:1},SYNTHETIC:emptyCounts()},evidence:[]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{compare:true})}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.ok(comparison.indexOf("상품 A")<comparison.indexOf("상품 B"));
 assert.match(comparison,/1위/);assert.match(comparison,/2위/);assert.doesNotMatch(comparison,/비교 보류/);
 assert.match(comparison,/<td>2<\/td><td>0<\/td><td>0<\/td><td>0<\/td><td>1<\/td>/);
});

test("comparison allows a 2 to 0 REAL positive result when both products have related judgments",()=>{
 const first=product({name:"상품 A",displayIndex:1,countsBySource:{REAL:{...emptyCounts(),positive:2},SYNTHETIC:emptyCounts()}});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,
  countsBySource:{REAL:{...emptyCounts(),negative:2},SYNTHETIC:emptyCounts()},evidence:[]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{compare:true})}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.match(comparison,/1위/);assert.match(comparison,/2위/);assert.doesNotMatch(comparison,/비교 보류/);
 assert.ok(comparison.indexOf("상품 A")<comparison.indexOf("상품 B"));
});

test("comparison holds when products have no REAL reviews",()=>{
 const first=product({name:"상품 A",displayIndex:1,countsBySource:{REAL:emptyCounts(),SYNTHETIC:{...emptyCounts(),positive:2}},evidence:[]});
 const second=product({productId:"qa-product-2",variantId:undefined,name:"상품 B",displayIndex:2,
  countsBySource:{REAL:emptyCounts(),SYNTHETIC:{...emptyCounts(),positive:1}},evidence:[]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([first,second],{compare:true})}));
 const comparison=html.slice(html.indexOf('aria-label="상품 간 리뷰 비교"'),html.indexOf("</section>",html.indexOf('aria-label="상품 간 리뷰 비교"')));
 assert.equal((comparison.match(/비교 보류/g)??[]).length,2);
 assert.doesNotMatch(comparison,/[1-9]위|공동 \d+위/);
});

test("CONS comparison prioritizes negative and mixed quotes without ranking products",()=>{
 const result=analysis([product({})],{focus:"CONS",compare:true});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:result}));
 assert.match(html,/부정·혼재 의견/);assert.match(html,/먼저/);
 assert.match(html,/부정·혼재 의견 원문/);
 assert.ok(html.indexOf("옵션 합성 리뷰 원문 둘이에요")<html.indexOf("옵션 합성 리뷰 원문 하나예요"));
 assert.doesNotMatch(html,/상품 간 비교|공동 \d+위|[1-9]위/);
});

test("product level analysis preserves evidence across variants when no variant is selected",()=>{
 const allVariants=product({variantId:undefined,evidence:[
  {id:"evidence-option-a",sourceId:"raw-a",productId:"qa-product-1",variantId:"option-a",sourceKind:"REAL",sourceRef:"ref-a",text:"옵션 A 리뷰도 표시돼요.",opinion:"POSITIVE"},
  {id:"evidence-option-b",sourceId:"raw-b",productId:"qa-product-1",variantId:"option-b",sourceKind:"SYNTHETIC",sourceRef:"ref-b",text:"옵션 B 리뷰도 표시돼요.",opinion:"NEGATIVE"},
 ]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([allVariants])}));
 assert.match(html,/옵션 A 리뷰도 표시돼요/);assert.match(html,/옵션 B 리뷰도 표시돼요/);
});

test("selected variant analysis keeps product level and selected variant evidence only",()=>{
 const selected=product({evidence:[
  {id:"evidence-base",sourceId:"raw-base",productId:"qa-product-1",variantId:null,sourceKind:"REAL",sourceRef:"ref-base",text:"상품 공통 리뷰예요.",opinion:"POSITIVE"},
  {id:"evidence-selected",sourceId:"raw-selected",productId:"qa-product-1",variantId:"qa-variant-1",sourceKind:"SYNTHETIC",sourceRef:"ref-selected",text:"선택 옵션 리뷰예요.",opinion:"MIXED"},
  {id:"evidence-other",sourceId:"raw-other",productId:"qa-product-1",variantId:"other-variant",sourceKind:"SYNTHETIC",sourceRef:"ref-other",text:"다른 옵션 리뷰예요.",opinion:"NEGATIVE"},
 ]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([selected])}));
 assert.match(html,/상품 공통 리뷰예요/);assert.match(html,/선택 옵션 리뷰예요/);assert.doesNotMatch(html,/다른 옵션 리뷰예요/);
});

test("backend catalog and dataset version limitations are shown as natural user facing copy",()=>{
 const limited=product({limitations:[
  "Commerce 리뷰 페이지 조회가 실패해 전체 집계를 확정하지 않았습니다.",
  "Catalog 조회 설정에서 datasetVersion을 받지 못했습니다.",
  "Catalog 응답은 데이터셋 버전을 노출하지 않아 datasetVersion은 실행 설정값이며 Commerce 원본과 독립 대조되지 않았습니다.",
 ]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([limited])}));
 assert.doesNotMatch(html,/Commerce|Catalog|datasetVersion/);
 assert.match(html,/리뷰 페이지/);
 assert.match(html,/데이터 출처의 버전/);
});

test("partial review analysis labels its observed scope and does not claim complete totals",()=>{
 const partial=product({status:"PARTIAL",totalMatching:30,fetchedCount:10,uniqueCount:9,duplicateCount:1,
  limitations:["일부 페이지 조회가 끝나지 않아 전체 의견 수로 볼 수 없어요."]});
 const html=renderToStaticMarkup(createElement(BrainReviewAnalysis,{analysis:analysis([partial],{status:"PARTIAL",compare:false})}));
 assert.match(html,/일부 조회/);assert.match(html,/9/);assert.match(html,/전체 .*미확정/);
 assert.doesNotMatch(html,/전체 리뷰 30건을 분석했어요/);
});
