import type {RankingResult} from "./contracts.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";

export type PriceSortOrder=NonNullable<ShoppingPlan["priceSortOrder"]>;
const priceOrderPattern=/(?:가격|배송비 포함 합계|합계|총액)\s*(?:(?:이|가)\s*)?(?:(?:낮은|높은|싼|비싼)\s*순|오름차순|내림차순|순)|(?:낮은|높은|싼|비싼)\s*가격\s*순|(?:저렴한|비싼|싼)\s*순/g;
const cancelled=/^\s*(?:으로|은|는|을|를)?\s*(?:말고|아닌|아니|취소|해제|초기화|없애|하지\s*마)/;
/** Price bounds and value preferences are not explicit ordering requests. */
export function requestedPriceSort(message:string):PriceSortOrder|undefined{
 const text=message.trim().replace(/\s+/g," ");
 const matches=[...text.matchAll(priceOrderPattern)].map(m=>({text:m[0],index:m.index}));
 // A contrast can elide the price noun: "가격 낮은 순 말고 높은 순".
 if(matches.length&&/(?:가격|합계|총액)/.test(text)){
  const tail=/(?:말고|대신)\s*((?:낮은|높은)\s*순)/g;
  for(const m of text.matchAll(tail))matches.push({text:m[1],index:m.index+m[0].indexOf(m[1])});
 }
 matches.sort((a,b)=>a.index-b.index);
 let order:PriceSortOrder|undefined;
 for(const m of matches){
  if(cancelled.test(text.slice(m.index+m.text.length)))continue;
  order=/높은|비싼|내림차순/.test(m.text)?"DESC":"ASC";
 }
 return order;
}
/** A sort-only follow-up must not let model extraction replace the product task. */
export function isPriceSortOnly(message:string):boolean{
 if(!requestedPriceSort(message))return false;
 const rest=message.trim().replace(/\s+/g," ").replace(priceOrderPattern,"")
  .replace(/(?:이번엔|이번에는|이제는|이제|그럼|으로|말고|대신|(?:추천|정렬)(?:해)?\s*(?:줘|주세요)|보여\s*(?:줘|주세요)|해\s*(?:줘|주세요)|정렬|추천|다시|같은 조건|상품을|상품|제품을|제품)/g,"");
 return /^[\s.!?]*$/.test(rest);
}
export function isPriceSortCancelled(message:string):boolean{
 const text=message.trim().replace(/\s+/g," ");
 return [...text.matchAll(priceOrderPattern)].some(m=>cancelled.test(text.slice(m.index+m[0].length)));
}
/** Only validated totals from candidates already passing the normal hard gates. */
export function verifiedPriceTotal(candidate:RankingResult["ranked"][number]["candidate"]):number|null{
 const price=candidate.unitPriceWon,shipping=candidate.shippingFeeWon;
 return candidate.commerceVerified===true&&Number.isSafeInteger(price)&&price!>=0&&
  Number.isSafeInteger(shipping)&&shipping!>=0&&Number.isSafeInteger(price!+shipping!)?price!+shipping!:null;
}
export function sortByVerifiedTotal(ranking:RankingResult,order:PriceSortOrder):RankingResult{
 const verified=ranking.ranked.filter(row=>verifiedPriceTotal(row.candidate)!==null);
 const invalid=ranking.ranked.filter(row=>verifiedPriceTotal(row.candidate)===null);
 verified.sort((a,b)=>(order==="ASC"?1:-1)*(verifiedPriceTotal(a.candidate)!-verifiedPriceTotal(b.candidate)!));
 const seen=new Set<string>();
 return {...ranking,ranked:verified.filter(row=>{
  if(seen.has(row.candidate.productId))return false;
  seen.add(row.candidate.productId);return true;
 }),rejected:[...ranking.rejected,...invalid.map(row=>({candidate:row.candidate,reasons:["price_sort_total_unverified"]}))]};
}
