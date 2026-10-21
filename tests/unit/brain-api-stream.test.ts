import test from "node:test";
import assert from "node:assert/strict";
import {apiTurnSafe,type ApiResult} from "../../src/web/api.ts";

type Reply={conversation_id:string;message_id:string;read_only:true;answer:string};
const reply=(id:string,message:string):Reply=>({conversation_id:id,message_id:message,read_only:true,answer:message});
const envelope=(data:Reply)=>({ok:true as const,data});
const event=(type:"preview"|"complete",response:ApiResult<Reply>)=>JSON.stringify({type,response})+"\n";
function streamResponse(chunks:Uint8Array[],contentType="application/x-ndjson"){
 return new Response(new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}),
  {headers:{"content-type":contentType}});
}
function bytes(text:string){return new TextEncoder().encode(text);}

test("apiTurnSafe opts in once and decodes split UTF-8 and event lines before returning complete",async()=>{
 const original=globalThis.fetch;let calls=0;let accept="";
 const wire=bytes(event("preview",envelope(reply("c1","추천 설명 정리 중")))+
  event("complete",envelope(reply("c1","최종 추천 설명"))));
 globalThis.fetch=async(_input,init)=>{
  calls++;accept=new Headers(init?.headers).get("accept")??"";
  return streamResponse([wire.slice(0,13),wire.slice(13,31),wire.slice(31,wire.length-2),wire.slice(wire.length-2)]);
 };
 try{
  const previews:Reply[]=[];
  const result=await apiTurnSafe<Reply>("/api/brain/conversations/c1/turn",{method:"POST",body:"{}"},value=>previews.push(value));
  assert.equal(calls,1);assert.equal(accept,"application/x-ndjson");
  assert.deepEqual(previews,[reply("c1","추천 설명 정리 중")]);
  assert.deepEqual(result,envelope(reply("c1","최종 추천 설명")));
 }finally{globalThis.fetch=original;}
});

test("apiTurnSafe accepts the existing JSON envelope when streaming is unavailable",async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify(envelope(reply("c1","일반 응답"))),
  {headers:{"content-type":"application/json"}});
 try{
  assert.deepEqual(await apiTurnSafe<Reply>("/turn",{method:"POST"}),envelope(reply("c1","일반 응답")));
 }finally{globalThis.fetch=original;}
});

test("preview without complete is a failed response and never a final success",async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>streamResponse([bytes(event("preview",envelope(reply("c1","먼저 확인한 추천"))))]);
 try{
  const previews:Reply[]=[];
  const result=await apiTurnSafe<Reply>("/turn",{method:"POST"},value=>previews.push(value));
  assert.equal(previews.length,1);assert.equal(result.ok,false);
  if(!result.ok)assert.equal(result.error.code,"BAD_RESPONSE");
 }finally{globalThis.fetch=original;}
});

test("malformed events, changing conversation IDs, and oversized streams fail closed",async(t)=>{
 const original=globalThis.fetch;
 const cases:[string,()=>Response][]=[
  ["unknown event",()=>streamResponse([bytes(JSON.stringify({type:"other",response:envelope(reply("c1","x"))})+"\n")])],
  ["duplicate preview",()=>streamResponse([bytes(event("preview",envelope(reply("c1","x")))+
    event("preview",envelope(reply("c1","y")))+event("complete",envelope(reply("c1","z"))))])],
  ["changed conversation",()=>streamResponse([bytes(event("preview",envelope(reply("c1","x")))+
    event("complete",envelope(reply("c2","y"))))])],
  ["duplicate complete",()=>streamResponse([bytes(event("complete",envelope(reply("c1","x")))+
    event("complete",envelope(reply("c1","y"))))])],
  ["invalid envelope",()=>streamResponse([bytes(JSON.stringify({type:"preview",response:{ok:true}})+"\n")])],
  ["missing final",()=>streamResponse([bytes(event("preview",envelope(reply("c1","x"))))])],
  ["oversize",()=>new Response(bytes(" ".repeat(5*1024*1024)),{headers:{"content-type":"application/json"}})],
 ];
 for(const [name,response] of cases){
  await t.test(name,async()=>{
   globalThis.fetch=async()=>response();
   const result=await apiTurnSafe<Reply>("/turn",{method:"POST"});
   assert.equal(result.ok,false);
   if(!result.ok)assert.equal(result.error.code,"BAD_RESPONSE");
  });
 }
 globalThis.fetch=original;
});
