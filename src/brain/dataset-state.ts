import type {ResearchResult} from "./read-flow.ts";
/** Old receipts remain immutable history; their product facts never become active evidence. */
export function currentDatasetResult(result:ResearchResult,version?:string):ResearchResult{
 if(!version||result.datasetVersion===version)return result;
 const shoppingPlan=result.shoppingPlan?{...result.shoppingPlan}:undefined;
 if(shoppingPlan){
  delete shoppingPlan.lastDisplayedProductIds;
  delete shoppingPlan.lastDisplayedProducts;
 }
 return {...result,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
   recentTurns:undefined,pendingReview:undefined,
   ...(shoppingPlan?{shoppingPlan}:{}),
   explanation:{kind:"CONVERSATION",items:[],limitations:[],text:"이전 데이터셋에서 진행한 대화입니다. 상품 정보는 현재 데이터로 다시 검색해 주세요."}};
}
