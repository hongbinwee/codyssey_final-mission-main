import type {ResearchResult} from "./read-flow.ts";
import type {ReviewSummaryRequest} from "./contracts.ts";
import {parseReviewSummaryRequest,routeBrainMessage} from "./routing.ts";

type DisplayedProduct={productId:string;variantId?:string;name:string;displayIndex:number};
type PriorWithPending=ResearchResult & {pendingReview?:ReviewSummaryRequest};

const NEGATIVE_FOCUS=/(?:단점|아쉬운\s*점|불편한\s*점|부정적인\s*점)/;
const REVIEW_INTENT=/(?:리뷰|후기|분석|요약|정리|단점|아쉬운\s*점|불편한\s*점)/;
const NEW_SEARCH=/(?:다른|새로운?|새)\s*(?:상품|제품|[가-힣A-Za-z0-9 ]{1,20})?\s*(?:추천|찾아|검색)|(?:추천|찾아|검색)\s*해\s*줘/;
const NUMBERED=/(?<![\p{L}\p{N}])(?:([1-9]\d?)\s*번(?:째)?|첫\s*번째|첫째|두\s*번째|둘째|세\s*번째|셋째)(?![\p{L}\p{N}])/u;
const POLITE_TAIL=/\s*(?:이라고|라(?:고)?|이라(?:고)?|라고\s*얘기했는데|이라고\s*얘기했는데|이라고\s*했는데|라고\s*했는데)\s*$/;
function validId(value:unknown):value is string{
 return typeof value==="string"&&value.length>0&&value.length<=160&&value===value.trim()&&!/[\u0000-\u001f]/.test(value);
}
function normalize(value:string):string{
 return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"");
}
function cleanName(value:string):string{
 return value.trim().replace(/[?？!！.。]+$/,"").trim().replace(POLITE_TAIL,"")
  .replace(/\s*(?:리뷰|후기|분석|요약|정리)(?:\s*(?:해\s*줘|해주세요|해줘))?\s*$/,"").trim();
}
function nameMatches(query:string,name:string):boolean{
 const normalizedQuery=normalize(query),normalizedName=normalize(name);
 if(normalizedQuery===normalizedName)return true;
 const terms=query.split(/\s+/).map(normalize).filter(term=>term.length>=2);
 if(terms.length<2||terms.some(term=>!normalizedName.includes(term)))return false;
 let cursor=0;
 for(const term of terms){
  const found=normalizedName.indexOf(term,cursor);
  if(found<0)return false;
  cursor=found+term.length;
 }
 return true;
}
function displayedProducts(previous:ResearchResult):DisplayedProduct[]{
 const plan=previous.shoppingPlan as (ResearchResult["shoppingPlan"] & {lastDisplayedProducts?:unknown[]})|undefined;
 const structured=Array.isArray(plan?.lastDisplayedProducts)?plan.lastDisplayedProducts:[];
 const fromExplanation=previous.explanation?.items??[];
 const rows=structured.length?structured:fromExplanation.map((row,index)=>({
  productId:row.productId,variantId:row.variantId,name:row.name,displayIndex:index+1,
 }));
 const products:DisplayedProduct[]=[];
 for(const row of rows){
  if(!row||typeof row!=="object")continue;
  const item=row as Partial<DisplayedProduct>;
  const displayIndex=item.displayIndex;
  if(!validId(item.productId)||typeof item.name!=="string"||!item.name.trim()||
     typeof displayIndex!=="number"||!Number.isSafeInteger(displayIndex)||displayIndex<1||displayIndex>3||
     item.variantId!==undefined&&!validId(item.variantId))continue;
  if(products.some(product=>product.productId===item.productId||product.displayIndex===displayIndex))continue;
  const matchingItem=fromExplanation.find(candidate=>candidate.productId===item.productId);
  if(matchingItem&&item.variantId&&matchingItem.variantId&&item.variantId!==matchingItem.variantId)continue;
  products.push({productId:item.productId,...(item.variantId?{variantId:item.variantId}:{}),
   name:item.name.trim(),displayIndex});
 }
 return products;
}
function focusOf(text:string,pending:ReviewSummaryRequest|undefined):"ALL"|"CONS"{
 return NEGATIVE_FOCUS.test(text)?"CONS":pending?.focus==="CONS"?"CONS":"ALL";
}
/** Resolve an explicit review follow-up only against the immediately prior verified display. */
export function resolveReviewFollowup(
 message:string,
 previous:ResearchResult|undefined,
 currentDatasetVersion?:string,
):ReviewSummaryRequest|undefined{
 const text=message.normalize("NFKC").replace(/\s+/g," ").trim();
 if(!text||NEW_SEARCH.test(text))return;
 const prior=previous as PriorWithPending|undefined;
 if(!prior||currentDatasetVersion!==undefined&&prior.datasetVersion!==currentDatasetVersion)return;
 if(routeBrainMessage(text,prior.shoppingPlan).kind==="REVIEW_COMPARE")return;
 const pending=prior.pendingReview;
 const parsed=parseReviewSummaryRequest(text);
 if(parsed&&(parsed.productId||parsed.useCurrent||!parsed.query&&!parsed.displayIndex))return;
 const explicitReview=REVIEW_INTENT.test(text)&&
  (/(?:이거|그거|이\s*(?:상품|제품)|그\s*(?:상품|제품)|해당\s*(?:상품|제품))/.test(text)||NUMBERED.test(text)||/(?:리뷰|후기)/.test(text));
 if(!explicitReview&&!pending)return;
 const products=displayedProducts(prior);
 if(!products.length)return;
 const focus=focusOf(text,pending);
 const number=text.match(NUMBERED);
 const index=number?(/^(?:첫|첫째|첫\s*번째)$/.test(number[0].replace(/\s+/g,""))?1:
  /^(?:두|둘째|두\s*번째)$/.test(number[0].replace(/\s+/g,""))?2:
  /^(?:세|셋째|세\s*번째)$/.test(number[0].replace(/\s+/g,""))?3:Number(number[1])):undefined;
 let name=cleanName(text.replace(/(?:이거|그거|(?:이|그|해당)\s*(?:상품|제품))/g," ")
  .replace(/\d+\s*번(?:째)?/g," ").replace(/^(?:첫|첫째|첫\s*번째|두|둘째|두\s*번째|세|셋째|세\s*번째)\s*/," ")
  .replace(/리뷰|후기|분석|요약|정리|해\s*줘|해주세요/g," ").trim());
 const generic=/^(?:(?:이|그|해당)\s*)?(?:상품|제품|거|것|이거|그거)?$/.test(name);
 const namedCandidates=generic?[]:products.filter(product=>{
  const candidate=normalize(product.name),query=normalize(name);
  return query===candidate||nameMatches(name,product.name)||
   query.length>=4&&(candidate.includes(query)||query.includes(candidate));
 });
 if(index!==undefined){
  const indexed=products.find(product=>product.displayIndex===index);
  if(!indexed)return pending?{...pending,focus}:undefined;
  if(namedCandidates.length&&(!namedCandidates.some(product=>product.productId===indexed.productId)||namedCandidates.length!==1))
   return {useCurrent:true,focus};
  return {productId:indexed.productId,...(indexed.variantId?{variantId:indexed.variantId}:{}),focus};
 }
 if(namedCandidates.length===1){
  const match=namedCandidates[0]!;
  return {productId:match.productId,...(match.variantId?{variantId:match.variantId}:{}),focus};
 }
 if(namedCandidates.length>1)return {useCurrent:true,focus};
 if(pending){
  const correction=cleanName(text);
  const correctionMatches=products.filter(product=>nameMatches(correction,product.name));
  if(correctionMatches.length===1){
   const match=correctionMatches[0]!;
   return {productId:match.productId,...(match.variantId?{variantId:match.variantId}:{}),focus};
  }
  if(!generic)return {query:correction,focus};
  return {useCurrent:true,focus};
 }
 return !generic?{query:name,focus}:{useCurrent:true,focus};
}
