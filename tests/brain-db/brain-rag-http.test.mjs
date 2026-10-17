import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import postgres from "postgres";

const waitListen=async server=>{server.listen(0,"127.0.0.1");await once(server,"listening");return server.address().port;};
const close=async server=>{if(!server)return;server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));};
const facet=(id,part,score)=>({score,evidenceIds:[part+"-"+id]});
function ragFixture(audit){
 const evidence=["performance","eye_comfort","noise"].flatMap(part=>["a","b"].map(id=>({
   id:part+"-"+id,productId:"p-rag-"+id,variantId:null,kind:"REVIEW",sourceKind:"REAL",
   sourceRef:"https://qa.invalid/not-real/"+part+"-"+id
 })));
 const candidates=["a","b"].map(id=>({
   productId:"p-rag-"+id,variantId:"v-rag-"+id,sourceProductId:"CI-ONLY-NOT-REAL-"+id,
   reviewCountAuditId:audit,wholeReviewCount:20,rating:4.5,ratingScale:5,
   unitPriceWon:1,shippingFeeWon:0, // deliberately spoofed: Commerce must override
   facets:{
     performance:facet(id,"performance",id==="a"?.45:.95),
     eye_comfort:facet(id,"eye_comfort",id==="a"?.50:.90),
     noise:facet(id,"noise",.6)
   }
 }));
 return {version:"brain-rag-v1",candidates,evidence};
}

