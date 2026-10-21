/** Browser CSRF boundary for authenticated Brain mutations.
 * Never infer a public origin from untrusted Forwarded/X-Forwarded-* headers.
 * For non-loopback deployment BRAIN_PUBLIC_ORIGIN MUST be explicitly configured.
 */
export type BrainMutationHeaders={
 host?:string|string[];origin?:string|string[];referer?:string|string[];
 cookie?:string|string[];authorization?:string|string[];
 "sec-fetch-site"?:string|string[]
};
const header=(v:string|string[]|undefined)=>typeof v==="string"?v:null;
function expectedOrigin(host:string|null,configured?:string):string|null{
 if(configured){
   try{
     const url=new URL(configured);
     if(!["https:","http:"].includes(url.protocol)||url.username||url.password||
        url.pathname!=="/"||url.search||url.hash||url.origin!==configured.replace(/\/$/,""))
       return null;
     if(url.protocol!=="https:"&&
        !["localhost","127.0.0.1","[::1]"].includes(url.hostname))
       return null;
     return url.origin;
   }catch{return null;}
 }
 if(!host)return null;
 try{
   const value=new URL("http://"+host);
   if(!["localhost","127.0.0.1","[::1]"].includes(value.hostname))
     return null;
   return value.origin;
 }catch{return null;}
}
export function brainMutationAllowed(headers:BrainMutationHeaders,publicOrigin?:string):boolean{
 const host=header(headers.host);
 const allow=expectedOrigin(host,publicOrigin);
 if(!allow)return false;
 if(publicOrigin){
   // A host-header injection must not override the configured public host.
   if(!host||new URL(allow).host!==host)return false;
 }
 const site=header(headers["sec-fetch-site"]);
 if(site==="cross-site"||site==="same-site"||site==="none")return false;
 const origin=header(headers.origin),ref=header(headers.referer);
 if(origin!==null){
   try{return new URL(origin).origin===allow&&new URL(origin).href===allow+"/";}catch{return false;}
 }
 if(ref!==null){
   try{return new URL(ref).origin===allow;}catch{return false;}
 }
 // Bearer-token-only API clients cannot have bearer credentials attached by
 // the browser automatically. Require no Cookie to prevent mixed auth bypass.
 const auth=header(headers.authorization);
 const cookie=header(headers.cookie);
 return !!auth?.startsWith("Bearer ")&&!cookie&&site!== "cross-site";
}
