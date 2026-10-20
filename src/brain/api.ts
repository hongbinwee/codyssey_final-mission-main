import type {PreferenceKey,PreferenceValue,Preference,RankingResult} from "./contracts.ts";
import type {PersistentConversations,PersistentPreferences} from "./persistent-store.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import type {GroundedExplanation} from "./grounded-response.ts";
import type {WishlistView} from "./wishlist-task.ts";
import type {ShoppingHandoff} from "./shopping-handoff.ts";
import type {AgentTaskState} from "./task-state.ts";
import {BrainModelOutputError} from "./intent.ts";
import type {BrainIntentKind} from "./routing.ts";
import {executionMode} from "./execution-mode.ts";

export interface BrainGraphPort {
  invoke(input:{actorUserId:string;conversationId:string;requestId:string;clientActionId:string;userMessage:string}):Promise<{
    conversationId:string;messageId:string;ranking:RankingResult;trace:Record<string,number>;
    shoppingPlan?:ShoppingPlan;agentUi?:WishlistView;shoppingHandoffs?:ShoppingHandoff[];taskState?:AgentTaskState;explanation?:GroundedExplanation;intentKind?:BrainIntentKind;datasetVersion?:string;
  }>;
  getOwnedState(actorUserId:string,conversationId:string):Promise<{values?:Record<string,unknown>}>;
}
export interface BrainApiDeps {
  recentHistory?:(actorUserId:string)=>Promise<unknown>;
  listConversations?:(actorUserId:string)=>Promise<Array<{id:string;createdAt:string;title:string|null}>>;
  conversationHistory?:(actorUserId:string,conversationId:string)=>Promise<{conversationId:string|null;entries:unknown[]}>;
  conversations:Pick<PersistentConversations,"create"|"assertOwned"|"proposePreference"|"confirmPreference">;
  preferences:Pick<PersistentPreferences,"list"|"delete">;
  graph:BrainGraphPort;
}
export type BrainApiResponse={status:number;body:{ok:true;data:unknown}|{ok:false;error:{code:string;message:string}}};
const success=(data:unknown,status=200):BrainApiResponse=>({status,body:{ok:true,data}});
const fail=(status:number,code:string,message:string):BrainApiResponse=>({status,body:{ok:false,error:{code,message}}});
const keys=new Set(["price_priority","eye_comfort","noise_sensitivity"]);
const uuid=(s:unknown):s is string=>typeof s==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const rec=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const required=(x:unknown,max=3000):x is string=>typeof x==="string"&&x.trim().length>0&&x.length<=max;
export const brainPath=(p:string):boolean=>p==="/api/brain"||p.startsWith("/api/brain/");
/**
 * This controller never accepts actorUserId from a request body: the HTTP server
 * must pass an already verified session actor. No global Commerce mutations.
 */
