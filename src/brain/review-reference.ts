import {MAX_DISPLAY_PRODUCTS} from "./contracts.ts";
import type {ResearchResult} from "./read-flow.ts";
import type {DisplayedReviewProduct,ReviewAnalysisRequest} from "./review-analysis.ts";

const RANK_RANGE=/(?<!\d)(-?\d{1,2})\s*(?:~|〜|～|–|—|-)\s*(-?\d{1,2})\s*순위(?!\d)|(?<!\d)(-?\d{1,2})\s*부터\s*(-?\d{1,2})\s*순위(?!\d)/;
const NUMERIC_RANK=/(?<!\d)(-?\d{1,2})\s*순위(?!\d)/;
const NUMBERED_PRODUCT=/(?<!\d)(-?\d{1,2})\s*번(?:째)?(?=\s*(?:상품|제품|리뷰|후기|은|는|의|에|단점|아쉬운|불편|촉촉|보습|수분|$))(?!\d)/;
const KOREAN_RANK=/(첫\s*번째|첫째|첫|두\s*번째|둘째|두|세\s*번째|셋째|세)\s*(?:순위|번(?:째)?|상품|제품)/;
const ALL_DISPLAYED=/(?:이\s*중(?:에|에서)?|그\s*중(?:에|에서)?|아까.{0,16}추천|방금.{0,16}추천|추천(?:해\s*준|한).{0,12}(?:세\s*개|3\s*개)|(?:추천한|추천해\s*준)\s*(?:세\s*개|3\s*개))/;
const CURRENT_PRODUCT=/(?:이\s*(?:상품|제품)|그\s*(?:상품|제품)|해당\s*(?:상품|제품)|이거|그거)/;
const MOISTURIZING=/(?:촉촉|보습|수분감|moisturiz|hydration)/i;
const NEGATIVE=/(?:단점|아쉬운\s*점|불편한\s*점|부족|부정적인\s*(?:점|리뷰|후기)|나쁜\s*(?:점|리뷰|후기))/;
const REVIEW_INTENT=/(?:리뷰|후기|평가|의견|촉촉|보습|수분감|긍정|부정|부족|단점|아쉬운\s*점|불편한\s*점|moisturiz|hydration)/i;
const SUMMARY_ONLY=/(?:요약|정리해\s*줘|정리해줘)/;
const COMPARE=/비교|대비|vs|(?:제일|가장|최다|많은\s*순|많이\s*언급|많은\s*상품|순으로\s*(?:찾|정렬))/i;
const NEW_PRODUCT_REC=/(?:새|새로운|다른)\s*(?:[가-힣A-Za-z0-9 ]{0,18})?(?:상품|제품|크림|쉐이크|워시|이어폰|마스크팩)\s*(?:도\s*)?(?:추천|찾아|검색)/;

function rankIndexes(text:string):number[]|undefined{
 const range=text.match(RANK_RANGE);
 if(range){
  const start=Number(range[1]??range[3]),end=Number(range[2]??range[4]);
  const step=start<=end?1:-1;
  return Array.from({length:Math.abs(end-start)+1},(_,index)=>start+step*index);
 }
 const numeric=text.match(NUMERIC_RANK)??text.match(NUMBERED_PRODUCT);
 if(numeric)return [Number(numeric[1])];
 const word=text.match(KOREAN_RANK)?.[1].replace(/\s+/g,"");
 if(word)return [/^(?:첫|첫째|첫번째)$/.test(word)?1:/^(?:두|둘째|두번째)$/.test(word)?2:3];
 return undefined;
}

/** Parse only review analysis that clearly points to a prior displayed recommendation. */
export function parseContextReviewRequest(message:string):ReviewAnalysisRequest|undefined{
 const text=message.normalize("NFKC").replace(/\s+/g," ").trim();
 if(!text||NEW_PRODUCT_REC.test(text))return;
 const displayIndexes=rankIndexes(text);
 const allDisplayed=!displayIndexes&&ALL_DISPLAYED.test(text);
 const useCurrent=!displayIndexes&&!allDisplayed&&CURRENT_PRODUCT.test(text);
 if(!displayIndexes&&!allDisplayed&&!useCurrent)return;
 if(useCurrent&&!MOISTURIZING.test(text))return;
 if(!REVIEW_INTENT.test(text))return;
 if(!MOISTURIZING.test(text)&&!NEGATIVE.test(text))return;
 const compare=COMPARE.test(text)&&Boolean(allDisplayed||displayIndexes&&displayIndexes.length>1);
 if(SUMMARY_ONLY.test(text)&&!compare&&!NEGATIVE.test(text))return;
 const request:ReviewAnalysisRequest={
  ...(displayIndexes?{displayIndexes}:{}),
  ...(allDisplayed?{allDisplayed:true}:{}),
  ...(useCurrent?{useCurrent:true}:{}),
  ...(MOISTURIZING.test(text)?{aspect:"moisturizing"}:{}),
  focus:NEGATIVE.test(text)?"CONS":"ALL",
  compare,
 };
 return request;
}

type PreviousWithDisplayedProducts=ResearchResult & {
 shoppingPlan?:ResearchResult["shoppingPlan"] & {lastDisplayedProducts?:DisplayedReviewProduct[]};
};

