import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {chromium} from "@playwright/test";
import {summarizeLatency} from "../../src/brain/latency.ts";

const listen=async(server)=>{server.listen(0,"127.0.0.1");await once(server,"listening");return server.address().port;};
const close=async server=>{if(!server)return;server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));};
const source=(id,aspect)=>({
  id:aspect+"-"+id,productId:"p-browser-"+id,variantId:null,kind:"REVIEW",
  sourceKind:"REAL",sourceRef:"https://ci.invalid/synthetic-demo-not-a-real-review"
});
const payload=()=>({
 version:"brain-rag-v1",
 evidence:["performance","eye_comfort","noise"].flatMap(a=>["a","b"].map(id=>source(id,a))),
 candidates:["a","b"].map(id=>({
   productId:"p-browser-"+id,variantId:"v-browser-"+id,sourceProductId:"CI-FIXTURE-"+id,
   reviewCountAuditId:"ci-browser-only",wholeReviewCount:25,rating:4.5,ratingScale:5,
   facets:{
     performance:{score:id==="a"?.45:.95,evidenceIds:["performance-"+id]},
     eye_comfort:{score:id==="a"?.45:.9,evidenceIds:["eye_comfort-"+id]},
     noise:{score:.65,evidenceIds:["noise-"+id]}
   }
 }))
});
test("Chromium: log in, save long-term preference, get personalized reranking, follow-up, retry failed retrieval", {timeout:125000},async()=>{
 const brainUrl=process.env.BRAIN_DATABASE_URL;
 if(!brainUrl||new URL(brainUrl).pathname!=="/brain_ci")throw Error("isolated brain_ci only");
 const admin=postgres(brainUrl,{max:1});
 const commerceUrl=new URL(brainUrl);commerceUrl.pathname="/commerce_brain_browser_ci";
 let shop,apiServer,modelServer,ragServer,browser,dbModule;
 try{
   const [identity]=await admin.unsafe("SELECT current_database() AS name");
   assert.equal(identity.name,"brain_ci");
   await admin.unsafe("CREATE DATABASE commerce_brain_browser_ci");
   shop=postgres(commerceUrl.toString(),{max:2});
   // Only the newly provisioned disposable Commerce database. Never migrate an existing one.
   for(const name of ["001_catalog_cart_actions.sql","002_orders_payments_shipments.sql",
       "003_cancel_requests.sql","004_wishlist_items.sql"]){
     await shop.unsafe(readFileSync(new URL("../../db/migrations/"+name,import.meta.url),"utf8"));
   }
   await shop.unsafe("INSERT INTO users(id,auth_subject,display_name,test_address_json) VALUES ('browser-qa-a','browser-a','Brain QA A','{}'::jsonb),('browser-qa-b','browser-b','Brain QA B','{}'::jsonb)");
   await shop.unsafe(`INSERT INTO products(id,name,brand,category,description)
     VALUES ('p-browser-a','QA value monitor','CI','monitor','Not a real product'),
            ('p-browser-b','QA performance monitor','CI','monitor','Not a real product')`);
   await shop.unsafe(`INSERT INTO product_variants(id,product_id,unit_price_won,stock_qty)
     VALUES ('v-browser-a','p-browser-a',100000,5),('v-browser-b','p-browser-b',390000,5)`);
   let failNextModelStatus=null;
   modelServer=createServer(async(req,res)=>{
     for await(const _ of req){}
     if(req.url!=="/v1/responses"){res.writeHead(404);return res.end();}
     if(failNextModelStatus){const status=failNextModelStatus;failNextModelStatus=null;res.writeHead(status);return res.end("CI injected model error");}
     const answer={
       query:"monitor",maxTotalWon:500000,requiredConditions:[],currentPreferences:{},
       queryMode:"KEEP",budgetMode:"KEEP",requirementsMode:"KEEP"
     };
     // The initial plan has no existing context; modes KEEP are valid there.
     res.writeHead(200,{"content-type":"application/json"});
     res.end(JSON.stringify({status:"completed",output:[{
       type:"message",content:[{type:"output_text",text:JSON.stringify(answer)}]
     }]}));
   });
   const modelPort=await listen(modelServer);
   let failNext=false,ragCalls=0;
   ragServer=createServer(async(req,res)=>{
     for await(const _ of req){}
     if(req.url!=="/search"||req.method!=="POST"){res.writeHead(404);return res.end();}
     ragCalls++;
     if(failNext){failNext=false;res.writeHead(503);return res.end("CI temporary retrieval outage");}
     res.writeHead(200,{"content-type":"application/json"});
     res.end(JSON.stringify(payload()));
   });
   const ragPort=await listen(ragServer);
   Object.assign(process.env,{
     DATABASE_URL:commerceUrl.toString(),BRAIN_DATABASE_URL:brainUrl,BRAIN_ENABLED:"1",
     BRAIN_RAG_URL:"http://127.0.0.1:"+ragPort+"/search",
     BRAIN_RAG_AUDIT_ID:"ci-browser-only",AI_LIVE_DEMO:"0",
     LLM_PROVIDER:"live",LLM_API_KEY:"ci-mock-only",
     LLM_MODEL:"ci-model",LLM_BASE_URL:"http://127.0.0.1:"+modelPort+"/v1",
     SESSION_SECRET:randomBytes(32).toString("hex"),TEST_USER_CODES:"browser-code-a=browser-a,browser-code-b=browser-b"
   });
   const {start}=await import("../../src/server.ts");
   dbModule=await import("../../src/db.ts");
   apiServer=await start(0); // rebuild real React bundle for browser use
   console.log("BROWSER_STAGE 01 server started");
   const base="http://127.0.0.1:"+apiServer.address().port;
   for(const path of ["/","/web/app.js","/web/styles.css"]){
     const r=await fetch(base+path,{signal:AbortSignal.timeout(5000)});
     console.log("BROWSER_STATIC "+path+" "+r.status);
     assert.equal(r.status,200,"static file "+path+" must be served");
     await r.arrayBuffer();
   }
   browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
   console.log("BROWSER_STAGE 02 chromium launched");
   const ctx=await browser.newContext({baseURL:base});
   const page=await ctx.newPage();
   const graphTraces=[];
   page.on("response",res=>{
     if(res.request().method()==="POST"&&/\/api\/brain\/conversations\/[^/]+\/turn$/.test(res.url()))
       graphTraces.push(res.json().then(payload=>
         payload.ok&&Number.isFinite(payload.data?.trace?.graphWallMs)?payload.data.trace.graphWallMs:null
       ).catch(()=>null));
   });
   page.on("requestfailed",r=>console.log("BROWSER_REQUEST_FAILED",r.url().split("?")[0],r.failure()?.errorText));
   page.on("pageerror",err=>console.log("BROWSER_PAGE_ERROR",err.message.slice(0,250)));
   await page.goto("/");
   console.log("BROWSER_STAGE 03 navigated");
   await page.getByPlaceholder("접근 코드").fill("browser-code-a");
   await page.getByRole("button",{name:"시작하기"}).click();
   await page.getByPlaceholder("상품 검색").waitFor({timeout:15000});
   console.log("BROWSER_STAGE 04 logged in");
   await page.getByTitle("AI 쇼핑 도우미").click();
   const panel=page.locator('aside[aria-label="Shopping Brain Preview"]');
   await panel.waitFor({timeout:15000});
   console.log("BROWSER_STAGE 05 preview visible");
   const send=async(message)=>{
     const count=await panel.locator(".msg.ai").count();
     await panel.getByPlaceholder("쇼핑 조건을 입력하세요").fill(message);
     await panel.getByRole("button",{name:"보내기"}).click();
     return panel.locator(".msg.ai").nth(count);
   };
   const first=await send("모니터를 50만원 이하로 추천해줘");
   await first.locator(".compare-row").first().waitFor({timeout:25000});
   assert.ok(await first.getByText(/500,000원/).count()>0);
   const remember=async(value)=>{
     await panel.locator(".state-box select").selectOption(value);
     await panel.getByRole("button",{name:"선호 저장 요청"}).click();
     await panel.getByRole("button",{name:"이 선호를 기억하도록 확인"}).click();
     await panel.getByText("price_priority: "+value).waitFor({timeout:12000});
   };
   await remember("value");
   const second=await send("같은 모니터에서 가격이 중요해");
   await second.locator(".compare-row").first().waitFor({timeout:25000});
   assert.match(await second.locator(".compare-row").first().innerText(),/QA value monitor/);
   await remember("performance");
   const third=await send("이제 성능을 우선해서 비교해줘");
   await third.locator(".compare-row").first().waitFor({timeout:25000});
   assert.match(await third.locator(".compare-row").first().innerText(),/QA performance monitor/);
   assert.ok(await third.getByText(/500,000원/).count()>0,"existing budget preserved across turns");

   failNext=true;
   const countBefore=await panel.locator(".msg.ai").count();
   await send("조건 유지하고 다시 보여줘");
   await panel.getByRole("alert").waitFor({timeout:25000});
   assert.equal(await panel.locator(".msg.ai").count(),countBefore,"failed request must not claim successful ranking");
   assert.equal(await panel.getByPlaceholder("쇼핑 조건을 입력하세요").inputValue(),"조건 유지하고 다시 보여줘","failed user text remains");
   await panel.getByRole("button",{name:"보내기"}).click();
   await panel.locator(".msg.ai").nth(countBefore).locator(".compare-row").first().waitFor({timeout:25000});
   assert.ok(ragCalls>=5);
   // LLM planner failure after a completed turn must preserve the last completed plan.
   failNextModelStatus=503;
   const beforeModelFailure=await panel.locator(".msg.ai").count();
   await send("모니터 예산 유지하며 다시 비교");
   await panel.getByRole("alert").waitFor({timeout:25000});
   assert.equal(await panel.locator(".msg.ai").count(),beforeModelFailure,
     "failed model intent must not display stale or partial recommendation");
   assert.equal(await panel.getByPlaceholder("쇼핑 조건을 입력하세요").inputValue(),
     "모니터 예산 유지하며 다시 비교");
   await panel.getByRole("button",{name:"보내기"}).click();
   const afterModelRetry=panel.locator(".msg.ai").nth(beforeModelFailure);
   await afterModelRetry.locator(".compare-row").first().waitFor({timeout:25000});
   assert.ok(await afterModelRetry.getByText(/500,000원/).count()>0,
     "failed LLM call cannot destroy previous completed budget plan");
   await panel.getByRole("button",{name:"가격 선호 기억 삭제"}).click();
   await panel.getByText(/저장된 장기 가격 선호만 삭제했어요/).waitFor({timeout:12000});
   assert.equal(await panel.getByText("price_priority: performance").count(),0,
     "canonical long-term memory removed; previous conversations remain separate");
   failNextModelStatus=429;
   const before429=await panel.locator(".msg.ai").count();
   await send("같은 모니터 조건 유지해줘");
   await panel.getByRole("alert").waitFor({timeout:25000});
   assert.equal(await panel.locator(".msg.ai").count(),before429,
     "HTTP 429 must not generate a successful recommendation");
   assert.equal(await panel.getByPlaceholder("쇼핑 조건을 입력하세요").inputValue(),
     "같은 모니터 조건 유지해줘");
   await panel.getByRole("button",{name:"보내기"}).click();
   const after429=panel.locator(".msg.ai").nth(before429);
   await after429.locator(".compare-row").first().waitFor({timeout:25000});
   assert.ok(await after429.getByText(/500,000원/).count()>0,
     "existing budget persists through model 429");
   const samples=(await Promise.all(graphTraces)).filter(n=>n!==null);
   assert.ok(samples.length>=4,"four successful CI mock Graph executions must be timed");
   console.log("BRAIN_BROWSER_MOCK_GRAPH_LATENCY",JSON.stringify(summarizeLatency(samples)),
      "(Mock Responses/RAG, network/render excluded; not live-model latency)");
   // Storefront GET /api/cart may create an empty cart by design; measure actual writes instead.
   assert.equal((await shop.unsafe("SELECT count(*)::int AS n FROM cart_items"))[0].n,0);
   assert.equal((await shop.unsafe("SELECT count(*)::int AS n FROM action_requests"))[0].n,0);
   await ctx.close();
   console.log("BRAIN_CHROMIUM_PASS owned sign-in, preference reversal, budget carryover, failed-retrieval retry, Commerce writes=0");
 }finally{
   if(browser)await browser.close();
   await close(apiServer);
   if(dbModule?.sql)await dbModule.sql.end();
   await close(ragServer);await close(modelServer);
   if(shop)await shop.end();await admin.end();
 }
});
