import type {MemoryRepository,Preference,PreferenceKey,PreferenceProofPort,PreferenceValue} from "./contracts.ts";
const allowed:Record<PreferenceKey,readonly PreferenceValue[]>={
  price_priority:["value","balanced","performance"],eye_comfort:["important","normal"],noise_sensitivity:["important","normal"]
};
const nonempty=(s:string)=>typeof s==="string"&&s.trim().length>0;
export function assertPreference(key:PreferenceKey,value:PreferenceValue):void {
  if(!Object.hasOwn(allowed,key)||!allowed[key].includes(value)) throw new Error("invalid preference");
}
/** Provenance must be authenticated by a server-owned proof port, not a caller's boolean. */
export async function rememberExplicitPreference(repository:MemoryRepository,proof:PreferenceProofPort,cmd:{
 actorUserId:string;key:PreferenceKey;value:PreferenceValue;conversationId:string;userMessageId:string;confirmationId:string;now?:string
}):Promise<void>{
 if(![cmd.actorUserId,cmd.conversationId,cmd.userMessageId,cmd.confirmationId].every(nonempty)) throw new Error("verified preference source required");
 assertPreference(cmd.key,cmd.value);
 if(!await proof.verify(cmd)) throw new Error("source ownership or explicit confirmation missing");
 const updatedAt=cmd.now??new Date().toISOString();
 if(!Number.isFinite(Date.parse(updatedAt))) throw new Error("invalid timestamp");
 await repository.put({userId:cmd.actorUserId,key:cmd.key,value:cmd.value,sourceConversationId:cmd.conversationId,sourceMessageId:cmd.userMessageId,updatedAt});
}
/** In-memory test double ONLY: not durable, no real confirmation verifier. */
export class InMemoryMemoryRepository implements MemoryRepository {
 private rows=new Map<string,Map<PreferenceKey,Preference>>();
 async list(userId:string):Promise<Preference[]>{
  if(!nonempty(userId)) throw new Error("actor required");
  return [...(this.rows.get(userId)?.values()??[])].map(p=>({...p}));
 }
 async put(p:Preference):Promise<void>{
  if(![p.userId,p.sourceConversationId,p.sourceMessageId].every(nonempty)) throw new Error("invalid source");
  assertPreference(p.key,p.value);
  const own=this.rows.get(p.userId)??new Map<PreferenceKey,Preference>();
  own.set(p.key,{...p});this.rows.set(p.userId,own);
 }
 async delete(userId:string,key:PreferenceKey):Promise<boolean>{
  if(!nonempty(userId)||!Object.hasOwn(allowed,key)) throw new Error("invalid identity/key");
  return this.rows.get(userId)?.delete(key)??false;
 }
}