function validId(value:unknown):value is string{
 return typeof value==="string"&&value.length>0&&value.length<=160&&value===value.trim()&&!/[\u0000-\u001f]/.test(value);
}
function displayedProduct(value:unknown,displayIndex:number):DisplayedReviewProduct|undefined{
 if(!value||typeof value!=="object")return;
 const row=value as Partial<DisplayedReviewProduct>;
 if(!validId(row.productId)||!Number.isSafeInteger(row.displayIndex)||row.displayIndex!==displayIndex||
  displayIndex<1||displayIndex>MAX_DISPLAY_PRODUCTS)return;
 if(row.variantId!==undefined&&!validId(row.variantId))return;
 if(row.name!==undefined&&(typeof row.name!=="string"||!row.name.trim()||row.name.length>200))return;
 return {productId:row.productId,...(row.variantId?{variantId:row.variantId}:{}),
  ...(row.name?{name:row.name}:{}),displayIndex};
}

/** Resolve ranks only through verified products stored in the immediately prior result. */
export function resolveReviewTargets(request:ReviewAnalysisRequest,previous?:ResearchResult,currentDatasetVersion?:string):
 {products:DisplayedReviewProduct[];needsTarget:boolean}{
 const none={products:[],needsTarget:true};
 if(!previous||currentDatasetVersion!==undefined&&previous.datasetVersion!==currentDatasetVersion)return none;
 if(request.displayIndexes!==undefined&&!Array.isArray(request.displayIndexes))return none;
 const selectors=[request.displayIndexes!==undefined,request.allDisplayed===true,request.useCurrent===true].filter(Boolean);
 if(selectors.length>1)return none;
 const prior=previous as PreviousWithDisplayedProducts;
 const byIndex=new Map<number,DisplayedReviewProduct>();
 const mismatchedIndexes=new Set<number>();
 const displayedRows=prior.shoppingPlan?.lastDisplayedProducts;
 const productRows=Array.isArray(displayedRows)?displayedRows:[];
 for(const row of productRows){
  if(!row||typeof row!=="object")continue;
  const product=displayedProduct(row,row.displayIndex);
  if(product&&!byIndex.has(product.displayIndex))byIndex.set(product.displayIndex,product);
 }
 const explanationItems=previous.explanation?.items;
 const priorItems=Array.isArray(explanationItems)?explanationItems:[];
 const recommendationKind=["VERIFIED_CANDIDATES","REFERENCE_ONLY","LLM_GROUNDED"].includes(previous.explanation?.kind??"");
 if(!productRows.length&&recommendationKind){
  for(const [index,item] of priorItems.entries()){
   if(!item||typeof item!=="object")continue;
   const displayIndex=index+1;
   if(displayIndex>MAX_DISPLAY_PRODUCTS)continue;
   const product=displayedProduct({productId:item.productId,variantId:item.variantId,name:item.name,displayIndex},displayIndex);
   if(product&&!byIndex.has(displayIndex))byIndex.set(displayIndex,product);
  }
 }else if(productRows.length&&recommendationKind){
  for(const [index,item] of priorItems.entries()){
   if(!item||typeof item!=="object")continue;
   const displayIndex=index+1;
   if(displayIndex>MAX_DISPLAY_PRODUCTS)continue;
   const screenProduct=displayedProduct({productId:item.productId,variantId:item.variantId,name:item.name,displayIndex},displayIndex);
   if(!screenProduct)continue;
   const structuredProduct=byIndex.get(displayIndex);
   if(!structuredProduct){byIndex.set(displayIndex,screenProduct);continue;}
   if(structuredProduct.productId!==screenProduct.productId){mismatchedIndexes.add(displayIndex);continue;}
   byIndex.set(displayIndex,{...structuredProduct,
    ...(structuredProduct.variantId===undefined&&screenProduct.variantId?{variantId:screenProduct.variantId}:{}),
    ...(structuredProduct.name===undefined&&screenProduct.name?{name:screenProduct.name}:{})});
  }
 }
 const displayedIds=prior.shoppingPlan?.lastDisplayedProductIds;
 const productIds=Array.isArray(displayedIds)?displayedIds:[];
 for(const [index,productId] of productIds.entries()){
  const displayIndex=index+1;
  if(displayIndex>MAX_DISPLAY_PRODUCTS||byIndex.has(displayIndex))continue;
  const product=displayedProduct({productId,displayIndex},displayIndex);
  if(product)byIndex.set(displayIndex,product);
 }
 const displayed=[...byIndex.values()].sort((a,b)=>a.displayIndex-b.displayIndex);
 const selectedIndexes=request.allDisplayed?displayed.map(product=>product.displayIndex):
  request.displayIndexes??(request.useCurrent&&displayed.length===1?[displayed[0]!.displayIndex]:[]);
 if(selectedIndexes.length>1&&selectedIndexes.some(index=>mismatchedIndexes.has(index)))return none;
 let products:DisplayedReviewProduct[]=[];
 if(request.allDisplayed)products=displayed;
 else if(Array.isArray(request.displayIndexes)&&request.displayIndexes.length){
  const indexes=request.displayIndexes;
  if(indexes.some(index=>!Number.isSafeInteger(index)||index<1||index>MAX_DISPLAY_PRODUCTS))return none;
  if(indexes.some((index,position)=>position>0&&index<=indexes[position-1]!))return none;
  const selected=indexes.map(index=>byIndex.get(index));
  if(selected.some(product=>!product))return none;
  products=selected.filter((product):product is DisplayedReviewProduct=>Boolean(product))
   .sort((a,b)=>a.displayIndex-b.displayIndex);
 }else if(request.useCurrent&&displayed.length===1)products=displayed;
 if(!products.length)return none;
 return {products,needsTarget:false};
}
