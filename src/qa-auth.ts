import {createHmac,scrypt,timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";

type QaRecord={userId:string;salt:string;codeHash:string;codeLookupHash:string;sessionVersion:number;disabled:boolean};
type QaFile={version:1;records:QaRecord[]};
const lifetime=7*24*60*60;
export async function readQaAuthFile(path:string):Promise<QaFile>{
 if(!isAbsolute(path))throw new Error("QA_AUTH_FILE must be absolute");
 return validate(JSON.parse(await readFile(path,"utf8")));
}
function validate(raw:unknown):QaFile{
 const file=raw as QaFile;
 if(!file||file.version!==1||!Array.isArray(file.records)||file.records.length!==6)
   throw new Error("invalid QA auth file");
 const seen=new Set<string>(),lookups=new Set<string>();
 for(const r of file.records){
  if(!r||!/^tester_0[1-6]$/.test(r.userId)||seen.has(r.userId)||
    !/^[a-f0-9]{32}$/.test(r.salt)||!/^[a-f0-9]{64}$/.test(r.codeHash)||
    !/^[a-f0-9]{64}$/.test(r.codeLookupHash)||lookups.has(r.codeLookupHash)||
    !Number.isSafeInteger(r.sessionVersion)||r.sessionVersion<1||typeof r.disabled!=="boolean")
    throw new Error("invalid QA auth file record");
  seen.add(r.userId);
  lookups.add(r.codeLookupHash);
 }
 return file;
}
const equal=(a:string,b:string)=>{
 const aa=Buffer.from(a),bb=Buffer.from(b);
 return aa.length===bb.length&&timingSafeEqual(aa,bb);
};
const hash=(code:string,salt:string)=>new Promise<string>((resolve,reject)=>
 scrypt(code,salt,32,{N:16384,r:8,p:1},(e,key)=>e?reject(e):resolve(key.toString("hex"))));

export function createQaAuth(options:{secret:string;load:()=>Promise<unknown>;now?:()=>number;secure?:boolean;derive?:typeof hash}){
 if(!options.secret.trim())throw new Error("QA SESSION_SECRET required");
 const now=options.now??Date.now;
 const failures=new Map<string,{count:number;until:number}>();
 let activeHashes=0;
 const suffix="; HttpOnly; Path=/; SameSite=Lax"+(options.secure?"; Secure":"");
 const mac=(payload:string)=>createHmac("sha256",options.secret).update("qa1."+payload).digest("base64url");
 return {
  clearCookie:()=>"session=; Max-Age=0"+suffix,
  async login(code:unknown,address:string):Promise<{ok:true;status:200;userId:string;cookie:string}|{ok:false;status:401|429|503;retryAfter?:number}>{
   const file=validate(await options.load());
   const lookup=typeof code==="string"&&/^[A-Z0-9]{8}$/.test(code)
     ?createHmac("sha256",options.secret).update("qa-code:"+code).digest("hex"):null;
   let record=lookup?file.records.find(r=>!r.disabled&&equal(lookup,r.codeLookupHash)):undefined;
   // Unknown codes cost only six HMAC comparisons, even while a cooldown is active.
   // A matched code gets one scrypt, bounded globally with no unbounded waiting queue.
   if(record){
     if(activeHashes>=6)return {ok:false,status:503,retryAfter:1};
     activeHashes++;
     try{
       const derived=await(options.derive??hash)(code as string,record.salt);
       if(!equal(derived,record.codeHash))record=undefined;
     }finally{activeHashes--;}
   }
   if(record){
    const issued=Math.floor(now()/1000);
    const payload=Buffer.from(JSON.stringify({sub:record.userId,sv:record.sessionVersion,iat:issued,exp:issued+lifetime})).toString("base64url");
    return {ok:true,status:200,userId:record.userId,cookie:`session=qa1.${payload}.${mac(payload)}; Max-Age=${lifetime}`+suffix};
   }
   const time=now();
   for(const [key,bucket] of failures)if(bucket.until<=time)failures.delete(key);
   const key=address.slice(0,128)||"unknown";
   let bucket=failures.get(key);
   if(!bucket){
    if(failures.size>=1000)failures.delete(failures.keys().next().value!);
    bucket={count:0,until:time+300000};failures.set(key,bucket);
   }
   bucket.count=Math.min(8,bucket.count+1);
   return bucket.count>=8?{ok:false,status:429,retryAfter:Math.max(1,Math.ceil((bucket.until-time)/1000))}:{ok:false,status:401};
  },
  async actor(cookie:string|undefined):Promise<string|null>{
   try{
    const token=decodeURIComponent(cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1]??"");
    if(token.length>1000)return null;
    const pieces=token.split(".");
    if(pieces.length!==3||pieces[0]!=="qa1"||!equal(mac(pieces[1]),pieces[2]))return null;
    const value=JSON.parse(Buffer.from(pieces[1],"base64url").toString("utf8"));
    const time=Math.floor(now()/1000);
    if(!Number.isSafeInteger(value.exp)||!Number.isSafeInteger(value.iat)||value.iat>time||
      value.exp<=time||value.exp-value.iat!==lifetime)return null;
    const file=validate(await options.load());
    return file.records.some(r=>!r.disabled&&r.userId===value.sub&&r.sessionVersion===value.sv)?value.sub:null;
   }catch{return null;}
  },
 };
}
