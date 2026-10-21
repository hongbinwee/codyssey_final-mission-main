import type { MemoryRepository, Preference, PreferenceKey, PreferenceValue } from './contracts.ts';
import { assertPreference } from './memory.ts';
import { createHash } from 'node:crypto';

export interface BrainSqlRunner {
  query<T extends Record<string,unknown>>(sql:string,args:unknown[]):Promise<T[]>;
}
export interface BrainSqlDatabase extends BrainSqlRunner {
  transaction<T>(fn:(tx:BrainSqlRunner)=>Promise<T>):Promise<T>;
}
function actor(id:string) { if (!id || id.length>256) throw new Error('invalid authenticated actor'); }
function uid(id:string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('invalid conversation identifier'); }
const CONVERSATION_CREATE_NAMESPACE='toss-shopping-brain/conversation-create/v1';
function conversationIdForAction(actorUserId:string,clientActionId:string):string {
  const canonicalJson=JSON.stringify({namespace:CONVERSATION_CREATE_NAMESPACE,actorUserId,clientActionId});
  const bytes=createHash('sha256').update(canonicalJson,'utf8').digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x80;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function safeConversationTitle(value:unknown):string|null {
  if(typeof value!=="string")return null;
  const normalized=value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g," ").replace(/\s+/g," ").trim();
  if(!normalized)return null;
  const characters=Array.from(normalized);
  return characters.length>80?characters.slice(0,79).join("").trimEnd()+"…":normalized;
}
export class PersistentConversations {
  private readonly db:BrainSqlDatabase;
  constructor(db:BrainSqlDatabase){this.db=db;}
  async create(actorUserId:string,clientActionId?:string):Promise<{id:string;actorUserId:string}> {
    actor(actorUserId);
    if(clientActionId!==undefined&&(typeof clientActionId!=="string"||!clientActionId.trim()||clientActionId.length>128))
      throw new Error('invalid conversation creation action');
    const id=clientActionId===undefined?crypto.randomUUID():conversationIdForAction(actorUserId,clientActionId);
    await this.db.query('INSERT INTO shopping_brain.conversations(id,actor_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,actorUserId]);
    await this.assertOwned(actorUserId,id);
    return {id,actorUserId};
  }
  async list(actorUserId:string):Promise<Array<{id:string;createdAt:string;title:string|null}>> {
    actor(actorUserId);
    const rows=await this.db.query<{id:string;created_at:Date|string;first_user_message:string|null}>(
      `SELECT c.id,c.created_at,
        (SELECT m.content FROM shopping_brain.messages m
         WHERE m.conversation_id=c.id AND m.actor_user_id=c.actor_user_id AND m.role='user'
         ORDER BY m.created_at ASC,m.id ASC LIMIT 1) AS first_user_message
       FROM shopping_brain.conversations c
       WHERE c.actor_user_id=$1 AND c.closed_at IS NULL
       ORDER BY c.created_at DESC,c.id DESC`,[actorUserId]);
    return rows.map(row=>({id:row.id,createdAt:new Date(row.created_at).toISOString(),title:safeConversationTitle(row.first_user_message)}));
  }
  async assertOwned(actorUserId:string,conversationId:string):Promise<void> {
    actor(actorUserId);uid(conversationId);
    const rows=await this.db.query<{id:string}>('SELECT id FROM shopping_brain.conversations WHERE id=$1 AND actor_user_id=$2 AND closed_at IS NULL',[conversationId,actorUserId]);
    if(rows.length!==1)throw new Error('conversation is not owned');
  }
  async appendUserMessage(actorUserId:string,conversationId:string,actionId:string,content:string):Promise<string>{
    actor(actorUserId);uid(conversationId);
    if(!actionId||actionId.length>128||!content.trim()||content.length>12000)throw new Error('invalid message');
    const id=crypto.randomUUID();
    const rows=await this.db.query<{id:string}>(`INSERT INTO shopping_brain.messages(id,conversation_id,actor_user_id,role,content,client_action_id)
      SELECT $1,c.id,$2,'user',$3,$4 FROM shopping_brain.conversations c
      WHERE c.id=$5 AND c.actor_user_id=$2 AND c.closed_at IS NULL
      ON CONFLICT(conversation_id,client_action_id) DO NOTHING RETURNING id`,[id,actorUserId,content,actionId,conversationId]);
    if(rows.length===1)return rows[0].id;
    const old=await this.db.query<{id:string;content:string}>(`SELECT m.id,m.content FROM shopping_brain.messages m
      JOIN shopping_brain.conversations c ON c.id=m.conversation_id
      WHERE m.conversation_id=$1 AND m.actor_user_id=$2 AND c.actor_user_id=$2 AND m.client_action_id=$3`,[conversationId,actorUserId,actionId]);
    if(old.length!==1||old[0].content!==content)throw new Error('duplicate action conflict or ownership');
    return old[0].id;
  }
  /** A pending proposal requires a real user-authored message; not itself a stored preference. */
  async proposePreference(x:{actorUserId:string;conversationId:string;sourceMessageId:string;key:PreferenceKey;value:PreferenceValue}):Promise<string>{
    actor(x.actorUserId);uid(x.conversationId);uid(x.sourceMessageId);assertPreference(x.key,x.value);
    const id=crypto.randomUUID();
    const rows=await this.db.query<{id:string}>(`INSERT INTO shopping_brain.preference_proposals
      (id,actor_user_id,conversation_id,source_message_id,preference_key,preference_value,expires_at)
      SELECT $1,c.actor_user_id,c.id,m.id,$4,$5,now()+interval '10 minutes'
      FROM shopping_brain.conversations c JOIN shopping_brain.messages m
      ON m.conversation_id=c.id AND m.actor_user_id=c.actor_user_id AND m.role='user'
      WHERE c.id=$2 AND c.actor_user_id=$3 AND c.closed_at IS NULL AND m.id=$6 RETURNING id`,
      [id,x.conversationId,x.actorUserId,x.key,x.value,x.sourceMessageId]);
    if(rows.length!==1)throw new Error('source message not verified or not owned');
    return rows[0].id;
  }
  /** Consume proof and persist preference atomically, enforcing actor and expiry. */
  async confirmPreference(actorUserId:string,proposalId:string):Promise<Preference>{
    actor(actorUserId);uid(proposalId);
    return this.db.transaction(async tx=>{
      const rows=await tx.query<{actor_user_id:string;conversation_id:string;source_message_id:string;preference_key:PreferenceKey;preference_value:PreferenceValue}>(
        `SELECT p.actor_user_id,p.conversation_id,p.source_message_id,p.preference_key,p.preference_value
         FROM shopping_brain.preference_proposals p JOIN shopping_brain.conversations c ON c.id=p.conversation_id
         WHERE p.id=$1 AND p.actor_user_id=$2 AND c.actor_user_id=$2 AND c.closed_at IS NULL
         AND p.consumed_at IS NULL AND p.expires_at>now() FOR UPDATE OF p`,[proposalId,actorUserId]);
      if(rows.length!==1)throw new Error('confirmation expired, used or not owned');
      const p=rows[0]; assertPreference(p.preference_key,p.preference_value);
      await tx.query('UPDATE shopping_brain.preference_proposals SET consumed_at=now() WHERE id=$1 AND actor_user_id=$2',[proposalId,actorUserId]);
      const saved=await tx.query<{updated_at:Date|string}>(`INSERT INTO shopping_brain.user_preferences
        (actor_user_id,preference_key,preference_value,source_conversation_id,source_message_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(actor_user_id,preference_key) DO UPDATE SET
        preference_value=excluded.preference_value,source_conversation_id=excluded.source_conversation_id,
        source_message_id=excluded.source_message_id,updated_at=now() RETURNING updated_at`,
        [actorUserId,p.preference_key,p.preference_value,p.conversation_id,p.source_message_id]);
      return {userId:actorUserId,key:p.preference_key,value:p.preference_value,sourceConversationId:p.conversation_id,
        sourceMessageId:p.source_message_id,updatedAt:new Date(saved[0].updated_at).toISOString()};
    });
  }
}
export class PersistentPreferences implements MemoryRepository {
  private readonly db:BrainSqlDatabase;
  constructor(db:BrainSqlDatabase){this.db=db;}
  async list(userId:string):Promise<Preference[]>{
    actor(userId);
    const rows=await this.db.query<{actor_user_id:string;preference_key:PreferenceKey;preference_value:PreferenceValue;source_conversation_id:string;source_message_id:string;updated_at:Date|string}>(
      `SELECT actor_user_id,preference_key,preference_value,source_conversation_id,source_message_id,updated_at
       FROM shopping_brain.user_preferences WHERE actor_user_id=$1 ORDER BY updated_at ASC`,[userId]);
    if(rows.some(r=>r.actor_user_id!==userId))throw new Error('memory tenant mismatch');
    return rows.map(p=>({userId:p.actor_user_id,key:p.preference_key,value:p.preference_value,sourceConversationId:p.source_conversation_id,
      sourceMessageId:p.source_message_id,updatedAt:new Date(p.updated_at).toISOString()}));
  }
  /** No generic memory writes: require a real stored confirmation from the conversation service. */
  async put(_p:Preference):Promise<void>{throw new Error('persistent writes require confirmed proposal');}
  async delete(userId:string,key:PreferenceKey):Promise<boolean>{
    actor(userId);assertPreference(key,key==='price_priority'?'balanced':'normal');
    const rows=await this.db.query<{preference_key:string}>(
      'DELETE FROM shopping_brain.user_preferences WHERE actor_user_id=$1 AND preference_key=$2 RETURNING preference_key',[userId,key]);
    return rows.length===1;
  }
}
