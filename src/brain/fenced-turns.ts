import {createHash,randomUUID} from "node:crypto";
import type {BrainSqlDatabase} from "./persistent-store.ts";
import type {ResearchResult} from "./read-flow.ts";
import {sanitizePageContext,type SafePageContext} from './page-context.ts';

/**
 * AI-only canonical publication. Every attempt uses a fresh, private LangGraph
 * checkpoint thread. The unfenced upstream Saver may write stale attempt data,
 * but it can NEVER publish that data as the conversation's canonical result.
 */
type Action={actorUserId:string;conversationId:string;clientActionId:string;userMessage:string;pageContext?:SafePageContext};
type FenceRow={generation:string|number;published_action_id:string|null};
type ReceiptRow={input_digest:string;status:string;completed_result:unknown;checkpoint_thread_id:string|null};
type LatestRow={completed_result:unknown;checkpoint_thread_id:string};
export type FencedClaim=
  |{kind:"replay";result:ResearchResult}
  |{kind:"run";generation:string;attemptId:string;prior:ResearchResult|null};

const digest=(action:Action)=>{
 const page=sanitizePageContext(action.pageContext);
 // Keep legacy fingerprints unchanged for requests without navigation context.
 return createHash("sha256").update(JSON.stringify([
  action.actorUserId,action.conversationId,action.clientActionId,action.userMessage,
  ...(page?[[page.screen??null,page.product_id??null,page.order_id??null]]:[])
 ])).digest("hex");
};

