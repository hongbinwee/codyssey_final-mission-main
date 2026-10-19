/** Read-only wishlist task planning. All IDs are checked against the current actor-owned list. */
export interface WishlistItem {productId:string;name:string;active:boolean;minPriceWon:number|null}
export interface WishlistView {kind:"WISHLIST";items:WishlistItem[];selectedProductId?:string}
export type WishlistIntent={kind:"LIST"}|{kind:"SELECT";index:number};
export function wishlistIntent(message:string,previous?:WishlistView):WishlistIntent|null{
 const text=message.trim().replace(/[.!?~]+$/,"").trim();
 if(!text||text.length>160||/찜.{0,12}(?:해제|취소|삭제|지워|빼)|(?:해제|취소|삭제).{0,12}찜/.test(text))return null;
 if(previous){
  const selected=/^(?:(?:그중|그 중|찜 목록에서)\s*)?(?:(\d{1,2})\s*(?:번(?:째)?|번째|순위|위)|(첫|두|세)\s*번째)\s*(.*)$/.exec(text);
  if(selected&&/(?:살|사겠|사고|구매|선택|상세|열어|보여|골라|고를|할게)/.test(selected[3])){
   const n=selected[1]?Number(selected[1]):{"첫":1,"두":2,"세":3}[selected[2] as "첫"|"두"|"세"];
   return n>0&&n<=20?{kind:"SELECT",index:n-1}:null;
  }
  if(/^(?:상관없(?:어|어요)?|전체|전부|다\s*보여줘)$/.test(text))return {kind:"LIST"};
 }
 // A comparison/recommendation involving wishlist requires a multi-Tool agent path.
 // Do not hijack it as a plain list request just because the user said "찜".
 if(/비교|리뷰|후기|평점|저렴|싼|비싼|가성비|추천|배송|가장|제일|예산|정렬|단점|장점|순서|대신|비슷/.test(text))return null;
 return /찜|위시리스트|하트\s*(?:눌|찍|표시)|저장해\s*둔\s*상품|저장한\s*상품/.test(text)?{kind:"LIST"}:null;
}
export function wishlistReply(intent:WishlistIntent,owned:WishlistItem[],previous?:WishlistView):{text:string;view:WishlistView}{
 const view:WishlistView={kind:"WISHLIST",items:owned.slice(0,20).map(x=>({...x}))};
 if(intent.kind==="LIST")return {view,text:!owned.length?"아직 찜한 상품이 없어요.":"찜한 상품을 확인했어요. 원하는 상품을 선택하면 상세 화면에서 구매 옵션을 확인할 수 있어요."};
 const prior=previous?.items[intent.index],current=prior&&owned.find(x=>x.productId===prior.productId);
 if(!prior||!current)return {view,text:"선택한 상품이 현재 찜 목록에 없어요. 다시 선택해 주세요."};
 if(!current.active||current.minPriceWon===null)return {view,text:"선택한 상품은 현재 구매 가능한 옵션이 없어요."};
 view.selectedProductId=current.productId;
 return {view,text:`${current.name}을(를) 선택했어요. 상품 상세에서 옵션과 현재 가격을 확인하고 직접 구매를 진행해 주세요.`};
}