export function createBrainApi(deps:BrainApiDeps) {
  return async function handle(method:string,path:string,actorUserId:string,rawBody:unknown):Promise<BrainApiResponse> {
    if(!required(actorUserId,256))return fail(401,"UNAUTHENTICATED","로그인이 필요합니다");
    const body=rec(rawBody);
    try {
      if(method==="GET"&&path==="/api/brain/status")return success({enabled:true,read_only:true,mode:"grounded_research"});
      if(method==="GET"&&path==="/api/brain/history")
        return success(deps.recentHistory?await deps.recentHistory(actorUserId):{conversationId:null,entries:[]});
      if(method==="GET"&&path==="/api/brain/conversations"){
        if(!deps.listConversations)return fail(503,"BRAIN_UNAVAILABLE","대화 목록을 불러오지 못했습니다");
        return success({conversations:await deps.listConversations(actorUserId)});
      }
      if(method==="POST"&&path==="/api/brain/conversations"){
        if(rawBody===null||typeof rawBody!=="object"||Array.isArray(rawBody))
          return fail(400,"VALIDATION","지원하지 않는 요청 형식");
        const hasActionId=Object.prototype.hasOwnProperty.call(body,"client_action_id");
        if(Object.keys(body).some(key=>key!=="client_action_id")||
           (hasActionId&&!required(body.client_action_id,128)))
          return fail(400,"VALIDATION","지원하지 않는 요청 형식");
        const actionId=hasActionId?body.client_action_id as string:undefined;
        return success(await deps.conversations.create(actorUserId,actionId),201);
      }
      const history=path.match(/^\/api\/brain\/conversations\/([a-fA-F0-9-]+)\/history$/);
      if(method==="GET"&&history){
        if(!uuid(history[1]))return fail(400,"VALIDATION","대화 ID를 확인해 주세요");
        if(!deps.conversationHistory)return fail(503,"BRAIN_UNAVAILABLE","대화 기록을 불러오지 못했습니다");
        await deps.conversations.assertOwned(actorUserId,history[1]);
        const result=await deps.conversationHistory(actorUserId,history[1]);
        if(result.conversationId!==history[1])throw new Error("invalid conversation history");
        return success(result);
      }
      if(method==="GET"&&path==="/api/brain/preferences") {
        const records=await deps.preferences.list(actorUserId);
        return success(records.map(({key,value,updatedAt,sourceConversationId}:Preference)=>({key,value,updatedAt,sourceConversationId})));
      }
      const m=path.match(/^\/api\/brain\/preferences\/(price_priority|eye_comfort|noise_sensitivity)$/);
      if(method==="DELETE"&&m) return success({deleted:await deps.preferences.delete(actorUserId,m[1] as PreferenceKey)});
      if(method==="POST"&&path==="/api/brain/preferences/proposals"){
        const {conversation_id,source_message_id,key,value}=body;
        if(!uuid(conversation_id)||!uuid(source_message_id)||!keys.has(String(key))||!required(value,40))
          return fail(400,"VALIDATION","기억 출처·대화·항목을 확인해 주세요");
        return success({proposal_id:await deps.conversations.proposePreference({
          actorUserId,conversationId:conversation_id,sourceMessageId:source_message_id,
          key:key as PreferenceKey,value:value as PreferenceValue
        })},201);
      }
      if(method==="POST"&&path==="/api/brain/preferences/confirm"){
        const {proposal_id}=body;
        if(!uuid(proposal_id))return fail(400,"VALIDATION","확인 대상을 확인해 주세요");
        const p=await deps.conversations.confirmPreference(actorUserId,proposal_id);
        return success({key:p.key,value:p.value,updatedAt:p.updatedAt});
      }
      const turn=path.match(/^\/api\/brain\/conversations\/([a-fA-F0-9-]+)\/turn$/);
      if(method==="POST"&&turn){
        if(!uuid(turn[1])||!required(body.user_message)||!required(body.client_action_id,128))
          return fail(400,"VALIDATION","대화·질문·작업 ID가 필요합니다");
        if(executionMode(body.execution_mode)==="DEEP")return fail(501,"DEEP_NOT_AVAILABLE","꼼꼼한 비교 모드는 아직 준비 중입니다. 현재 상품 검색과 리뷰 비교를 이용해 주세요.");
        const started=performance.now();
        const result=await deps.graph.invoke({actorUserId,conversationId:turn[1],
          requestId:crypto.randomUUID(),clientActionId:body.client_action_id,userMessage:body.user_message});
        const graphWallMs=performance.now()-started;
        return success({conversation_id:result.conversationId,message_id:result.messageId,
          ranking:result.ranking,trace:{...result.trace,graphWallMs},read_only:true,intent_kind:result.intentKind,
          shopping_plan:result.shoppingPlan??null,agent_ui:result.agentUi??null,
          shopping_handoffs:result.shoppingHandoffs??[],review_summary:result.reviewSummary??null,explanation:result.explanation??null});
      }
      const state=path.match(/^\/api\/brain\/conversations\/([a-fA-F0-9-]+)\/state$/);
      if(method==="GET"&&state){
        if(!uuid(state[1]))return fail(400,"VALIDATION","대화 ID를 확인해 주세요");
        const snapshot=await deps.graph.getOwnedState(actorUserId,state[1]);
        const last=snapshot.values?.researchResult as {messageId?:unknown;ranking?:unknown}|undefined;
        // Never expose raw checkpoint state (which could include internal user context).
        return success({conversation_id:state[1],last_message_id:typeof last?.messageId==="string"?last.messageId:null,
          has_ranking:!!last?.ranking});
      }
      return fail(404,"NOT_FOUND","해당 Brain 기능을 찾지 못했습니다");
    }catch(e){
      // No caller-supplied IDs or DB details in errors; owner mismatch is non-disclosing.
      if(e instanceof Error&&/not owned|not verified or not owned|not owned/.test(e.message))
        return fail(404,"NOT_FOUND","대화를 찾을 수 없습니다");
      if(e instanceof Error&&/confirmation expired|already used| or not owned/.test(e.message))
        return fail(409,"CONFIRMATION_REQUIRED","선호 확인이 만료되었거나 완료되었습니다");
      if(e instanceof BrainModelOutputError)
        return fail(502,"MODEL_OUTPUT_INVALID","AI 응답을 해석할 수 없습니다. 다시 시도해 주세요");
      if(e instanceof Error&&e.message==="LLM http 429")
        return fail(429,"MODEL_RATE_LIMIT","AI 모델 요청이 일시적으로 제한됐습니다. 잠시 후 다시 시도해 주세요");
      if(e instanceof Error&&(e.message==="LLM timeout"||e.name==="TimeoutError"))
        return fail(504,"MODEL_TIMEOUT","AI 모델의 응답 시간이 초과됐습니다. 다시 시도해 주세요");
      if(e instanceof Error&&e.message==="conversation busy")
        return fail(409,"CONVERSATION_BUSY","이전 질문을 처리 중입니다. 완료 후 다시 시도해 주세요");
      if(e instanceof Error&&/invalid|duplicate action conflict|source message not verified/i.test(e.message))
        return fail(400,"VALIDATION","유효하지 않은 요청입니다");
      return fail(503,"BRAIN_UNAVAILABLE","Brain 요청을 처리하지 못했습니다");
    }
  };
}
