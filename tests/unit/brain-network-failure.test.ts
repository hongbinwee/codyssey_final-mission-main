import test from "node:test";
import assert from "node:assert/strict";
import {liveProvider} from "../../src/llm.ts";
import {config} from "../../src/config.ts";

const messages=[{role:"system" as const,content:"JSON only"},
  {role:"user" as const,content:"모니터 추천"}];
const responseBody={status:"completed",output:[{type:"message",content:[
  {type:"output_text",text:'{"query":"monitor","maxTotalWon":500000,"requiredConditions":[],"currentPreferences":{}}'}
]}]};
test("HTTP 429 with Retry-After fails once without implicit paid retries; explicit new call succeeds",async()=>{
  const original=globalThis.fetch;
  const originalKey=config.llmApiKey;
  const originalModel=config.llmModel;
  const originalBase=config.llmBaseUrl;
  let calls=0;
  try{
    config.llmApiKey="CI-do-not-publish";
    config.llmModel="ci-only";
    config.llmBaseUrl="http://127.0.0.1:1";
    globalThis.fetch=async(_url,_opts)=>{
      calls++;
      if(calls===1)return new Response("no secrets",{status:429,headers:{"Retry-After":"120"}});
      return new Response(JSON.stringify(responseBody),{status:200,headers:{"content-type":"application/json"}});
    };
    const provider=liveProvider();
    await assert.rejects(()=>provider.chat(messages,[]),/LLM http 429/);
    assert.equal(calls,1,"Retry-After must not silently launch extra model calls");
    const second=await provider.chat(messages,[]);
    assert.match(second.content??"",/monitor/);
    assert.equal(calls,2,"second request is explicit");
  }finally{
    globalThis.fetch=original;
    config.llmApiKey=originalKey;
    config.llmModel=originalModel;
    config.llmBaseUrl=originalBase;
  }
});
test("a truly aborted hard timeout fails without answer and subsequent call can recover",async()=>{
  const original=globalThis.fetch;
  const originalTimeout=config.llmApiTimeoutMs;
  const originalKey=config.llmApiKey;
  let calls=0,abortSeen=false;
  try{
    config.llmApiKey="CI-do-not-publish";
    config.llmApiTimeoutMs=35;
    globalThis.fetch=async(_url,opts)=>{
      calls++;
      if(calls>1)return new Response(JSON.stringify(responseBody),{status:200});
      return await new Promise<Response>((_resolve,reject)=>{
        const sig=opts?.signal;
        sig?.addEventListener("abort",()=>{
          abortSeen=true;
          reject(Object.assign(new Error("aborted"),{name:"AbortError"}));
        },{once:true});
        if(sig?.aborted)reject(Error("already aborted"));
      });
    };
    const provider=liveProvider();
    await assert.rejects(()=>provider.chat(messages,[]),/LLM timeout/);
    assert.equal(abortSeen,true,"timeout must abort the pending fetch");
    assert.equal(calls,1,"no automatic retry on timeout");
    const success=await provider.chat(messages,[]);
    assert.match(success.content??"",/maxTotalWon/);
    assert.equal(calls,2);
  }finally{
    globalThis.fetch=original;
    config.llmApiTimeoutMs=originalTimeout;
    config.llmApiKey=originalKey;
  }
});
