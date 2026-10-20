import postgres from "postgres";
import {isAbsolute,join} from "node:path";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {createCatalog,type CatalogSource} from "../catalog.ts";
import {sql} from "../db.ts";
import {readCommerceActivity} from "./commerce-signals.ts";
import {purchaseSnapshots} from "./purchase-history.ts";
import {createHermesReadPorts,readExistingCart} from "./hermes-read-ports.ts";
import {listOrders,getOrder,getShippingStatus} from "../orders.ts";
import {getWishlist} from "../wishlist.ts";
import {qaCommerceDatabaseIdentityMatches} from "../qa-commerce.ts";
import {assertServiceRole} from "../db.ts";
import {verifiedRagRetriever,localRagFetcher,type LocalRagSearch,type RagConnection} from "./rag-adapter.ts";
import {createLocalRagSearch} from "./local-rag.ts";
import {loadDatasetManifest,verifyDatasetManifest} from "./dataset-manifest.ts";
import type {Provider} from "../llm.ts";
import {createLlmGroundedResponder} from "./grounded-response.ts";
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
import {requireBrainV9Schema,type SchemaProbe} from "./schema-guard.ts";
import {routeBrainMessage} from "./routing.ts";
import {createDecisionsRouter} from "./decisions-route.ts";
import {createConversationResponder} from "./conversation-response.ts";
import {createFastIntentPort} from "./fast-intent.ts";
import {currentDatasetResult} from "./dataset-state.ts";
import type {ResearchResult} from "./read-flow.ts";

