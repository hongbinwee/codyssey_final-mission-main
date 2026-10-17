import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";

function deadline(promise,label,ms=12000){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" exceeded "+ms+"ms")),ms);
  });
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

// Safety characterization, NOT an exactly-once guarantee. Uses CI-only brain_ci.
test("killing an advisory-lock backend releases exclusivity while its old worker may still be alive", async () => {
  const url=process.env.BRAIN_DATABASE_URL;
  if(!url || new URL(url).pathname!=="/brain_ci")
    throw new Error("disposable brain_ci required");
  const first=postgres(url,{max:2,connect_timeout:5});
  const second=postgres(url,{max:2,connect_timeout:5});
  let reserved;
  const pool={
    async reserve(){
      reserved=await first.reserve();
      return reserved;
    }
  };
  const conversationId=crypto.randomUUID();
  let releaseOld;
  try{
    releaseOld=await postgresTurnLock(pool,second).tryAcquire(conversationId);
    assert.equal(typeof releaseOld?.release,"function");
    await releaseOld.assertHeld();
    const [{pid}]=await reserved.unsafe("SELECT pg_backend_pid() AS pid");
    assert.equal(await postgresTurnLock(second,first).tryAcquire(conversationId),null,
      "healthy held session must exclude a second worker");

    const killed=await second.unsafe(
      "SELECT pg_terminate_backend($1::int) AS terminated",[pid]);
    assert.equal(killed[0].terminated,true);

    // A new session can now enter, although application code in the old
    // worker may still be executing an async provider/RAG operation.
    const releaseNew=await postgresTurnLock(second,first).tryAcquire(conversationId);
    assert.equal(typeof releaseNew?.release,"function",
      "session loss invalidates exclusion; this is an operational blocker");
    try{
      await releaseNew.assertHeld();
      await assert.rejects(()=>releaseOld.assertHeld(),
        "stale owner must not claim that its old lock is held");
      await assert.rejects(()=>releaseOld.release(),
        "stale lock owner must not report a clean unlock");
    }finally{
      await releaseNew.release();
      releaseOld=undefined;
    }
  }finally{
    if(releaseOld)await releaseOld.release().catch(()=>{});
    await Promise.allSettled([first.end({timeout:1}),second.end({timeout:1})]);
  }
});

test("a stale graph worker cannot commit a delayed RAG result after its lock session is killed", async () => {
  const url=process.env.BRAIN_DATABASE_URL;
  if(!url || new URL(url).pathname!=="/brain_ci")
    throw new Error("disposable brain_ci required");
  const [{PostgresSaver},{brainDatabaseFromPostgres},{PersistentConversations,PersistentPreferences},
    {createPersistentResearchGraph}]=await Promise.all([
      import("@langchain/langgraph-checkpoint-postgres"),
      import("../../src/brain/pg-adapter.ts"),
      import("../../src/brain/persistent-store.ts"),
      import("../../src/brain/graph.ts")
    ]);
  const sqlA=postgres(url,{max:3,connect_timeout:5});
  const sqlB=postgres(url,{max:3,connect_timeout:5});
  const saverA=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  const saverB=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  let reserved,unblock,started;
  const parked=new Promise(resolve=>{unblock=resolve;});
  const hasStarted=new Promise(resolve=>{started=resolve;});
  try{
    const conversationsA=new PersistentConversations(brainDatabaseFromPostgres(sqlA));
    const conversationsB=new PersistentConversations(brainDatabaseFromPostgres(sqlB));
    const memoryA=new PersistentPreferences(brainDatabaseFromPostgres(sqlA));
    const memoryB=new PersistentPreferences(brainDatabaseFromPostgres(sqlB));
    const thread=await conversationsA.create("stale-graph-worker");
    const intent={extract:async()=>({query:"monitor",
      context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})};
    const graphA=createPersistentResearchGraph({
      conversations:conversationsA,memory:memoryA,intent,
      retriever:{search:async()=>{started();await parked;return {candidates:[],evidence:[]};}}
    },saverA,postgresTurnLock({reserve:async()=>{
      reserved=await sqlA.reserve();return reserved;
    }},sqlB));
    const graphB=createPersistentResearchGraph({
      conversations:conversationsB,memory:memoryB,intent,
      retriever:{search:async()=>({candidates:[],evidence:[]})}
    },saverB,postgresTurnLock(sqlB,sqlA));
    await saverA.setup();await saverB.setup();
    const input={actorUserId:"stale-graph-worker",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:"stale-action",userMessage:"이전 요청"};
    const old=graphA.invoke(input);
    old.catch(()=>{}); // Observe rejection after intentional session termination.
    await deadline(hasStarted,"stale Graph did not reach retrieval");
    const [{pid}]=await reserved.unsafe("SELECT pg_backend_pid() AS pid");
    const [terminated]=await sqlB.unsafe("SELECT pg_terminate_backend($1::int) AS terminated",[pid]);
    assert.equal(terminated.terminated,true);
    const current=await deadline(graphB.invoke({...input,
      requestId:crypto.randomUUID(),clientActionId:"newer-action",userMessage:"새 요청"}),
      "replacement Graph could not complete");
    assert.equal(current.clientActionId,"newer-action");
    unblock();
    await assert.rejects(old,"a worker with a dead lock session must reject");
    const latest=await graphB.getOwnedState("stale-graph-worker",thread.id);
    assert.equal(latest.values.researchResult.clientActionId,"newer-action",
      "stale worker cannot overwrite the newer completed result");
  }finally{
    if(unblock)unblock();
    await Promise.allSettled([saverA.end(),saverB.end(),sqlA.end({timeout:1}),sqlB.end({timeout:1})]);
  }
});
