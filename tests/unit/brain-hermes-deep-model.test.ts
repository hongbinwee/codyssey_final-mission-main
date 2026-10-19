import test from "node:test";
import assert from "node:assert/strict";
import {hermesDeepProvider,liveProvider} from "../../src/llm.ts";

const gateway="https://example.test/v1";
const deepEnv={HERMES_DEEP_MODEL:"claude-opus-4-8",HERMES_DEEP_API_KEY:"deep-test-key",
 HERMES_DEEP_BASE_URL:gateway,HERMES_DEEP_API_FORMAT:"anthropic_messages"};

function mockMessages(){
 const calls:Array<{url:string;headers:Record<string,string>;body:Record<string,unknown>}>=[];
 const saved=globalThis.fetch;
 globalThis.fetch=(async(url:string|URL|Request,init?:RequestInit)=>{
  const headers=init?.headers as Record<string,string>;
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  calls.push({url:String(url),headers,body});
  return new Response(JSON.stringify({
   type:"message",role:"assistant",content:[{type:"text",text:"확인"}],stop_reason:"end_turn"
  }),{status:200,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
 return {calls,restore:()=>{globalThis.fetch=saved;}};
}

test("Hermes Opus defaults to low adaptive effort and uses only its Deep credentials",async()=>{
 const mock=mockMessages();
 try{
  const p=hermesDeepProvider(deepEnv);
  assert.equal(p.name,"live:claude-opus-4-8");
  const result=await p.chat([{role:"user",content:"상품 비교"}],[]);
  assert.equal(result.content,"확인");
  assert.equal(mock.calls.length,1);
  assert.equal(mock.calls[0].url,gateway+"/messages");
  assert.equal(mock.calls[0].headers["x-api-key"],"deep-test-key");
  assert.deepEqual(mock.calls[0].body.thinking,{type:"adaptive"});
  assert.deepEqual(mock.calls[0].body.output_config,{effort:"low"});
 }finally{mock.restore();}
});

test("Hermes medium/high overrides and Fast credentials remain independent",async()=>{
 const mock=mockMessages();
 try{
  for(const effort of ["medium","high"]){
   await hermesDeepProvider({...deepEnv,HERMES_DEEP_EFFORT:effort}).chat([{role:"user",content:"비교"}],[]);
  }
  await liveProvider("claude-sonnet-4",{apiKey:"fast-test-key",baseUrl:gateway,
   apiFormat:"anthropic_messages",anthropicThinking:"",anthropicEffort:""}).chat([{role:"user",content:"안녕"}],[]);
  assert.deepEqual(mock.calls.slice(0,2).map(x=>(x.body.output_config as {effort:string}).effort),["medium","high"]);
  assert.equal(mock.calls[2].headers["x-api-key"],"fast-test-key");
  assert.equal(mock.calls[2].body.thinking,undefined);
 }finally{mock.restore();}
});

test("Reject invalid effort, format and insecure Deep gateway before any network request",()=>{
 assert.throws(()=>hermesDeepProvider({...deepEnv,HERMES_DEEP_EFFORT:"extreme"}),/HERMES_DEEP_EFFORT/);
 assert.throws(()=>hermesDeepProvider({...deepEnv,HERMES_DEEP_API_FORMAT:"chat_completions",
  HERMES_DEEP_EFFORT:"medium"}),/HERMES_DEEP_EFFORT/);
 assert.throws(()=>hermesDeepProvider({...deepEnv,HERMES_DEEP_BASE_URL:"http://untrusted.test/v1"}),/HTTPS/);
});