/** One offline CPU encoder per runtime. Only query vectors, never corpus re-embedding. */
export async function createLocalQueryEncoder(
 options:{pythonPath:string;revision:string;modelCache:string;model?:string;dimensions?:number},spawnProcess:typeof spawn=spawn,
):Promise<{embedQuery:(query:string)=>Promise<number[]>;close:()=>void}>{
 if(!isAbsolute(options.pythonPath)||!isAbsolute(options.modelCache)||!/^[a-f0-9]{40}$/.test(options.revision))
   throw new Error("local encoder requires absolute Python/cache paths and pinned model revision");
 const model=options.model??"sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",dimensions=options.dimensions??384;
 if(!/^[-\w.]+\/[-\w.]+$/.test(model)||!Number.isSafeInteger(dimensions)||dimensions<1||dimensions>4096)
   throw new Error("invalid local encoder model or dimensions");
 const env:NodeJS.ProcessEnv={HF_HOME:options.modelCache,HF_HUB_CACHE:join(options.modelCache,"hub"),HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",
   CODEX_V4_MODEL_REVISION:options.revision,CODEX_RAG_MODEL_ID:model,CODEX_RAG_DIMENSIONS:String(dimensions),
   PYTHONUTF8:"1",TOKENIZERS_PARALLELISM:"false"};
 for(const key of ["PATH","Path","SystemRoot","WINDIR","TEMP","TMP"])
   if(process.env[key])env[key]=process.env[key];
 const child=spawnProcess(options.pythonPath,["-u",fileURLToPath(new URL("../../scripts/embed-v4-query.py",import.meta.url))],
   {stdio:"pipe",env,windowsHide:true});
 if(!child.stdin||!child.stdout||!child.stderr){child.kill();throw new Error("local encoder pipes unavailable");}
 const lines=createInterface({input:child.stdout});child.stderr.resume();
 let closed=false,tail:Promise<unknown>=Promise.resolve();
 let pending:{resolve:(v:number[])=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 const close=()=>{
   if(closed)return;closed=true;
   if(pending){clearTimeout(pending.timer);pending.reject(new Error("local encoder unavailable"));pending=undefined;}
   lines.close();child.kill();
 };
 child.on("error",close);child.on("close",close);child.stdin.on("error",close);
 lines.on("line",line=>{
   if(closed)return;
   const request=pending;
   if(!request){close();return;}
   try{
     if(line.length>dimensions*32+1024)throw new Error();
     const data=JSON.parse(line);
     if(data.model!==model||data.revision!==options.revision||data.dimensions!==dimensions||!Array.isArray(data.embedding)||
        data.embedding.length!==dimensions||!data.embedding.every((v:unknown)=>typeof v==="number"&&Number.isFinite(v)))throw new Error();
     clearTimeout(request.timer);pending=undefined;request.resolve(data.embedding);
   }catch{close();}
 });
 const encode=(query:string,timeout=20000):Promise<number[]>=>{
   const result=tail.then(()=>new Promise<number[]>((resolve,reject)=>{
     if(closed){reject(new Error("local encoder unavailable"));return;}
     if(!query.trim()||query.length>4000){reject(new Error("invalid local embedding query"));return;}
     const timer=setTimeout(close,timeout);pending={resolve,reject,timer};
     try{child.stdin!.write(JSON.stringify({query})+"\n");}catch{close();}
   }));
   tail=result.catch(()=>undefined);return result;
 };
 try{await encode("query encoder warmup",120000);}catch{close();throw new Error("local encoder warmup failed");}
 return {embedQuery:query=>encode(query),close};
}

// Provisioned by W01 only. Runtime probes these rights with SELECT; it never grants them.
export const BRAIN_SERVICE_RIGHTS={
 conversations:["SELECT","INSERT","UPDATE"],messages:["SELECT","INSERT"],
 preference_proposals:["SELECT","INSERT","UPDATE"],user_preferences:["SELECT","INSERT","UPDATE","DELETE"],
 turn_fence:["SELECT","INSERT","UPDATE"],turn_receipts:["SELECT","INSERT","UPDATE"],
 turn_attempts:["SELECT","INSERT","UPDATE"],
 checkpoints:["SELECT","INSERT","UPDATE"],checkpoint_blobs:["SELECT","INSERT","UPDATE"],
 checkpoint_writes:["SELECT","INSERT","UPDATE"],checkpoint_migrations:["SELECT"],
} as const;

/** Latest or selected owned conversation with a bounded transcript; never return raw checkpoints. */
export async function readBrainHistory(db:SchemaProbe,actorUserId:string,conversationId?:string,datasetVersion?:string){
 if(!actorUserId||actorUserId.length>256)throw new Error("invalid history actor");
 let id:string|undefined;
 if(conversationId!==undefined){
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId))
     throw new Error("invalid history conversation");
   const conversations=await db.unsafe<Array<{id:string}>>(
     "SELECT id FROM shopping_brain.conversations WHERE id=$1 AND actor_user_id=$2 AND closed_at IS NULL LIMIT 1",[conversationId,actorUserId]);
   id=conversations[0]?.id;
   if(!id)throw new Error("conversation is not owned");
 }else{
   const conversations=await db.unsafe<Array<{id:string}>>(
     "SELECT id FROM shopping_brain.conversations WHERE actor_user_id=$1 AND closed_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1",[actorUserId]);
   id=conversations[0]?.id;
 }
 if(!id)return {conversationId:null,entries:[]};
 const rows=await db.unsafe<Array<{message_id:string;client_action_id:string;content:string;completed_result:unknown}>>(
   `SELECT m.id AS message_id,m.client_action_id,m.content,r.completed_result FROM shopping_brain.messages m
    JOIN shopping_brain.conversations c ON c.id=m.conversation_id AND c.actor_user_id=m.actor_user_id
    JOIN shopping_brain.turn_receipts r ON r.conversation_id=c.id AND r.client_action_id=m.client_action_id
    WHERE c.id=$1 AND c.actor_user_id=$2 AND m.actor_user_id=$2 AND c.closed_at IS NULL
      AND m.role='user' AND r.status='COMPLETED' ORDER BY m.created_at DESC,m.id DESC LIMIT 20`,[id,actorUserId]);
 const entries=rows.reverse().flatMap(row=>{
   let result:ResearchResult;
   try{result=typeof row.completed_result==="string"?JSON.parse(row.completed_result):row.completed_result;}
   catch{throw new Error("invalid canonical Brain receipt");}
   if(!result||typeof result!=="object"||result.conversationId!==id||result.messageId!==row.message_id||
     result.clientActionId!==row.client_action_id||typeof row.content!=="string"||
     !result.ranking||!(["ranked","referenceOnly","rejected"] as const).every(key=>Array.isArray(result.ranking[key]))||
     (result.shoppingPlan?typeof result.shoppingPlan.query!=="string":result.explanation?.kind!=="CONVERSATION")||
     !result.explanation||typeof result.explanation.text!=="string"||typeof result.explanation.kind!=="string")
     throw new Error("invalid canonical Brain receipt");
   result=currentDatasetResult(result,datasetVersion);
   return [{clientActionId:row.client_action_id,text:row.content,reply:{conversation_id:id,message_id:result.messageId,read_only:true,
     ranking:result.ranking,shopping_plan:result.shoppingPlan??null,intent_kind:result.intentKind,
     ...(result.agentUi?{agent_ui:result.agentUi}:{}),
     explanation:result.explanation,trace:result.trace??{totalMs:0}}}];
 });
 return {conversationId:id,entries};
}

