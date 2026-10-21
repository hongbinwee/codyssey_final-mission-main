import {getReviewComparisonEligibility,type ReviewAnalysisData,type AnalyzedReviewProduct,type AnalyzedReviewEvidence,type ReviewAnalysisCounts} from './review-analysis.ts';
import type {GroundedExplanation} from './grounded-response.ts';

type SourceKind='REAL'|'SYNTHETIC';
type Comparison={sourceKind:'REAL';rankBy:'positive';eligible:AnalyzedReviewProduct[]}|null;
const opinionTotal=(counts:ReviewAnalysisCounts)=>counts.positive+counts.negative+counts.mixed;
const validCount=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const validCounts=(value:unknown):value is ReviewAnalysisCounts=>{
 if(!value||typeof value!=='object')return false;
 const row=value as ReviewAnalysisCounts;
 return [row.positive,row.negative,row.mixed,row.unrelated,row.uncertain].every(validCount);
};
const safeText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&
 !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
function productName(product:AnalyzedReviewProduct):string{
 const name=product.name.trim().slice(0,160);
 return safeText(name,160)?name:'선택한 상품';
}
function countsFor(product:AnalyzedReviewProduct,sourceKind:SourceKind):ReviewAnalysisCounts|undefined{
 const value=product.countsBySource?.[sourceKind];return validCounts(value)?value:undefined;
}
function hasSourceRows(product:AnalyzedReviewProduct,sourceKind:SourceKind):boolean{
 const counts=countsFor(product,sourceKind);
 return Boolean(counts&&counts.positive+counts.negative+counts.mixed+counts.unrelated+counts.uncertain>0);
}
function displaySource(product:AnalyzedReviewProduct):SourceKind|undefined{
 if(hasSourceRows(product,'REAL'))return 'REAL';
 if(hasSourceRows(product,'SYNTHETIC'))return 'SYNTHETIC';
 return undefined;
}
function comparison(data:ReviewAnalysisData):Comparison{
 if(data.focus==='CONS')return null;
 if(getReviewComparisonEligibility(data)!=='COMPARABLE')return null;
 return {sourceKind:'REAL',rankBy:'positive',eligible:data.products};
}
function evidenceFor(product:AnalyzedReviewProduct,sourceKind:SourceKind,focus:'ALL'|'CONS'):AnalyzedReviewEvidence[]{
 const rows:AnalyzedReviewEvidence[]=[],seen=new Set<string>();
 const variant=typeof product.variantId==='string'&&product.variantId?product.variantId:undefined;
 for(const row of product.evidence??[]){
  if(!row||row.productId!==product.productId||row.sourceKind!==sourceKind||!safeText(row.sourceId,160)||
     !safeText(row.id,160)||!safeText(row.text,1200)||
     row.variantId!==null&&variant!==undefined&&row.variantId!==variant||seen.has(row.sourceId))continue;
  if(row.opinion!=='POSITIVE'&&row.opinion!=='NEGATIVE'&&row.opinion!=='MIXED')continue;
  seen.add(row.sourceId);rows.push(row);
 }
 const preferred=focus==='CONS'?['NEGATIVE','MIXED']:['POSITIVE','NEGATIVE','MIXED'];
 const ordered=preferred.flatMap(opinion=>rows.filter(row=>row.opinion===opinion));
 if(ordered.length<2)return ordered;
 const second=ordered.find(row=>row.opinion!==ordered[0]!.opinion)??ordered[1]!;
 return [ordered[0]!,second];
}
function citationFor(product:AnalyzedReviewProduct,row:AnalyzedReviewEvidence){
 return {productId:product.productId,variantId:product.variantId??'',sourceVariantId:row.variantId,
  sourceId:row.sourceId,sourceKind:row.sourceKind,quote:row.text};
}
function currentRank(product:AnalyzedReviewProduct,comparisonResult:Comparison):string|undefined{
 if(!comparisonResult)return;
 const count=(row:AnalyzedReviewProduct)=>countsFor(row,comparisonResult.sourceKind)?.[comparisonResult.rankBy]??0;
 const value=count(product),higher=comparisonResult.eligible.filter(row=>count(row)>value).length;
 const rank=higher+1,tied=comparisonResult.eligible.filter(row=>count(row)===value).length>1;
 return tied?`공동 ${rank}위`:`${rank}위`;
}
function productSummary(product:AnalyzedReviewProduct,data:ReviewAnalysisData,comparisonResult:Comparison):string{
 const name=productName(product),rank=currentRank(product,comparisonResult);
 if(product.status==='UNAVAILABLE')return `${name}: 후기를 확인하지 못했어요.`;
 const sourceKind=displaySource(product);
 if(!sourceKind){
  if(product.status==='COMPLETE'&&product.fetchedCount===0)return `${name}: 조회된 후기가 없어요.`;
  return `${name}: 후기 분류 건수를 확인하지 못했어요.`;
 }
 const counts=countsFor(product,sourceKind);
 if(!counts)return `${name}: 후기 분류 건수를 확인하지 못했어요.`;
 const sourceLabel=sourceKind==='REAL'?'수집 후기':'합성 후기';
 const sourceCount=opinionTotal(counts)+counts.unrelated+counts.uncertain;
 const scope=product.status==='COMPLETE'?`${sourceLabel} ${sourceCount}건`:`확인된 ${sourceLabel} ${sourceCount}건`;
 const completeness=product.status==='COMPLETE'?'조회 완료':'부분 조회';
 if(data.focus==='CONS'&&counts.negative+counts.mixed===0)
  return `${name}: ${data.aspectLabel}에 대한 부정·혼재 의견을 찾지 못했어요. (${sourceLabel}, ${scope}; ${completeness}).`;
 if(data.focus==='ALL'&&opinionTotal(counts)===0){
  const prefix=rank?`${rank} · `:'';
  if(counts.uncertain>0)return `${prefix}${name}: ${data.aspectLabel} 관련 후기 ${counts.uncertain}건은 긍정·부정을 판단하기 어려워 의견 수를 확정하지 않았어요. (${sourceLabel}, ${scope}; ${completeness}).`;
  return `${prefix}${name}: ${data.aspectLabel} 관련 긍정·부정·혼재 의견을 찾지 못했어요. 긍정 ${counts.positive}건, 부정 ${counts.negative}건, 혼재 ${counts.mixed}건 (${sourceLabel}, ${scope}; ${completeness}).`;
 }
 const opinion=data.focus==='CONS'?`부정 ${counts.negative}건, 혼재 ${counts.mixed}건`
  :`긍정 ${counts.positive}건, 부정 ${counts.negative}건, 혼재 ${counts.mixed}건`;
 const prefix=rank?`${rank} · `:'';
 return `${prefix}${name}: ${opinion} (${sourceLabel}, ${scope}; ${completeness}, 중복 ${product.duplicateCount}건 제외).`;
}
function comparisonHoldReason(data:ReviewAnalysisData):string{
 if(data.focus==='CONS')return `${data.aspectLabel}에 대한 부정·혼재 의견을 상품별로 정리했어요.`;
 switch(getReviewComparisonEligibility(data)){
  case 'INCOMPLETE':return '모든 비교 대상의 조회를 끝내지 못해 순위를 보류했어요.';
  case 'NO_REAL_REVIEWS':return '모든 비교 대상에 수집 후기가 없어 순위를 보류했어요. 합성 후기 수는 따로 표시했어요.';
  case 'UNCERTAIN':return '긍정 여부를 판단하기 어려운 후기가 있어 순위를 보류했어요.';
  case 'COMPARABLE':return '같은 기준으로 비교할 수 없어 순위를 보류했어요.';
 }
}
function overview(data:ReviewAnalysisData,comparisonResult:Comparison):string{
 if(data.status==='NEEDS_TARGET')return '이 대화에서 확인할 추천 상품이 없어요. 먼저 상품을 추천받거나 상품을 지정해 주세요.';
 if(data.status==='UNAVAILABLE')return '리뷰 분석 결과를 확인하지 못했어요. 잠시 후 다시 요청해 주세요.';
 if(!data.products.length)return '분석할 리뷰 결과가 없어요. 어느 추천 상품을 확인할지 알려주세요.';
 if(data.status==='PARTIAL'||data.products.some(row=>row.status==='PARTIAL'||row.status==='UNAVAILABLE'))
  return '일부 상품의 리뷰 조회가 끝나지 않아 현재 확인한 범위만 안내해요. 전체 통계나 순위는 확정할 수 없어요.';
 if(data.compare&&!comparisonResult)return comparisonHoldReason(data);
 if(data.focus==='CONS')return `${data.aspectLabel}에 대한 부정·혼재 의견을 상품별로 정리했어요.`;
 return `${data.aspectLabel} 관련 의견을 수집 후기를 기준으로 정리했어요.`+
  (comparisonResult?' 수집 후기의 긍정 의견 수를 비교했어요.':'');
}

