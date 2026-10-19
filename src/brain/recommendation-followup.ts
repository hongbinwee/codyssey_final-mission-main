import type {ResearchResult} from "./read-flow.ts";
import type {GroundedExplanation} from "./grounded-response.ts";

/** Explain a previously displayed ranking without doing another catalog/RAG/model call. */
function requestedPosition(text:string):number|null {
 const trimmed=text.trim();
 if(trimmed.length>110||!/(왜|이유)/.test(trimmed))return null;
 const lead=trimmed.replace(/^(?:아까|방금|그중|그 중|지난번|추천한)\s*/,"");
 const numeral=/^([1-3])\s*(?:순위|위|번(?:째)?|번째)/.exec(lead);
 if(numeral)return Number(numeral[1])-1;
 const korean=/^(첫|두|세)\s*번째/.exec(lead);
 return korean?{"첫":0,"두":1,"세":2}[korean[1] as "첫"|"두"|"세"]:null;
}

export function explainPreviousRecommendation(
 message:string,previous:ResearchResult|undefined,datasetVersion?:string
):GroundedExplanation|null {
 const position=requestedPosition(message);
 if(position===null||!previous?.explanation?.items.length||
  !previous.ranking?.ranked?.length||
  previous.explanation.kind==="CLARIFICATION"||
  previous.explanation.kind==="NO_MATCH"||
  previous.explanation.failure?.code==="RETRIEVAL_UNAVAILABLE"||
  (datasetVersion&&previous.datasetVersion!==datasetVersion))return null;

 // Match the same eligibility and order used by the BrainPreview's cards.
 const fallback=!!previous.explanation.failure;
 const seen=new Set<string>();
 const displayed=previous.ranking.ranked.filter(row=>{
  const c=row.candidate;
  if(c.commerceVerified!==true||seen.has(c.productId))return false;
  if(!fallback&&!previous.explanation!.items.some(item=>
   item.productId===c.productId&&(!item.variantId||item.variantId===c.variantId)))return false;
  seen.add(c.productId);return true;
 }).slice(0,3);
 const row=displayed[position];
 if(!row)return null;
 const c=row.candidate;
 const matched=previous.explanation.items.find(item=>
  item.productId===c.productId&&(!item.variantId||item.variantId===c.variantId));
 const name=(c.productName??matched?.name??"상품").replace(/[\u0000-\u001f]/g," ").slice(0,100);
 const price=c.unitPriceWon,shipping=c.shippingFeeWon;
 const notes:string[]=[];
 if(price!==null&&shipping!==null&&Number.isSafeInteger(price+shipping)&&price>=0&&shipping>=0){
  notes.push(`당시 확인된 가격은 배송비 포함 ${(price+shipping).toLocaleString("ko-KR")}원이에요.`);
  if(previous.shoppingPlan?.maxTotalWon!==null&&
     previous.shoppingPlan?.maxTotalWon!==undefined&&price+shipping<=previous.shoppingPlan.maxTotalWon)
   notes.push("요청하신 예산 안에 들어왔어요.");
 }
 const reason=matched?.reason?.trim();
 if(reason&&reason.length<=1000)notes.push(reason);
 else notes.push("당시 요청 조건과 검증된 상품 정보를 기준으로 추천 목록에 포함했어요.");
 return {...previous.explanation,kind:"CONVERSATION",
  text:`${position+1}순위 ${name}을 추천한 이유를 설명해 드릴게요.\n\n${notes.join(" ")}`};
}
