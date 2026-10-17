import type {BrainSqlRunner} from "./persistent-store.ts";

/** Read-only retention dry-run. Never deletes blobs, writes, messages or receipts. */
export async function auditCheckpointRetention(
 db:BrainSqlRunner,actorUserId:string,minimumAgeDays=30
){
 if(!actorUserId||actorUserId.length>256)throw Error("invalid actor");
 if(!Number.isInteger(minimumAgeDays)||minimumAgeDays<7||minimumAgeDays>3650)
   throw Error("invalid checkpoint retention age");
 const [counts]=await db.query<{
   allAttempts:number;pendingAttempts:number;completedAttempts:number;
   supersededPending:number;retentionReviewCandidates:number
 }>(`
  SELECT count(*)::int AS "allAttempts",
    count(*) FILTER(WHERE a.status='PENDING')::int AS "pendingAttempts",
    count(*) FILTER(WHERE a.status='COMPLETED')::int AS "completedAttempts",
    count(*) FILTER(WHERE a.status='PENDING' AND a.generation<f.generation)::int AS "supersededPending",
    count(*) FILTER(WHERE a.status='PENDING' AND a.generation<f.generation
      AND a.created_at < now()-($2::int * interval '1 day')
      AND a.attempt_id IS DISTINCT FROM f.active_attempt_id
      AND NOT EXISTS(SELECT 1 FROM shopping_brain.turn_receipts r
        WHERE r.conversation_id=a.conversation_id
          AND r.checkpoint_thread_id=a.attempt_id AND r.status='COMPLETED')
    )::int AS "retentionReviewCandidates"
  FROM shopping_brain.turn_attempts a
  JOIN shopping_brain.conversations c ON c.id=a.conversation_id
  JOIN shopping_brain.turn_fence f ON f.conversation_id=a.conversation_id
  WHERE c.actor_user_id=$1`,[actorUserId,minimumAgeDays]);
 if(!counts)throw Error("Brain retention audit unavailable");
 return {...counts,minimumAgeDays,mode:"READ_ONLY_DRY_RUN" as const,
   deletionApproved:false as const,
   legacyPreIndexThreadsFullyReconciled:false as const};
}