/** Builds a factual response from server-validated Commerce counts; never calls an LLM. */
export function buildReviewAnalysisExplanation(data:ReviewAnalysisData):GroundedExplanation{
 const comparisonResult=comparison(data);
 const rows=data.products.map(product=>productSummary(product,data,comparisonResult));
 const citations=data.products.flatMap(product=>{
  const sourceKind=displaySource(product);
  return sourceKind?evidenceFor(product,sourceKind,data.focus).map(row=>citationFor(product,row)):[];
 }).slice(0,10);
 const text=[overview(data,comparisonResult),...rows].filter(Boolean).join('\n');
 const limitations=[
  '조회한 리뷰에 한해 보수적 규칙으로 분류했어요. 자동 분류가 모든 문맥을 정확히 해석한다고 보장하지 않아요.',
  '표시한 건수는 검증된 집계이며 인용 표본 수로 다시 계산하지 않았어요.',
  ...(data.status==='PARTIAL'||data.products.some(row=>row.status==='PARTIAL')?['리뷰 조회가 부분 완료되어 전체 통계나 비교 순위를 확정할 수 없어요.']:[]),
  ...(data.products.some(row=>displaySource(row)==='SYNTHETIC')?['합성 후기는 실제 구매자의 경험이 아니에요.']:[]),
  ...(data.products.some(row=>row.counts.uncertain>0)?['판단이 불확실한 리뷰는 긍정·부정으로 임의 분류하지 않았어요.']:[]),
  ...data.products.flatMap(row=>row.limitations??[]),
 ];
 return {kind:'REVIEW_ANALYSIS',reviewAnalysis:data,text,items:[],citations,limitations:[...new Set(limitations)]};
}
