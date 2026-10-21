import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {BRAIN_SERVICE_RIGHTS} from "../../src/brain/runtime.ts";
import {provisionBrainCiService} from "./fixtures/service-role.mjs";

test("CI Brain service role receives only runtime-declared table privileges",async()=>{
 const grants=[];
 const admin={unsafe:async query=>{
  if(query==="SELECT current_database() AS name")return [{name:"brain_ci"}];
  if(String(query).startsWith("GRANT "))grants.push(String(query));
  return [];
 }};
 const serviceUrl=await provisionBrainCiService(admin,"postgres://127.0.0.1:5432/brain_ci");
 const service=new URL(serviceUrl);
 assert.equal(service.pathname,"/brain_ci");
 assert.match(service.username,/^brain_ci_service_[a-f0-9]{16}$/);
 const expected=[
  `GRANT CONNECT ON DATABASE brain_ci TO ${service.username}`,
  `GRANT USAGE ON SCHEMA shopping_brain TO ${service.username}`,
  ...Object.entries(BRAIN_SERVICE_RIGHTS).map(([table,rights])=>
   `GRANT ${rights.join(",")} ON TABLE shopping_brain.${table} TO ${service.username}`),
 ];
 assert.equal(grants.length,expected.length);
 assert.deepEqual(grants,expected);
 assert.ok(grants.every(statement=>!/(ON ALL TABLES|SEQUENCES)/i.test(statement)));
});

