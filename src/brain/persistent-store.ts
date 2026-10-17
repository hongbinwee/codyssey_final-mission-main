import type { MemoryRepository, Preference, PreferenceKey, PreferenceValue } from './contracts.ts';
import { assertPreference } from './memory.ts';

export interface BrainSqlRunner {
  query<T extends Record<string,unknown>>(sql:string,args:unknown[]):Promise<T[]>;
}
export interface BrainSqlDatabase extends BrainSqlRunner {
  transaction<T>(fn:(tx:BrainSqlRunner)=>Promise<T>):Promise<T>;
}
function actor(id:string) { if (!id || id.length>256) throw new Error('invalid authenticated actor'); }
function uid(id:string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('invalid conversation identifier'); }
export class PersistentConversations {
  private readonly db:BrainSqlDatabase;
  constructor(db:BrainSqlDatabase){this.db=db;}
  async create(actorUserId:string):Promise<{id:string;actorUserId:string}> {
    actor(actorUserId); const id=crypto.randomUUID();
    await this.db.query('INSERT INTO shopping_brain.conversations(id,actor_user_id) VALUES($1,$2)',[id,actorUserId]);
    return {id,actorUserId};
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