function checkedResult(raw:unknown,conversationId:string):ResearchResult {
  const r=(typeof raw==="string"?JSON.parse(raw):raw) as ResearchResult;
  if(!r||typeof r!=="object"||r.conversationId!==conversationId||
    typeof r.messageId!=="string"||!r.explanation||(!r.shoppingPlan&&r.explanation.kind!=="CONVERSATION"&&r.explanation.kind!=="REVIEW_SUMMARY"&&r.explanation.kind!=="REVIEW_ANALYSIS"))
    throw new Error("invalid canonical Brain receipt");
  return r;
}
export class FencedTurns {
  private readonly db:BrainSqlDatabase;
  constructor(db:BrainSqlDatabase){this.db=db;}
  async claim(action:Action):Promise<FencedClaim>{
    const fingerprint=digest(action);
    return this.db.transaction(async tx=>{
      // Ownership must still hold at the mutation boundary, not only at
      // Graph entry. Row lock serializes with an eventual close/erasure.
      const owner=await tx.query<{id:string}>(
        "SELECT id FROM shopping_brain.conversations WHERE id=$1 AND actor_user_id=$2 AND closed_at IS NULL FOR SHARE",
        [action.conversationId,action.actorUserId]);
      if(owner.length!==1)throw Error("conversation is not owned or closed");
      await tx.query("INSERT INTO shopping_brain.turn_fence(conversation_id) VALUES($1) ON CONFLICT DO NOTHING",
        [action.conversationId]);
      const [fence]=await tx.query<FenceRow>(
        "SELECT generation,published_action_id FROM shopping_brain.turn_fence WHERE conversation_id=$1 FOR UPDATE",
        [action.conversationId]);
      if(!fence)throw Error("missing Brain fence");
      const receipts=await tx.query<ReceiptRow>(
        "SELECT input_digest,status,completed_result,checkpoint_thread_id FROM shopping_brain.turn_receipts WHERE conversation_id=$1 AND client_action_id=$2",
        [action.conversationId,action.clientActionId]);
      const receipt=receipts[0];
      if(receipt && receipt.input_digest!==fingerprint)throw Error("duplicate action conflict");
      if(receipt?.status==="COMPLETED")
        return {kind:"replay" as const,result:checkedResult(receipt.completed_result,action.conversationId)};
      let prior:ResearchResult|null=null;
      if(fence.published_action_id){
        const rows=await tx.query<LatestRow>(
          "SELECT completed_result,checkpoint_thread_id FROM shopping_brain.turn_receipts WHERE conversation_id=$1 AND client_action_id=$2 AND status='COMPLETED'",
          [action.conversationId,fence.published_action_id]);
        if(rows.length!==1)throw Error("missing canonical Brain checkpoint");
        prior=checkedResult(rows[0].completed_result,action.conversationId);
      }
      const generation=(BigInt(fence.generation)+1n).toString();
      const attemptId=randomUUID();
      await tx.query(
        "UPDATE shopping_brain.turn_fence SET generation=$2::bigint,active_attempt_id=$3,updated_at=now() WHERE conversation_id=$1",
        [action.conversationId,generation,attemptId]);
      await tx.query(
        "INSERT INTO shopping_brain.turn_receipts(conversation_id,client_action_id,input_digest,generation,attempt_id,status) VALUES($1,$2,$3,$4::bigint,$5,'PENDING') "+
        "ON CONFLICT(conversation_id,client_action_id) DO UPDATE SET generation=excluded.generation,attempt_id=excluded.attempt_id,status='PENDING',checkpoint_thread_id=NULL,completed_result=NULL,updated_at=now()",
        [action.conversationId,action.clientActionId,fingerprint,generation,attemptId]);
      await tx.query(
        "INSERT INTO shopping_brain.turn_attempts(attempt_id,conversation_id,client_action_id,generation,status) "+
        "VALUES($1,$2,$3,$4::bigint,'PENDING')",
        [attemptId,action.conversationId,action.clientActionId,generation]);
      return {kind:"run" as const,generation,attemptId,prior};
    });
  }
  /** Atomic guarded promotion: stale/failed attempts can never change the public pointer. */
  async publish(action:Action,claim:Extract<FencedClaim,{kind:"run"}>,result:ResearchResult):Promise<void>{
    if(result.conversationId!==action.conversationId||result.clientActionId!==action.clientActionId||
       !result.explanation||(!result.shoppingPlan&&result.explanation.kind!=="CONVERSATION"&&result.explanation.kind!=="REVIEW_SUMMARY"&&result.explanation.kind!=="REVIEW_ANALYSIS"))throw Error("invalid graph result");
    await this.db.transaction(async tx=>{
      const owner=await tx.query<{id:string}>(
        "SELECT id FROM shopping_brain.conversations WHERE id=$1 AND actor_user_id=$2 AND closed_at IS NULL FOR SHARE",
        [action.conversationId,action.actorUserId]);
      if(owner.length!==1)throw Error("conversation is not owned or closed");
      const [row]=await tx.query<{generation:string|number;active_attempt_id:string|null}>(
        "SELECT generation,active_attempt_id FROM shopping_brain.turn_fence WHERE conversation_id=$1 FOR UPDATE",
        [action.conversationId]);
      if(!row||String(row.generation)!==claim.generation||row.active_attempt_id!==claim.attemptId)
        throw Error("stale turn generation");
      const updated=await tx.query<{client_action_id:string}>(
        "UPDATE shopping_brain.turn_receipts SET status='COMPLETED',checkpoint_thread_id=$4,completed_result=$5::jsonb,updated_at=now() "+
        "WHERE conversation_id=$1 AND client_action_id=$2 AND input_digest=$3 AND generation=$6::bigint AND attempt_id=$4 AND status='PENDING' RETURNING client_action_id",
        [action.conversationId,action.clientActionId,digest(action),claim.attemptId,JSON.stringify(result),claim.generation]);
      if(updated.length!==1)throw Error("stale or mismatched Brain receipt");
      const attempts=await tx.query<{attempt_id:string}>(
        "UPDATE shopping_brain.turn_attempts SET status='COMPLETED',completed_at=now() "+
        "WHERE attempt_id=$1 AND conversation_id=$2 AND generation=$3::bigint AND status='PENDING' RETURNING attempt_id",
        [claim.attemptId,action.conversationId,claim.generation]);
      if(attempts.length!==1)throw Error("Brain attempt history integrity conflict");
      await tx.query(
        "UPDATE shopping_brain.turn_fence SET published_action_id=$2,updated_at=now() WHERE conversation_id=$1",
        [action.conversationId,action.clientActionId]);
    });
  }
  async latest(conversationId:string):Promise<{result:ResearchResult;threadId:string}|null>{
    const rows=await this.db.query<LatestRow>(
      "SELECT r.completed_result,r.checkpoint_thread_id FROM shopping_brain.turn_fence f "+
      "JOIN shopping_brain.turn_receipts r ON r.conversation_id=f.conversation_id AND r.client_action_id=f.published_action_id "+
      "WHERE f.conversation_id=$1 AND r.status='COMPLETED'",[conversationId]);
    if(rows.length===0)return null;
    if(rows.length!==1||!rows[0].checkpoint_thread_id)throw Error("invalid canonical Brain pointer");
    return {result:checkedResult(rows[0].completed_result,conversationId),threadId:rows[0].checkpoint_thread_id};
  }
}
