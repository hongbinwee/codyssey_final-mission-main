import test from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingHttpHeaders,ServerResponse} from 'node:http';
import type {BrainApiResponse} from '../../src/brain/api.ts';
import {sendBrainReply} from '../../src/brain/turn-stream.ts';

class FakeResponse{
 statusCode?:number;headers?:Record<string,string>;headersSent=false;destroyed=false;writableEnded=false;
 writes:string[]=[];endBody?:string;throwNextWrite=false;
 writeHead(statusCode:number,headers:Record<string,string>){
  this.statusCode=statusCode;this.headers=headers;this.headersSent=true;return this;
 }
 write(chunk:string){
  if(this.throwNextWrite){this.throwNextWrite=false;throw new Error('socket closed');}
  if(this.destroyed||this.writableEnded)throw new Error('response closed');
  this.writes.push(chunk);return true;
 }
 end(chunk?:string){
  if(chunk!==undefined)this.endBody=chunk;
  this.writableEnded=true;return this;
 }
 destroy(){this.destroyed=true;return this;}
 asServerResponse(){return this as unknown as ServerResponse;}
 jsonBody(){return JSON.parse(this.endBody??'') as unknown;}
 ndjson(){return this.writes.flatMap(chunk=>chunk.split('\n').filter(Boolean)).map(line=>JSON.parse(line) as unknown);}
}

const acceptedHeaders:IncomingHttpHeaders={accept:'application/x-ndjson'};
const preview:BrainApiResponse={status:200,body:{ok:true,data:{message_id:'m-preview',preview:true}}};
const complete:BrainApiResponse={status:200,body:{ok:true,data:{message_id:'m-final',answer:'완료'}}};
const validation:BrainApiResponse={status:422,body:{ok:false,error:{code:'VALIDATION',message:'요청을 확인해 주세요'}}};
const unavailable:BrainApiResponse={status:503,body:{ok:false,error:{code:'BRAIN_UNAVAILABLE',message:'Brain 요청을 처리하지 못했습니다'}}};
const runRequest={method:'POST',headers:acceptedHeaders};

test('writes a valid preview before the deferred final result resolves',async()=>{
 const response=new FakeResponse();
 let finish:(reply:BrainApiResponse)=>void=()=>{throw new Error('run not started');};
 const pending=new Promise<BrainApiResponse>(resolve=>{finish=resolve;});
 const sending=sendBrainReply(runRequest,response.asServerResponse(),async onPreview=>{
  onPreview?.(preview);
  return pending;
 },true);
 assert.equal(response.statusCode,200);
 assert.equal(response.headers?.['content-type'],'application/x-ndjson; charset=utf-8');
 assert.deepEqual(response.ndjson(),[{type:'preview',response:preview.body}]);
 assert.equal(response.writableEnded,false);
 finish(complete);
 await sending;
 assert.deepEqual(response.ndjson(),[
  {type:'preview',response:preview.body},
  {type:'complete',response:complete.body},
 ]);
 assert.equal(response.writableEnded,true);
});

test('non streaming clients keep the ordinary status and JSON response',async()=>{
 const response=new FakeResponse();
 await sendBrainReply({method:'POST',headers:{accept:'application/json'}},response.asServerResponse(),async onPreview=>{
  assert.equal(onPreview,undefined);
  return validation;
 },true);
 assert.equal(response.statusCode,422);
 assert.equal(response.headers?.['content-type'],'application/json; charset=utf-8');
 assert.deepEqual(response.jsonBody(),validation.body);
 assert.deepEqual(response.writes,[]);
});

test('preview permission and POST method are both required for NDJSON',async()=>{
 for(const [allowPreview,method] of [[false,'POST'],[true,'GET']] as const){
  const response=new FakeResponse();
  await sendBrainReply({method,headers:acceptedHeaders},response.asServerResponse(),async onPreview=>{
   assert.equal(onPreview,undefined);
   return complete;
  },allowPreview);
  assert.equal(response.headers?.['content-type'],'application/json; charset=utf-8');
  assert.deepEqual(response.jsonBody(),complete.body);
 }
});

test('accepts an explicit NDJSON media type in an Accept list',async()=>{
 const response=new FakeResponse();
 await sendBrainReply({method:'POST',headers:{accept:'application/json, application/x-ndjson; q=0.8'}},
  response.asServerResponse(),async onPreview=>{onPreview?.(preview);return complete;},true);
 assert.deepEqual(response.ndjson(),[
  {type:'preview',response:preview.body},{type:'complete',response:complete.body},
 ]);
});

