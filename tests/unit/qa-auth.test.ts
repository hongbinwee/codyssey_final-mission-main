import test from "node:test";
import assert from "node:assert/strict";
import {createHmac,scryptSync} from "node:crypto";
import {createQaAuth} from "../../src/qa-auth.ts";
import {signSession} from "../../src/session.ts";
import {mkdtemp,writeFile,unlink,rmdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {start} from "../../src/server.ts";

const secret="unit-only-session-signing-secret";
const codes=Array.from({length:6},(_,i)=>`QA00000${i+1}`);
const lookup=(code:string)=>createHmac("sha256",secret).update("qa-code:"+code).digest("hex");
function fixture(){return {version:1,records:codes.map((code,i)=>{
 const salt=Buffer.alloc(16,i+1).toString("hex");
 return {userId:`tester_0${i+1}`,salt,codeHash:scryptSync(code,salt,32,{N:16384,r:8,p:1}).toString("hex"),codeLookupHash:lookup(code),sessionVersion:1,disabled:false};
})};}

test("six QA users log in independently with expiring persistent signed sessions",async()=>{
 const data=fixture();let now=1000000;
 const auth=createQaAuth({secret,load:async()=>data,now:()=>now,secure:true});
 const replies=await Promise.all(codes.map(code=>auth.login(code,"127.0.0.1")));
 assert.deepEqual(replies.map(r=>r.ok&&r.userId),data.records.map(r=>r.userId));
 for(const reply of replies){
  assert.ok(reply.ok);if(!reply.ok)continue;
  assert.match(reply.cookie,/Max-Age=604800/);assert.match(reply.cookie,/HttpOnly/);
  assert.match(reply.cookie,/SameSite=Lax/);assert.match(reply.cookie,/; Secure/);
  const cookie=reply.cookie.split(";")[0];
  assert.equal(await auth.actor(cookie),reply.userId);
  now+=1000;assert.equal(await auth.actor(cookie),reply.userId);
 }
 const first=replies[0];assert.ok(first.ok);if(!first.ok)return;
 now=1000000+604800000;
 assert.equal(await auth.actor(first.cookie.split(";")[0]),null);
 assert.equal(await auth.actor("session="+signSession("tester_01",secret)),null);
 assert.equal(await auth.actor("session=%invalid"),null);
 assert.match(auth.clearCookie(),/Max-Age=0/);assert.match(auth.clearCookie(),/; Secure/);
});

test("QA revocation/version is re-read for existing sessions and replacement code",async()=>{
 const data=fixture();const auth=createQaAuth({secret,load:async()=>data});
 const old=await auth.login(codes[0],"local");assert.ok(old.ok);if(!old.ok)return;
 data.records[0].sessionVersion++;
 assert.equal(await auth.actor(old.cookie.split(";")[0]),null);
 const replacement="NEW00001";
 data.records[0].codeHash=scryptSync(replacement,data.records[0].salt,32,{N:16384,r:8,p:1}).toString("hex");
 data.records[0].codeLookupHash=lookup(replacement);
 assert.equal((await auth.login(codes[0],"local")).ok,false);
 const fresh=await auth.login(replacement,"local");assert.ok(fresh.ok);if(!fresh.ok)return;
 assert.equal(await auth.actor(fresh.cookie.split(";")[0]),"tester_01");
 data.records[0].disabled=true;
 assert.equal(await auth.actor(fresh.cookie.split(";")[0]),null);
 assert.equal((await auth.login(replacement,"local")).ok,false);
});

test("invalid codes perform zero expensive hashes; only matched records use at most six bounded jobs",async()=>{
 const data=fixture();let expensive=0,active=0,peak=0;
 const releases:(()=>void)[]=[];
 const auth=createQaAuth({secret,load:async()=>data,derive:async(code,salt)=>{
   expensive++;active++;peak=Math.max(peak,active);
   await new Promise<void>(resolve=>releases.push(resolve));active--;
   return data.records.find(r=>r.salt===salt&&r.codeLookupHash===lookup(code))!.codeHash;
 }});
 for(let i=0;i<100;i++)assert.equal((await auth.login("BAD00000","shared")).ok,false);
 assert.equal(expensive,0);
 const jobs=codes.map(code=>auth.login(code,"shared"));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(expensive,6);
 assert.equal((await auth.login(codes[0],"shared")).status,503);
 assert.equal(expensive,6);assert.equal(peak,6);
 releases.splice(0).forEach(resolve=>resolve());
 assert.ok((await Promise.all(jobs)).every(r=>r.ok));
 const later=auth.login(codes[0],"shared");await new Promise(resolve=>setImmediate(resolve));
 releases.splice(0).forEach(resolve=>resolve());assert.equal((await later).ok,true);
 const broken=fixture();delete (broken.records[0] as Partial<typeof broken.records[0]>).codeLookupHash;
 const legacy=createQaAuth({secret,load:async()=>broken});
 await assert.rejects(()=>legacy.login(codes[0],"shared"),/QA auth file/);
});

test("only failed attempts consume a bounded five-minute bucket; valid code always works",async()=>{
 const data=fixture();let now=1000000;
 const auth=createQaAuth({secret,load:async()=>data,now:()=>now});
 for(let i=0;i<12;i++)assert.equal((await auth.login(codes[0],"shared-ip")).ok,true);
 for(let i=0;i<7;i++)assert.equal((await auth.login("BAD00000","shared-ip")).status,401);
 assert.equal((await auth.login("BAD00000","shared-ip")).status,429);
 assert.equal((await auth.login(codes[1],"shared-ip")).ok,true);
 assert.equal((await auth.login("BAD00000","other-ip")).status,401);
 now+=300001;assert.equal((await auth.login("BAD00000","shared-ip")).status,401);
});

test("invalid QA records and tampered tokens fail closed without legacy fallback",async()=>{
 const data=fixture();const auth=createQaAuth({secret,load:async()=>data});
 const reply=await auth.login(codes[0],"local");assert.ok(reply.ok);if(!reply.ok)return;
 const token=reply.cookie.split(";")[0];
 assert.equal(await auth.actor(token.slice(0,-1)+(token.endsWith("A")?"B":"A")),null);
 data.records[0].sessionVersion=0;
 await assert.rejects(()=>auth.login(codes[0],"local"),/QA auth file/);
 assert.equal(await auth.actor(token),null);
});

test("QA server handler requires code login and versioned cookie, clears logout and preserves read-only gate",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"qa-auth-unit-"));const file=join(directory,"hashes.json");
 const data=fixture();await writeFile(file,JSON.stringify(data));
 let handler:Function|undefined;
 const db={unsafe:async(query:string,args?:unknown[])=>{
   if(query.includes("FROM pg_roles"))return [{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:"on"}];
   if(query.includes("current_database"))return [{db:"toss_v4_test_items_20261018_w01",role:"commerce_v4_reader",port:15440,read_only:"on"}];
   if(query.includes("FROM users"))return [{id:args?.[0],display_name:"Synthetic Tester"}];
   throw Error("unexpected business query");
 },end:async()=>{}};
 try{
  await start(0,{env:{QA_AUTH_ENABLED:"1",QA_AUTH_FILE:file,SESSION_SECRET:secret,
   DATABASE_URL:"postgres://commerce_v4_reader:unit-only@127.0.0.1:15440/toss_v4_test_items_20261018_w01",
   COMMERCE_CATALOG_SOURCE:"test_items",HOST:"127.0.0.1",BRAIN_ENABLED:"0"},
   ensureDevDb:async()=>"",connectDb:(()=>db) as never,build:(async()=>({})) as never,
   createServer:((listener:Function)=>{handler=listener;return {listen:(...args:unknown[])=>(args.at(-1) as Function)(),on:()=>{}};}) as never});
  const invoke=async(method:string,url:string,body?:unknown,cookie?:string,origin="http://127.0.0.1:3119")=>{
   const request=Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{method,url,
    headers:{host:"127.0.0.1:3119",origin,...(cookie?{cookie}:{})},socket:{remoteAddress:"127.0.0.1"}});
   let status=0,headers:Record<string,string>={},content="";
   await handler!(request,{headersSent:false,writeHead:(code:number,h:Record<string,string>)=>{status=code;headers=h;},end:(text:string)=>{content=text;}});
   return {status,headers,json:JSON.parse(content)};
  };
  assert.equal((await invoke("GET","/api/session")).status,401);
  assert.equal((await invoke("POST","/api/session",{code:codes[0]},undefined,"https://attacker.invalid")).status,403);
  const login=await invoke("POST","/api/session",{code:codes[0]});assert.equal(login.status,200);
  assert.equal(login.json.user.id,"tester_01");const cookie=login.headers["set-cookie"].split(";")[0];
  assert.match(login.headers["set-cookie"],/Max-Age=604800/);
  assert.equal((await invoke("GET","/api/session",undefined,cookie)).json.user.id,"tester_01");
  assert.equal((await invoke("POST","/api/cart/items",{actorUserId:"tester_06"},cookie)).status,403);
  assert.equal((await invoke("GET","/api/session",undefined,"session="+signSession("tester_01",secret))).status,401);
  data.records[0].sessionVersion++;await writeFile(file,JSON.stringify(data));
  assert.equal((await invoke("GET","/api/session",undefined,cookie)).status,401);
  assert.match((await invoke("DELETE","/api/session",undefined,cookie)).headers["set-cookie"],/Max-Age=0/);
 }finally{await unlink(file);await rmdir(directory);}
});
