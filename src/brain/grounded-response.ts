import type {Aspect,EvidenceRecord,RankingResult} from "./contracts.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";

export interface GroundedExplanation {
 text:string;
 items:{productId:string;variantId:string;name:string;totalPriceWon:number;
   evidenceIds:string[];indicators:{aspect:Aspect;score:number}[]}[];
 limitations:string[];
 kind:"VERIFIED_CANDIDATES"|"REFERENCE_ONLY"|"NO_MATCH";
}
const aspects:Aspect[]=["performance","eye_comfort","noise"];
const labels:Record<Aspect,string>={performance:"성능",eye_comfort:"눈 피로 관련",noise:"소음"};
/**
 * Deterministic, source-restricted explanations. Deliberately avoids converting
 * numerical upstream aspect scores into unsourced real-world performance claims.
 * This is NOT an LLM review summary and never executes Commerce tools.
 */
export function buildGroundedExplanation(ranking:RankingResult,evidence:EvidenceRecord[],plan:ShoppingPlan):GroundedExplanation{
 const found=new Map(evidence.map(e=>[e.id,e]));
 const safeName=(v:string|undefined,fallback:string)=>(v??fallback).slice(0,160);
 const budget=plan.maxTotalWon===null?"예산 상한 미설정":`총 예산 ${plan.maxTotalWon.toLocaleString("ko-KR")}원`;
 const criteria=plan.requiredConditions.length
   ?`확인할 필수 조건: ${plan.requiredConditions.slice(0,12).join(", ")}.`:"";
 if(!ranking.ranked.length){
   const reference=ranking.referenceOnly.length;
   return {kind:reference?"REFERENCE_ONLY":"NO_MATCH",items:[],
     text:reference
       ?`${budget} 조건에서 검증된 추천 후보는 없습니다. ${reference}개 후보는 리뷰 전체 수·평점·근거가 충분히 확인되지 않아 참고 정보로만 제공합니다.`
       :`${budget} 조건을 만족하며 근거가 확인된 추천 후보를 찾지 못했습니다. 조건을 조정하거나 검증된 정보를 추가해 주세요.`,
     limitations:[reference?"참고용 후보를 추천 적격 상품으로 취급하지 않습니다.":"확인된 추천 후보가 없습니다.",criteria].filter(Boolean)};
 }
 const items=ranking.ranked.slice(0,3).map(({candidate})=>{
   const ids:string[]=[],indicators:{aspect:Aspect;score:number}[]=[];
   for(const aspect of aspects){
     const f=candidate.facets[aspect];
     if(!f)continue;
     const legitimate=f.evidenceIds.filter(id=>{
       const e=found.get(id);
       return !!e&&e.productId===candidate.productId&&
         (e.variantId===null||e.variantId===candidate.variantId)&&
         (e.kind!=="REVIEW"||e.sourceKind==="REAL");
     });
     if(legitimate.length!==f.evidenceIds.length||!legitimate.length)continue;
     indicators.push({aspect,score:f.score});
     ids.push(...legitimate);
   }
   const price=(candidate.unitPriceWon??0)+(candidate.shippingFeeWon??0);
   return {productId:candidate.productId,variantId:candidate.variantId,
     name:safeName(candidate.productName,candidate.productId),totalPriceWon:price,
     evidenceIds:[...new Set(ids)].slice(0,12),indicators};
 });
 const segments=items.map((p,index)=>{
   const detail=p.indicators.map(x=>`${labels[x.aspect]} ${x.score.toFixed(2)}`).join(", ");
   return `${index+1}순위 ${p.name}: 총 ${p.totalPriceWon.toLocaleString("ko-KR")}원. `+
     (detail?`RAG가 제공한 근거 연결 평가 지표: ${detail}.`:"")+
     (p.evidenceIds.length?` 근거 ID: ${p.evidenceIds.join(", ")}.`:"");
 });
 return {kind:"VERIFIED_CANDIDATES",items,
   text:`${budget}을 기준으로 현재 구매 조건과 저장된 선호를 반영했습니다. ${criteria} `+
     segments.join(" ")+" 이 순서는 개인화 실험 점수이며 리뷰 원문에 대한 사실 검증이나 구매 만족도를 보장하지 않습니다.",
   limitations:[...new Set([
     ...(ranking.referenceOnly.length?["추가로 근거가 부족한 참고용 후보가 있습니다."]:[]),
     "Aspect 지표는 RAG 제공 점수입니다. 원문 의미와 품질은 실제 데이터 평가가 필요합니다."
   ])]};
}
