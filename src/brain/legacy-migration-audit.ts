import type {BrainSqlRunner} from "./persistent-store.ts";

/**
 * Read-only migration readiness report. Never copy, delete, or deserialize
 * checkpoint bodies. Results are counts, not private conversation IDs.
 */
export async function auditLegacyBrainConversations(db:BrainSqlRunner,actorUserId:string){
 if(typeof actorUserId!=="string"||!actorUserId.trim()||actorUserId.length>256)
  throw Error("invalid authenticated actor");
 const rows=await db.query<{
  total:number;legacy:number;v9Canonical:number;pendingOnly:number;
  inconsistent:number;empty:number
 }>(`
 WITH owned AS (
   SELECT c.id,c.actor_user_id FROM shopping_brain.conversations c
   WHERE c.actor_user_id=$1
 ), flags AS (
   SELECT o.id,
     EXISTS(SELECT 1 FROM shopping_brain.checkpoints cp
       WHERE cp.thread_id=o.id::text) AS has_legacy,
     f.published_action_id,
     f.conversation_id IS NOT NULL AS has_fence,
     EXISTS(SELECT 1 FROM shopping_brain.turn_receipts r
       WHERE r.conversation_id=o.id AND r.client_action_id=f.published_action_id
         AND r.status='COMPLETED' AND r.checkpoint_thread_id IS NOT NULL
         AND r.completed_result IS NOT NULL) AS has_published
   FROM owned o LEFT JOIN shopping_brain.turn_fence f ON f.conversation_id=o.id
 ), classified AS (
   SELECT CASE
     WHEN published_action_id IS NOT NULL AND NOT has_published THEN 'INCONSISTENT'
     WHEN has_legacy AND NOT has_published THEN 'LEGACY'
     WHEN has_published THEN 'V9_CANONICAL'
     WHEN has_fence THEN 'PENDING_ONLY'
     ELSE 'EMPTY'
   END AS status FROM flags
 )
 SELECT count(*)::int AS total,
 count(*) FILTER(WHERE status='LEGACY')::int AS legacy,
 count(*) FILTER(WHERE status='V9_CANONICAL')::int AS "v9Canonical",
 count(*) FILTER(WHERE status='PENDING_ONLY')::int AS "pendingOnly",
 count(*) FILTER(WHERE status='INCONSISTENT')::int AS inconsistent,
 count(*) FILTER(WHERE status='EMPTY')::int AS empty
 FROM classified`,[actorUserId]);
 if(rows.length!==1)throw Error("Brain legacy migration audit unavailable");
 return {...rows[0],safeToAutoMigrate:false as const};
}