/** Read-only readiness check for pre-provisioned AI storage. No setup()/DDL fallback. */
export async function verifyPreparedBrainStorage(db:SchemaProbe):Promise<void>{
 const values=Object.entries(BRAIN_SERVICE_RIGHTS).flatMap(([table,rights])=>
   rights.map(right=>`('${table}','${right}')`)).join(",");
 const rows=await db.unsafe<Array<{table_name:string;ready:boolean}>>(
   `SELECT table_name,coalesce(has_schema_privilege(current_user,'shopping_brain','USAGE'),false)
       AND bool_and(coalesce(has_table_privilege(current_user,
         to_regclass('shopping_brain.'||table_name),privilege),false)) AS ready
      FROM (VALUES ${values}) required(table_name,privilege) GROUP BY table_name`);
 if(rows.length!==Object.keys(BRAIN_SERVICE_RIGHTS).length||
    !Object.keys(BRAIN_SERVICE_RIGHTS).every(name=>rows.some(r=>r.table_name===name&&r.ready===true)))
   throw new Error("Brain bootstrap tables or service permissions required before startup");
 const migrations=await db.unsafe<Array<{version:number|null;task_path:boolean}>>(
   `SELECT (SELECT max(v) FROM shopping_brain.checkpoint_migrations) AS version,
     EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='shopping_brain'
       AND table_name='checkpoint_writes' AND column_name='task_path' AND data_type='text') AS task_path`);
 if(migrations.length!==1||typeof migrations[0].version!=="number"||
    migrations[0].version<5||migrations[0].task_path!==true)
   throw new Error("Brain checkpoint bootstrap migration required before startup");
}

