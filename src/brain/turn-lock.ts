import {createHash} from "node:crypto";

/** Exclusive read-only Brain turn per conversation across workers sharing AI DB.
 * A separate observer pool verifies ownership without querying a dead reserved socket.
 * These checks mitigate stale workers but do NOT fence LangGraph checkpoint writes.
 */
export interface TurnLease {
  assertHeld():Promise<void>;
  release():Promise<void>;
}
export interface TurnLock {
  tryAcquire(conversationId:string):Promise<null|TurnLease>;
}
interface ReservedSession {
  unsafe(query:string,args:unknown[]):Promise<Array<{acquired?:boolean;pid?:number}>>;
  release():Promise<unknown>;
}
interface ReservePool { reserve():Promise<unknown> }
interface ObserverPool { unsafe(query:string,args:(string|number)[]):Promise<unknown> }

function lockKey(conversationId:string):string {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId))
    throw new Error("invalid conversation id for distributed lock");
  const digest=createHash("sha256").update("shopping_brain/turn/v1/").update(conversationId).digest("hex");
  return BigInt.asIntN(64,BigInt("0x"+digest.slice(0,16))).toString();
}
export function postgresTurnLock(pool:ReservePool,observer:ObserverPool):TurnLock{
  return {async tryAcquire(conversationId:string){
    const key=lockKey(conversationId);
    const connection=await pool.reserve() as ReservedSession;
    let acquired=false,released=false,lost=false;
    try{
      const rows=await connection.unsafe(
        "SELECT pg_backend_pid() AS pid, pg_try_advisory_lock($1::bigint) AS acquired",[key]);
      acquired=rows.length===1&&rows[0].acquired===true;
      const originalPid=rows[0]?.pid;
      if(acquired&&!Number.isInteger(originalPid)){
        await connection.release();
        throw new Error("missing original Brain lock session identity");
      }
      if(!acquired){await connection.release();return null;}
      const verifyHeld=async()=>{
        if(lost)throw new Error("Brain turn lock session lost");
        try {
          // This runs on a DIFFERENT pool. Querying the dead reserved
          // postgres.js socket after pg_terminate_backend can crash a worker.
          const rows=await observer.unsafe(`
            SELECT EXISTS(SELECT 1 FROM pg_locks
              WHERE locktype='advisory' AND pid=$1::int
                AND classid=(($2::bigint >> 32) & 4294967295)::oid
                AND objid=($2::bigint & 4294967295)::oid
                AND objsubid=1 AND granted) AS held`,[originalPid as number,key]) as Array<{held?:boolean}>;
          if(rows.length!==1||rows[0].held!==true)
            throw new Error("Brain turn lock session lost");
        }catch(e){lost=true;throw e;}
      };
      return {
        async assertHeld(){
          if(released)throw new Error("Brain turn lock already released");
          await verifyHeld();
        },
        async release(){
          if(released)return;
          released=true;
          try{
            // A dead owner must never query the terminated reserved session.
            await verifyHeld();
            const rows=await connection.unsafe(
              "SELECT pg_advisory_unlock($1::bigint) AS acquired",[key]);
            if(rows.length!==1||rows[0].acquired!==true)
              throw new Error("Brain turn lock was not held at release");
          }finally{await connection.release();}
        }
      };
    }catch(e){
      if(!acquired)await connection.release().catch(()=>{});
      throw e;
    }
  }};
}