test('an NDJSON media type with q=0 does not opt into streaming',async()=>{
 const response=new FakeResponse();
 await sendBrainReply({method:'POST',headers:{accept:'application/x-ndjson; q=0'}},
  response.asServerResponse(),async onPreview=>{assert.equal(onPreview,undefined);return complete;},true);
 assert.equal(response.headers?.['content-type'],'application/json; charset=utf-8');
 assert.deepEqual(response.jsonBody(),complete.body);
});

test('invalid and duplicate preview callbacks are ignored and callbacks after completion are blocked',async()=>{
 const response=new FakeResponse();let latePreview:((reply:BrainApiResponse)=>void)|undefined;
 await sendBrainReply(runRequest,response.asServerResponse(),async onPreview=>{
  latePreview=onPreview;
  onPreview?.({...preview,status:202});
  onPreview?.({...preview,body:{ok:false,error:{code:'MODEL_TIMEOUT',message:'timeout'}}});
  onPreview?.(preview);onPreview?.(preview);
  return complete;
 },true);
 latePreview?.(preview);
 assert.deepEqual(response.ndjson(),[
  {type:'preview',response:preview.body},{type:'complete',response:complete.body},
 ]);
});

test('a graph error before preview preserves its original HTTP status and JSON envelope',async()=>{
 const response=new FakeResponse();
 await sendBrainReply(runRequest,response.asServerResponse(),async()=>unavailable,true);
 assert.equal(response.statusCode,503);
 assert.deepEqual(response.jsonBody(),unavailable.body);
 assert.deepEqual(response.writes,[]);
});

test('an error after preview is sent as a complete error envelope on the NDJSON stream',async()=>{
 const response=new FakeResponse();
 await sendBrainReply(runRequest,response.asServerResponse(),async onPreview=>{
  onPreview?.(preview);return unavailable;
 },true);
 assert.equal(response.statusCode,200);
 assert.deepEqual(response.ndjson(),[
  {type:'preview',response:preview.body},{type:'complete',response:unavailable.body},
 ]);
});

test('a rejected run after preview becomes a safe complete error envelope',async()=>{
 const response=new FakeResponse();
 await sendBrainReply(runRequest,response.asServerResponse(),async onPreview=>{
  onPreview?.(preview);throw new Error('private provider credential');
 },true);
 assert.deepEqual(response.ndjson(),[
  {type:'preview',response:preview.body},{type:'complete',response:unavailable.body},
 ]);
 assert.doesNotMatch(response.writes.join(''),/private provider credential/);
});

test('preview write exceptions never prevent the run callback from completing',async()=>{
 const response=new FakeResponse();response.throwNextWrite=true;let graphFinished=false;
 await sendBrainReply(runRequest,response.asServerResponse(),async onPreview=>{
  onPreview?.(preview);
  graphFinished=true;
  return complete;
 },true);
 assert.equal(graphFinished,true);
 assert.equal(response.writableEnded,true);
 assert.deepEqual(response.ndjson(),[{type:'complete',response:complete.body}]);
});

test('destroyed or ended responses do not receive writes',async()=>{
 const destroyed=new FakeResponse();destroyed.destroyed=true;
 await sendBrainReply(runRequest,destroyed.asServerResponse(),async onPreview=>{
  onPreview?.(preview);return complete;
 },true);
 assert.deepEqual(destroyed.writes,[]);assert.equal(destroyed.headersSent,false);
 const ended=new FakeResponse();ended.writableEnded=true;
 await sendBrainReply(runRequest,ended.asServerResponse(),async onPreview=>{
  onPreview?.(preview);return complete;
 },true);
 assert.deepEqual(ended.writes,[]);assert.equal(ended.headersSent,false);
});

test('a rejected run is returned as a safe JSON failure before preview',async()=>{
 const response=new FakeResponse();
 await sendBrainReply(runRequest,response.asServerResponse(),async()=>{throw new Error('private model token');},true);
 assert.equal(response.statusCode,503);
 assert.deepEqual(response.jsonBody(),unavailable.body);
 assert.doesNotMatch(response.endBody??'',/private model token/);
});