export async function createBrainRuntime(options:{
 brainDatabaseUrl:string;commerceDatabaseUrl?:string;provider:Provider;hermesProvider?:Provider;hermesEnabled?:boolean;rag?:RagConnection;
 catalogSource?:CatalogSource;
 catalog?:ReturnType<typeof createCatalog>;
 qaEnvironment?:string;
 localRagSearch?:LocalRagSearch;
 embedQuery?:(query:string)=>Promise<number[]>
}) {
 const {url,dbName}=parseBrainDatabaseUrl(options.brainDatabaseUrl,options.commerceDatabaseUrl);
 if(!options.provider.name.startsWith("live:"))
   throw new Error("Brain API requires live intent provider; no silent stub fallback");
 let localSearch=options.localRagSearch;
 let encoder:Awaited<ReturnType<typeof createLocalQueryEncoder>>|undefined;
 if(options.rag?.mode==="local"){
   if(options.rag.manifestPath&&(options.localRagSearch||options.embedQuery))
     throw Error("dataset manifest cannot use injected search or encoder");
   if(options.catalogSource!=="test_items"&&options.catalogSource!=="test_items2")throw new Error("local RAG requires the read-only test catalog");
   if(options.rag.contract!=="v4"||!options.rag.dataDir||!isAbsolute(options.rag.dataDir))
     throw new Error("local RAG requires v4 data directory");
   const manifest=options.rag.manifestPath?await loadDatasetManifest(options.rag.manifestPath):undefined;
   if(manifest&&(manifest.catalogSource!==options.catalogSource||manifest.datasetVersion!==options.rag.datasetVersion||
     (options.rag.category?!manifest.categories.includes(options.rag.category):!options.rag.categories?.every(c=>manifest.categories.includes(c)))||manifest.embedding.queryRevision!==options.rag.modelRevision))
     throw Error("dataset manifest does not match runtime settings");
   if(!localSearch){
     let embedQuery=options.embedQuery;
     if(!embedQuery){
       const {pythonPath,modelRevision,modelCache}=options.rag;
       if(!pythonPath||!modelRevision||!modelCache)throw new Error("local RAG query encoder must be provided; no remote fallback");
       encoder=await createLocalQueryEncoder({pythonPath,revision:modelRevision,modelCache,
         model:manifest?.embedding.model,dimensions:manifest?.embedding.dimensions});
       embedQuery=encoder.embedQuery;
     }
     try{
     const local=await createLocalRagSearch({dataDir:options.rag.dataDir,embedQuery,manifest});
     if(local.stats.datasetVersion!==options.rag.datasetVersion)throw new Error("local RAG dataset version mismatch");
     if(manifest)verifyDatasetManifest(manifest,{...local.stats,catalogSource:options.catalogSource!,
       category:options.rag.category||manifest.categories[0],queryRevision:options.rag.modelRevision!});
     localSearch=local.search;
     }catch(error){encoder?.close();throw error;}
   }
   if(typeof localSearch!=="function")throw new Error("local RAG search initialization failed");
 }
 const db=postgres(url,{max:5,connect_timeout:5});
 // Reserved lock sessions must never exhaust the observer/store pool.
 const lockDb=postgres(url,{max:5,connect_timeout:5});
 let saver:PostgresSaver|undefined;
 try{
   await assertServiceRole(db,false);
   await requireBrainV9Schema(db,dbName);
   // W01 provisions/migrates checkpoint tables separately; ordinary service startup never runs DDL.
   await verifyPreparedBrainStorage(db);
   saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
   const store=brainDatabaseFromPostgres(db);
   const conversations=new PersistentConversations(store),preferences=new PersistentPreferences(store);
   const routeMode=process.env.BRAIN_ROUTE_MODE?.trim()||"rules";
   if(routeMode!=="rules"&&routeMode!=="decisions")throw Error("BRAIN_ROUTE_MODE must be rules or decisions");
   // The decisions mode uses ONLY Decisions: never run a rules pre-pass or fallback.
   const route=routeMode==="decisions"?createDecisionsRouter({
     apiKey:process.env.OPENAI_DECISIONS_API_KEY||process.env.OPENAI_API_KEY||"",
     timeoutMs:Number(process.env.BRAIN_DECISIONS_TIMEOUT_MS??4000),
     confidenceThreshold:Number(process.env.BRAIN_DECISIONS_CONFIDENCE??0.35),
   }):routeBrainMessage;
   // Existing rule-mode QA remains unchanged; only the explicit Decisions mode uses live conversation generation.
   const converse=routeMode==="decisions"?createConversationResponder(options.provider):undefined;
   const groundedResponder=options.rag?.contract==="v4"
     ?createLlmGroundedResponder(options.provider):undefined;
   const catalog=options.catalog??createCatalog(options.catalogSource??"public");
   const ownQaCommerce=qaCommerceActivityAllowed({catalogSource:options.catalogSource,
     commerceDatabaseUrl:options.commerceDatabaseUrl,qaEnvironment:options.qaEnvironment});
   const graph=createPersistentResearchGraph({
     conversations,memory:preferences,route,converse,clarifyBeforeSearch:true,fastResponses:options.rag?.contract!=="v4",datasetVersion:options.rag?.datasetVersion,
     ...(options.hermesEnabled?{hermes:{provider:options.hermesProvider??options.provider,
       history:(actorUserId:string)=>purchaseSnapshots(sql,actorUserId),
       toolPorts:(actorUserId:string)=>createHermesReadPorts({
         actorUserId,catalog,ownedCommerce:ownQaCommerce,
         ...(ownQaCommerce?{
           cart:()=>readExistingCart(actorUserId),
           orders:async()=>{
             const result=await listOrders({actorUserId,origin:"AGENT"},{limit:10});
             if(!result.ok)throw Error("owned orders unavailable");
             return {orders:result.data.orders,hasMore:result.data.has_more};
           },
           order:async(orderId:string)=>{
             const result=await getOrder({actorUserId,origin:"AGENT"},orderId);
             return result.ok?result.data:null;
           },
           shipping:async(orderId:string)=>{
             const result=await getShippingStatus({actorUserId,origin:"AGENT"},orderId);
             return result.ok?result.data:null;
           },
         }:{})
       }),
       reviewCount:async(productId:string)=>{const result=await catalog.getReviews({product_id:productId,limit:1});return result.ok?result.data.total_matching:null;}}}:{}),
     ...(options.hermesEnabled?{wishlist:async(actorUserId:string)=>{
       const result=await getWishlist({actorUserId,origin:"AGENT"});
       if(!result.ok)throw Error("wishlist unavailable");
       return result.data.items.map(item=>({productId:item.product_id,name:item.name,active:item.active,minPriceWon:item.min_price_won}));
     }}:{}),
     ...(ownQaCommerce?{activity:(actorUserId:string)=>readCommerceActivity(sql,actorUserId)}:{}),
     retriever:options.rag?verifiedRagRetriever({...options.rag,catalogSource:options.catalogSource??"public"},catalog.getProduct,
       options.rag.mode==="local"?localRagFetcher(localSearch!):undefined,catalog.getReviewsByIds):commerceRetriever(catalog.searchProducts),
     intent:createFastIntentPort(createIntentPort(providerIntentModel(options.provider,45000),options.rag?.categories??options.rag?.category))
   },saver,postgresTurnLock(lockDb,db),new FencedTurns(store),groundedResponder);
   return {
     handle:createBrainApi({conversations,preferences,graph,recentHistory:actor=>readBrainHistory(db,actor,undefined,options.rag?.datasetVersion),
       listConversations:actor=>conversations.list(actor),
       conversationHistory:(actor,conversationId)=>readBrainHistory(db,actor,conversationId,options.rag?.datasetVersion)}),
     close:async()=>{encoder?.close();await Promise.allSettled([db.end(),lockDb.end(),saver!.end()]);}
   };
 }catch(e){
   encoder?.close();
   await Promise.allSettled([db.end(),lockDb.end(),...(saver?[saver.end()]:[])]);
   throw e;
 }
}

export function qaCommerceActivityAllowed(options:{
 catalogSource?:CatalogSource;commerceDatabaseUrl?:string;qaEnvironment?:string;
}):boolean {
 if(options.catalogSource!=="test_items"&&options.catalogSource!=="test_items2")return false;
 if(options.qaEnvironment==="system-prompt"&&options.catalogSource!=="test_items2")return false;
 return qaCommerceDatabaseIdentityMatches({
   COMMERCE_CATALOG_SOURCE:options.catalogSource,
   QA_ENVIRONMENT:options.qaEnvironment,
 },options.commerceDatabaseUrl);
}
