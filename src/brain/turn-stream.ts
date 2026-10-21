import type {IncomingHttpHeaders,ServerResponse} from "node:http";
import type {BrainApiResponse} from "./api.ts";

const JSON_HEADERS={"content-type":"application/json; charset=utf-8"};
const STREAM_HEADERS={
 "content-type":"application/x-ndjson; charset=utf-8",
 "cache-control":"no-store, no-transform",
 "x-accel-buffering":"no",
};
const unavailable:BrainApiResponse={status:503,body:{ok:false,error:{
 code:"BRAIN_UNAVAILABLE",message:"Brain 요청을 처리하지 못했습니다",
}}};

function acceptsNdjson(headers:IncomingHttpHeaders):boolean{
 const values=Array.isArray(headers.accept)?headers.accept:[headers.accept];
 return values.some(value=>typeof value==="string"&&value.split(",").some(entry=>{
  const [mediaType,...parameters]=entry.trim().split(";");
  if(mediaType?.trim().toLowerCase()!=="application/x-ndjson")return false;
  const quality=parameters.find(parameter=>/^\s*q\s*=/i.test(parameter));
  if(!quality)return true;
  const score=Number(quality.split("=",2)[1]?.trim());
  return Number.isFinite(score)&&score>0;
 }));
}

function validPreview(reply:BrainApiResponse):boolean{
 return !!reply&&reply.status===200&&reply.body!==null&&typeof reply.body==="object"&&reply.body.ok===true;
}

/** Writes the normal Brain JSON reply, or opt-in NDJSON preview/complete envelopes. */
export async function sendBrainReply(
 req:{method?:string;headers:IncomingHttpHeaders},
 res:ServerResponse,
 run:(onPreview?:(reply:BrainApiResponse)=>void)=>Promise<BrainApiResponse>,
 allowPreview:boolean,
):Promise<void>{
 const streamingAllowed=allowPreview&&req.method==="POST"&&acceptsNdjson(req.headers);
 let streaming=false,previewClaimed=false,finished=false;
 const onPreview=(reply:BrainApiResponse):void=>{
  if(finished||previewClaimed||!validPreview(reply)||res.destroyed||res.writableEnded)return;
  previewClaimed=true;
  try{
   if(!streaming){
    res.writeHead(200,STREAM_HEADERS);
    streaming=true;
   }
   if(!res.destroyed&&!res.writableEnded)
    res.write(JSON.stringify({type:"preview",response:reply.body})+"\n");
  }catch{
   // A disconnected client must not interrupt graph execution or persistence.
  }
 };

 let reply:BrainApiResponse;
 try{reply=await run(streamingAllowed?onPreview:undefined);}
 catch{reply=unavailable;}
 finished=true;
 if(res.destroyed||res.writableEnded)return;

 if(streaming){
  try{
   if(!res.destroyed&&!res.writableEnded){
    res.write(JSON.stringify({type:"complete",response:reply.body})+"\n");
    res.end();
   }
  }catch{
   // The graph has completed; a transport failure must not replace its result.
  }
  return;
 }

 try{
  if(!res.destroyed&&!res.writableEnded){
   res.writeHead(reply.status,JSON_HEADERS);
   res.end(JSON.stringify(reply.body));
  }
 }catch{
  // The response is already unusable; there is no second response to send.
 }
}