test("signed-session HTTP -> mock audited RAG -> Commerce verification -> persisted memory-driven recommendation",async()=>{
 const brainUrl=process.env.BRAIN_DATABASE_URL;
 if(!brainUrl||new URL(brainUrl).pathname!=="/brain_ci")throw Error("Only disposable brain_ci allowed");
 const admin=postgres(brainUrl,{max:1});
 const commerceUrl=new URL(brainUrl);commerceUrl.pathname="/commerce_brain_rag_ci";
 let shop,server,modelServer,ragServer,commerceDbModule;
 try{
   const [identity]=await admin.unsafe("SELECT current_database() AS name");
   assert.equal(identity.name,"brain_ci");
   await admin.unsafe("CREATE DATABASE commerce_brain_rag_ci");
   shop=postgres(commerceUrl.toString(),{max:2});
   await shop.unsafe(readFileSync(new URL("../../db/migrations/001_catalog_cart_actions.sql",import.meta.url),"utf8"));
   await shop.unsafe("INSERT INTO users(id,auth_subject,display_name,test_address_json) VALUES ('brain-rag-a','rag-a','RAG A','{}'::jsonb),('brain-rag-b','rag-b','RAG B','{}'::jsonb)");
   await shop.unsafe(`INSERT INTO products(id,name,brand,category,description)
      VALUES ('p-rag-a','Mock low-price monitor','QA','monitor','CI fixture, not a real listing'),
             ('p-rag-b','Mock high-performance monitor','QA','monitor','CI fixture, not a real listing')`);
   await shop.unsafe(`INSERT INTO product_variants(id,product_id,unit_price_won,stock_qty)
      VALUES ('v-rag-a','p-rag-a',100000,5),('v-rag-b','p-rag-b',390000,5)`);
   modelServer=createServer(async(req,res)=>{
     if(req.url!=="/v1/responses"){res.writeHead(404);return res.end();}
     for await(const _chunk of req){}
     const result=JSON.stringify({query:"monitor",maxTotalWon:500000,requiredConditions:[],currentPreferences:{}});
     res.writeHead(200,{"content-type":"application/json"});
     res.end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:result}]}]}));
   });
   const modelPort=await waitListen(modelServer);
   let audit="qa-audit-v1";let ragCalls=0;
   ragServer=createServer(async(req,res)=>{
     if(req.method!=="POST"||req.url!=="/search"||req.headers.authorization!=="Bearer ci-rag-token"){
       res.writeHead(403);return res.end();
     }
     const parts=[];for await(const c of req)parts.push(c);
     const body=JSON.parse(Buffer.concat(parts).toString("utf8"));
     assert.equal(body.version,"brain-rag-v1");
     assert.equal(body.query,"monitor");
     ragCalls++;
     res.writeHead(200,{"content-type":"application/json"});
     res.end(JSON.stringify(ragFixture(audit)));
   });
   const ragPort=await waitListen(ragServer);
   Object.assign(process.env,{
     DATABASE_URL:commerceUrl.toString(),BRAIN_DATABASE_URL:brainUrl,BRAIN_ENABLED:"1",
     BRAIN_RAG_URL:"http://127.0.0.1:"+ragPort+"/search",
     BRAIN_RAG_AUDIT_ID:"qa-audit-v1",BRAIN_RAG_TOKEN:"ci-rag-token",
     AI_LIVE_DEMO:"0",LLM_PROVIDER:"live",LLM_API_KEY:"ci_mock_responses_only",
     LLM_MODEL:"ci-mock",LLM_BASE_URL:"http://127.0.0.1:"+modelPort+"/v1",
     SESSION_SECRET:randomBytes(32).toString("hex"),
     TEST_USER_CODES:"rag-code-a=rag-a,rag-code-b=rag-b"
   });
   const {start}=await import("../../src/server.ts");
   commerceDbModule=await import("../../src/db.ts");
   server=await start(0,{build:async()=>{}});
   const base="http://127.0.0.1:"+server.address().port;
   const call=async(path,method="GET",payload,cookie)=>{
     const r=await fetch(base+path,{method,signal:AbortSignal.timeout(25000),
       headers:{"content-type":"application/json",...(cookie?{cookie}:{}),origin:base},
       ...(payload!==undefined?{body:JSON.stringify(payload)}:{})});
     const raw=await r.text();return {status:r.status,body:JSON.parse(raw),headers:r.headers};
   };
   const auth=async code=>{
     const r=await call("/api/session","POST",{code});
     assert.equal(r.status,200);
     return r.headers.get("set-cookie").split(";")[0];
   };
   const a=await auth("rag-code-a"),b=await auth("rag-code-b");
   const thread=(await call("/api/brain/conversations","POST",{},a)).body.data.id;
   const turn=async(action,user=a)=>{
     const r=await call("/api/brain/conversations/"+thread+"/turn","POST",
       {client_action_id:action,user_message:"모니터 두 제품을 비교해줘"},user);
     return r;
   };
   const remember=async(key,value,sourceMessageId)=>{
     const p=await call("/api/brain/preferences/proposals","POST",
       {conversation_id:thread,source_message_id:sourceMessageId,key,value},a);
     assert.equal(p.status,201,JSON.stringify(p.body));
     const confirm=await call("/api/brain/preferences/confirm","POST",{proposal_id:p.body.data.proposal_id},a);
     assert.equal(confirm.status,200);
   };
   const initial=await turn("rag-turn-1");assert.equal(initial.status,200,JSON.stringify(initial.body));
   assert.equal(initial.body.data.ranking.ranked.length,2,"Only audited fixture is eligible");
   const initialCandidates=initial.body.data.ranking.ranked.map(x=>x.candidate);
   assert.equal(initialCandidates.find(x=>x.productId==="p-rag-a").unitPriceWon,100000);
   assert.equal(initialCandidates.find(x=>x.productId==="p-rag-b").unitPriceWon,390000);
   await remember("price_priority","value",initial.body.data.message_id);
   const cheap=await turn("rag-turn-2");
   assert.equal(cheap.status,200);
   assert.equal(cheap.body.data.ranking.ranked[0].candidate.productId,"p-rag-a");
   await remember("price_priority","performance",cheap.body.data.message_id);
   const fast=await turn("rag-turn-3");
   assert.equal(fast.status,200);
   assert.equal(fast.body.data.ranking.ranked[0].candidate.productId,"p-rag-b");
   assert.equal((await call("/api/brain/preferences","GET",undefined,b)).body.data.length,0);
   assert.equal((await turn("rag-foreign-turn",b)).status,404);
   audit="unaudited";
   const noProof=await turn("rag-turn-4");
   assert.equal(noProof.status,200);
   assert.equal(noProof.body.data.ranking.ranked.length,0,"Missing trusted audit must fail recommendation gate");
   assert.equal(noProof.body.data.ranking.referenceOnly.length,2);
   assert.ok(ragCalls>=4);
   const [cart]=await shop.unsafe("SELECT count(*)::int AS n FROM carts");
   const [writes]=await shop.unsafe("SELECT count(*)::int AS n FROM action_requests");
   assert.equal(cart.n,0);assert.equal(writes.n,0);
   console.log("BRAIN_RAG_HTTP_PASS personalized reversal, audit fail-closed and Commerce writes=0");
 } finally{
   await close(server);
   if(commerceDbModule?.sql)await commerceDbModule.sql.end();
   await close(ragServer);await close(modelServer);
   if(shop)await shop.end();
   await admin.end();
 }
});
