// Spawned only by brain-worker-kill.test.mjs using disposable /brain_ci.
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../../src/brain/graph.ts";
import {postgresTurnLock} from "../../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../../src/brain/fenced-turns.ts";

const url=process.env.BRAIN_DATABASE_URL;
if(!url||new URL(url).pathname!=="/brain_ci"||!process.env.BRAIN_QA_THREAD)
 throw Error("disposable brain_ci and test conversation required");
const db=postgres(url,{max:3}),lockDb=postgres(url,{max:2});
const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
await saver.setup();
const conversations=new PersistentConversations(brainDatabaseFromPostgres(db));
const memory=new PersistentPreferences(brainDatabaseFromPostgres(db));
const graph=createPersistentResearchGraph({
  conversations,memory,
  intent:{extract:async()=>({query:"monitor",
    context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async()=>{
    process.send?.({kind:"in-retrieve"});
    await new Promise(()=>{}); // Parent will kill the actual OS process.
    return {candidates:[],evidence:[]};
  }}
},saver,postgresTurnLock(lockDb,db),process.env.BRAIN_QA_FENCED==="1"?new FencedTurns(brainDatabaseFromPostgres(db)):undefined);
await graph.invoke({actorUserId:"worker-kill-owner",
  conversationId:process.env.BRAIN_QA_THREAD,
  requestId:crypto.randomUUID(),clientActionId:"child-action",
  userMessage:"모니터 추천"});