test("real HTTP actor cookie -> LangGraph -> isolated DB -> Commerce read-only reference",async()=>{
 const brainUrl=process.env.BRAIN_DATABASE_URL;
 if(!brainUrl||new URL(brainUrl).pathname!=="/brain_ci")throw Error("brain_ci-only service required");
 const admin=postgres(brainUrl,{max:1});
 console.log("BRAIN_HTTP_STEP 01 connected");
 const physical="commerce_brain_ci"; // newly created disposable database, never a protected Commerce DB
 const commerceUrl=new URL(brainUrl);commerceUrl.pathname="/"+physical;
 let shop,server,mock;
 try{
  const [current]=await admin.unsafe("SELECT current_database() AS name");
  assert.equal(current.name,"brain_ci");
  await admin.unsafe("CREATE DATABASE "+physical);
  console.log("BRAIN_HTTP_STEP 02 disposable-commerce-created");
  shop=postgres(commerceUrl.toString(),{max:2});
  await shop.unsafe(readFileSync(new URL("../../db/migrations/001_catalog_cart_actions.sql",import.meta.url),"utf8"));
  await shop.unsafe("INSERT INTO users(id,auth_subject,display_name,test_address_json) VALUES ('user-http-a','http-a','QA A','{}'::jsonb),('user-http-b','http-b','QA B','{}'::jsonb)");
  await shop.unsafe(`INSERT INTO products(id,name,brand,category,description,image_urls,specs_json)
      VALUES ('p-http-monitor','Demo Monitor 모니터','QA','monitor','CI-only synthetic monitor','[]'::jsonb,'{"resolution":"FHD"}'::jsonb)`);
  await shop.unsafe(`INSERT INTO product_variants(id,product_id,unit_price_won,stock_qty)
      VALUES ('v-http-monitor','p-http-monitor',190000,4)`);
  await shop.unsafe(`INSERT INTO reviews(id,product_id,rating,body,source_kind,source_ref,written_at)
      VALUES ('r-http-review','p-http-monitor',5,'CI mock only','SYNTHETIC','ci-fixture',now())`);
  mock=createServer((req,res)=>{
    assert.equal(req.url,"/v1/responses");
    const body=JSON.stringify({query:"Monitor",maxTotalWon:500000,requiredConditions:[],currentPreferences:{price_priority:"value"}});
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:body}]}]}));
  });
  mock.listen(0,"127.0.0.1");await once(mock,"listening");
  const mockPort=mock.address().port;
  const serviceUrl=await provisionBrainCiService(admin,brainUrl);
  console.log("BRAIN_HTTP_STEP 03 local-model-mock-ready");
  Object.assign(process.env,{
    DATABASE_URL:commerceUrl.toString(),BRAIN_DATABASE_URL:serviceUrl,BRAIN_ENABLED:"1",
    AI_LIVE_DEMO:"0",LLM_PROVIDER:"live",LLM_API_KEY:"ci_local_mock_only",
    LLM_MODEL:"ci-mock",LLM_BASE_URL:"http://127.0.0.1:"+mockPort+"/v1",
    SESSION_SECRET:randomBytes(32).toString("hex"),TEST_USER_CODES:"qa-code-a=http-a,qa-code-b=http-b"
  });
  const {start}=await import("../../src/server.ts");
  const commerceDbModule=await import("../../src/db.ts"); // read live export after start()
  try{
    server=await start(0,{build:async()=>{}}); // npm run build separately verifies UI bundle
    console.log("BRAIN_HTTP_STEP 04 commerce-api-and-brain-started");
    const port=server.address().port,base="http://127.0.0.1:"+port;
    // Drain EVERY response body: dangling keep-alive bodies can starve the local agent.
    const request=async(path,method="GET",payload,cookie,origin)=>{
      const response=await fetch(base+path,{
        method,signal:AbortSignal.timeout(30000),
        headers:{"content-type":"application/json",...(cookie?{cookie}:{}),...((cookie&&(method==="POST"||method==="DELETE"))?{origin:origin??base}:(origin?{origin}:{}))},
        ...(payload!==undefined?{body:JSON.stringify(payload)}:{})
      });
      const raw=await response.text();
      return {status:response.status,headers:response.headers,json:async()=>JSON.parse(raw)};
    };
    const unauth=await request("/api/brain/status");assert.equal(unauth.status,401);
    const login=async code=>{
      const r=await request("/api/session","POST",{code});
      assert.equal(r.status,200);
      const c=r.headers.get("set-cookie");assert.match(c,/HttpOnly/);
      return c.split(";")[0];
    };
    const userA=await login("qa-code-a"),userB=await login("qa-code-b");
    console.log("BRAIN_HTTP_STEP 05 authenticated-sessions-issued");
    const status=await request("/api/brain/status","GET",undefined,userA);
    assert.equal(status.status,200);
    const badOrigin=await request("/api/brain/conversations","POST",{},userA,"https://attacker.invalid");
    assert.equal(badOrigin.status,403);
    const noOrigin=await fetch(base+"/api/brain/conversations",{
      method:"POST",headers:{cookie:userA,"content-type":"application/json"},body:"{}"
    });
    assert.equal(noOrigin.status,403,"cookie mutations without origin/referrer must fail closed");
    await noOrigin.text();
    const spoofed=await fetch(base+"/api/brain/conversations",{
      method:"POST",headers:{cookie:userA,origin:base,"sec-fetch-site":"cross-site",
        "content-type":"application/json"},body:"{}"
    });
    assert.equal(spoofed.status,403,"Fetch Metadata must reject cross-site forgery");
    await spoofed.text();
    const convo=await request("/api/brain/conversations","POST",{},userA);
    assert.equal(convo.status,201);
    const id=(await convo.json()).data.id;
    assert.match(id,/^[a-f0-9-]{36}$/);
    const cross=await request("/api/brain/conversations/"+id+"/state","GET",undefined,userB);
    assert.equal(cross.status,404);
    const wrongTurn=await request("/api/brain/conversations/"+id+"/turn","POST",
      {user_message:"Monitor",client_action_id:"qa-b"},userB);
    assert.equal(wrongTurn.status,404);
    console.log("BRAIN_HTTP_STEP 06 before-read-only-turn");
    const turn=await request("/api/brain/conversations/"+id+"/turn","POST",
      {user_message:"업무용 모니터를 50만원 이하로 추천",client_action_id:"qa-a-1",actorUserId:"user-http-b"},userA);
    assert.equal(turn.status,200);
    const result=(await turn.json()).data;
    assert.equal(result.read_only,true);
    assert.equal(result.ranking.ranked.length,1,"verified Commerce price, unknown source review count is not a hard gate");
    assert.ok(result.ranking.ranked.some(p=>p.candidate.productId==="p-http-monitor"&&p.limitations.includes("whole_review_count_unverified")));
    const sourceMessage=result.message_id;
    console.log("BRAIN_HTTP_STEP 07 graph-and-reference-result-received");
    const propose=await request("/api/brain/preferences/proposals","POST",
      {conversation_id:id,source_message_id:sourceMessage,key:"price_priority",value:"value"},userA);
    assert.equal(propose.status,201);
    const token=(await propose.json()).data.proposal_id;
    const confirm=await request("/api/brain/preferences/confirm","POST",{proposal_id:token},userA);
    assert.equal(confirm.status,200);
    const reused=await request("/api/brain/preferences/confirm","POST",{proposal_id:token},userA);
    assert.equal(reused.status,404); // Replayed or foreign proof is deliberately non-enumerable.
    const memory=await request("/api/brain/preferences","GET",undefined,userA);
    assert.equal((await memory.json()).data[0].value,"value");
    const memoryB=await request("/api/brain/preferences","GET",undefined,userB);
    assert.deepEqual((await memoryB.json()).data,[]);
    const [carts]=await shop.unsafe("SELECT count(*)::int AS n FROM carts");
    const [writes]=await shop.unsafe("SELECT count(*)::int AS n FROM action_requests");
    assert.equal(carts.n,0);assert.equal(writes.n,0);
    // Authenticated requests have no fixed application per-minute quota.
    // Invalid payloads exercise HTTP validation without spending model tokens.
    for(let i=0;i<35;i++){
      const rejected=await request("/api/brain/conversations/"+id+"/turn","POST",{},userA);
      assert.equal(rejected.status,400,"requests beyond former turn/mutation limits must reach validation");
    }
    const unauthenticated=await request("/api/brain/conversations","POST",{});
    assert.equal(unauthenticated.status,401,"removing quotas must not remove authentication");
    const unaffected=await request("/api/brain/status","GET",undefined,userA);
    assert.equal(unaffected.status,200,"read-only status is not part of mutation budget");
    console.log("BRAIN_HTTP_STEP 08 no-commerce-writes");
  } finally {
    if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
    if(commerceDbModule.sql)await commerceDbModule.sql.end();
  }
 } finally {
  if(mock){mock.closeAllConnections?.();await new Promise(resolve=>mock.close(resolve));}
  if(shop)await shop.end();
  await admin.end();
 }
});
