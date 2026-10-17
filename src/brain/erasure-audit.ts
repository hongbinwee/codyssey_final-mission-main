import type {BrainSqlRunner} from "./persistent-store.ts";

/** READ-ONLY privacy inventory: never performs erasure, never reads message text. */
export async function brainErasureFootprint(db:BrainSqlRunner,actorUserId:string){
  if(!actorUserId||actorUserId.length>256)throw Error("invalid authenticated actor");
  const sql=[
    "WITH owned AS (SELECT id FROM shopping_brain.conversations WHERE actor_user_id=$1),",
    "threads AS (SELECT id::text AS thread_id FROM owned UNION",
    " SELECT a.attempt_id::text FROM shopping_brain.turn_attempts a JOIN owned o ON o.id=a.conversation_id",
    " UNION SELECT r.attempt_id::text FROM shopping_brain.turn_receipts r JOIN owned o ON o.id=r.conversation_id)",
    "SELECT",
    " (SELECT count(*)::int FROM owned) AS conversations,",
    " (SELECT count(*)::int FROM shopping_brain.messages m JOIN owned o ON o.id=m.conversation_id) AS messages,",
    " (SELECT count(*)::int FROM shopping_brain.preference_proposals p JOIN owned o ON o.id=p.conversation_id) AS proposals,",
    " (SELECT count(*)::int FROM shopping_brain.user_preferences WHERE actor_user_id=$1) AS preferences,",
    " (SELECT count(*)::int FROM shopping_brain.turn_fence f JOIN owned o ON o.id=f.conversation_id) AS fences,",
    " (SELECT count(*)::int FROM shopping_brain.turn_receipts r JOIN owned o ON o.id=r.conversation_id) AS receipts,",
    " (SELECT count(*)::int FROM shopping_brain.turn_attempts a JOIN owned o ON o.id=a.conversation_id) AS attempts,",
    " (SELECT count(*)::int FROM shopping_brain.checkpoints c JOIN threads t ON t.thread_id=c.thread_id) AS checkpoints,",
    " (SELECT count(*)::int FROM shopping_brain.checkpoint_writes w JOIN threads t ON t.thread_id=w.thread_id) AS checkpoint_writes,",
    " (SELECT count(*)::int FROM shopping_brain.checkpoint_blobs b JOIN threads t ON t.thread_id=b.thread_id) AS checkpoint_blobs"
  ].join(" ");
  const [row]=await db.query<{
    conversations:number;messages:number;proposals:number;preferences:number;
    fences:number;receipts:number;attempts:number;checkpoints:number;checkpoint_writes:number;checkpoint_blobs:number
  }>(sql,[actorUserId]);
  if(!row)throw Error("Brain privacy inventory unavailable");
  return row;
}
