import type {ResearchResult} from "./read-flow.ts";
/** Old receipts remain immutable history; their product facts never become active evidence. */
export function currentDatasetResult(result:ResearchResult,version?:string):ResearchResult{
 if(!version||result.datasetVersion===version)return result;
 return {...result,agentUi:undefined,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
   explanation:{kind:"CONVERSATION",items:[],limitations:[],text:"이전 데이터셋에서 진행한 대화입니다. 상품 정보는 현재 데이터로 다시 검색해 주세요."}};
}
