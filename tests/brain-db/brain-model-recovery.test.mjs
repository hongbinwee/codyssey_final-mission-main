import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {createBrainApi} from "../../src/brain/api.ts";

for(const fault of [{message:"LLM http 429",http:429,code:"MODEL_RATE_LIMIT"},
                    {message:"LLM timeout",http:504,code:"MODEL_TIMEOUT"}]){
  test("failed planning "+fault.code+" resumes on explicit same-action retry after saver restart",async()=>{
    const url=process.env.BRAIN_DATABASE_URL;
    if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
    const db=postgres(url,{max:3}),lockDb=postgres(url,{max:2});
    let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
    let retrievals=0,failOnce=true;
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    try{
      await saver.setup();
      const thread=await conversations.create("model-recovery-owner");
      const deps={conversations,memory,
        intent:{extract:async(msg,_,previous)=>{
          if(msg==="첫 구매 계획")return {query:"monitor",queryMode:"SET",budgetMode:"SET",
            context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}};
          assert.equal(previous?.maxTotalWon,500000,"must derive from last complete plan");
          if(failOnce){failOnce=false;throw Error(fault.message);}
          return {query:"monitor",queryMode:"KEEP",budgetMode:"SET",requirementsMode:"KEEP",
            context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}}};
        }},
        retriever:{search:async()=>{retrievals++;return {candidates:[],evidence:[]};}}
      };
      const makeGraph=()=>createPersistentResearchGraph(deps,saver,postgresTurnLock(lockDb,db));
      let graph=makeGraph();
      const send=(graph,action,message)=>createBrainApi({conversations,preferences:memory,graph})
        ("POST",`/api/brain/conversations/${thread.id}/turn`,"model-recovery-owner",
        {client_action_id:action,user_message:message});
      const first=await send(graph,"initial","첫 구매 계획");
      assert.equal(first.status,200);
      assert.equal(first.body.data.shopping_plan.maxTotalWon,500000);
      const failed=await send(graph,"retry-action","예산을 30만원으로");
      assert.equal(failed.status,fault.http);
      assert.equal(failed.body.ok,false);
      assert.equal(failed.body.error.code,fault.code);
      assert.doesNotMatch(JSON.stringify(failed),/traceback|token|connection string/i);
      assert.equal(retrievals,1,"a failed planner must not invent RAG results");

      await saver.end();
      saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
      await saver.setup();
      graph=makeGraph();
      const retry=await send(graph,"retry-action","예산을 30만원으로");
      assert.equal(retry.status,200,JSON.stringify(retry.body));
      assert.equal(retry.body.data.shopping_plan.maxTotalWon,300000);
      assert.equal(retry.body.data.shopping_plan.revision,2);
      assert.equal(retrievals,2);
      const replay=await send(graph,"retry-action","예산을 30만원으로");
      assert.equal(replay.status,200);
      assert.equal(replay.body.data.message_id,retry.body.data.message_id);
      assert.equal(retrievals,2,"completed action must not rerun RAG");
      const [{n}]=await db.unsafe(`SELECT count(*)::int AS n FROM shopping_brain.messages
        WHERE conversation_id=$1 AND client_action_id='retry-action'`,[thread.id]);
      assert.equal(n,1);
    }finally{await Promise.allSettled([saver.end(),lockDb.end(),db.end()]);}
  });
}
