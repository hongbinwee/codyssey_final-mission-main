import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {searchProducts,getProduct} from "../catalog.ts";
import {verifiedRagRetriever,type RagConnection} from "./rag-adapter.ts";
import type {Provider} from "../llm.ts";
import {brainDatabaseFromPostgres} from "./pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "./persistent-store.ts";
import {createBrainApi} from "./api.ts";
import {createPersistentResearchGraph} from "./graph.ts";
import {postgresTurnLock} from "./turn-lock.ts";
import {FencedTurns} from "./fenced-turns.ts";
import {parseBrainDatabaseUrl} from "./database-isolation.ts";
import {commerceRetriever} from "./commerce-retriever.ts";
import {providerIntentModel} from "./provider-intent.ts";
import {createIntentPort} from "./intent.ts";
import {requireBrainV9Schema} from "./schema-guard.ts";
import {createDistributedBrainRateLimit} from "./rate-limit.ts";

export async function createBrainRuntime(options:{
 brainDatabaseUrl:string;commerceDatabaseUrl?:string;provider:Provider;rag?:RagConnection
}) {
 const {url,dbName}=parseBrainDatabaseUrl(options.brainDatabaseUrl,options.commerceDatabaseUrl);
 if(!options.provider.name.startsWith("live:"))
   throw new Error("Brain API requires live intent provider; no silent stub fallback");
 const db=postgres(url,{max:5,connect_timeout:5});
 // Reserved lock sessions must never exhaust the observer/store pool.
 const lockDb=postgres(url,{max:5,connect_timeout:5});
 let saver:PostgresSaver|undefined;
 try{
   await requireBrainV9Schema(db,dbName);
   saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
   // Creates/checks LangGraph tables in AI-only database, never Commerce.
   await saver.setup();
   const store=brainDatabaseFromPostgres(db);
   const conversations=new PersistentConversations(store),preferences=new PersistentPreferences(store);
   const graph=createPersistentResearchGraph({
     conversations,memory:preferences,
     retriever:options.rag?verifiedRagRetriever(options.rag,getProduct):commerceRetriever(searchProducts),
     intent:createIntentPort(providerIntentModel(options.provider,45000))
   },saver,postgresTurnLock(lockDb,db),new FencedTurns(store));
   return {
     takeRate:createDistributedBrainRateLimit(store).take,
     handle:createBrainApi({conversations,preferences,graph}),
     close:async()=>{await Promise.allSettled([db.end(),lockDb.end(),saver!.end()]);}
   };
 }catch(e){
   await Promise.allSettled([db.end(),lockDb.end(),...(saver?[saver.end()]:[])]);
   throw e;
 }
}
