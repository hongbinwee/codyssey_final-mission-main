import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createBrainApi} from "../../src/brain/api.ts";
import {assertPreference} from "../../src/brain/memory.ts";

const tsx=readFileSync("src/web/components/BrainPreview.tsx","utf8");
const css=readFileSync("src/web/styles.css","utf8");
const approval="cccccccc-cccc-4ccc-8ccc-cccccccccccc",cid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",msg="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const priceValues=["value","balanced","performance"] as const;

function makeService(){
 const store=new Map<string,string>(),proposals=new Map<string,{actor:string;value:string;consumed:boolean}>();
 let nonce=0;
 const api=createBrainApi({
  conversations:{
   create:async(actorUserId:string)=>({id:cid,actorUserId}),
   assertOwned:async(actorUserId:string)=>{if(actorUserId!=="actor-a")throw Error("conversation is not owned");},
   proposePreference:async(input:{actorUserId:string;conversationId:string;sourceMessageId:string;key:string;value:string})=>{
    assert.equal(input.actorUserId,"actor-a");
    assert.equal(input.conversationId,cid);assert.equal(input.sourceMessageId,msg);
    assert.equal(input.key,"price_priority");assertPreference(input.key as never,input.value as never);
    const id=nonce++===0?approval:"dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    proposals.set(id,{actor:input.actorUserId,value:input.value,consumed:false});
    return id;
   },
   confirmPreference:async(actorUserId:string,proposalId:string)=>{
    const p=proposals.get(proposalId);
    if(!p||p.actor!==actorUserId||p.consumed)throw Error("confirmation expired or not owned");
    p.consumed=true;store.set(actorUserId,p.value);
    return {key:"price_priority" as const,value:p.value as "value"|"balanced"|"performance",userId:actorUserId,
     sourceConversationId:cid,sourceMessageId:msg,updatedAt:"2026-10-20T00:00:00.000Z"};
   }
  },
  preferences:{
   list:async(actorUserId:string)=>{
    const value=store.get(actorUserId);
    return value?[{key:"price_priority" as const,value:value as "value"|"balanced"|"performance",
      userId:actorUserId,sourceConversationId:cid,sourceMessageId:msg,updatedAt:"2026-10-20T00:00:00.000Z"}]:[];
   },
   delete:async(actorUserId:string,key:string)=>key==="price_priority"&&store.delete(actorUserId)
  },
  graph:{invoke:async()=>({conversationId:cid,messageId:msg,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
   trace:{totalMs:0}}),getOwnedState:async()=>({values:{}})}
 } as never);
 return {api,store,proposals};
}
function unbox<T>(response:Awaited<ReturnType<ReturnType<typeof createBrainApi>>>) {
 assert.equal(response.body.ok,true);
 return (response.body as {ok:true;data:T}).data;
}

test("QA11 displayed copy is user-facing and the internal preference keys are unchanged",()=>{
 assert.match(tsx,/이 가격 기준을 기억해둘까요\?/);
 assert.match(tsx,/다음 상품 추천에도 선택한 기준을 반영할 수 있어요/);
 for(const value of priceValues)assert.match(tsx,new RegExp('<option value="'+value+'">'));
 for(const word of ["가성비를 우선해요","가격과 품질을 균형 있게 봐요","품질을 더 중요하게 생각해요",
  "저장하기","저장 확인","취소","원할 때 저장하고, 나중에 바꿀 수 있어요"])
  assert.ok(tsx.includes(word),word);
 assert.doesNotMatch(tsx,/가격 선호를 장기 기억으로 저장할까요\?|선호 저장 요청|이 선호를 기억하도록 확인/);
});
test("QA11 preference card stacks field and compact confirm buttons with responsive min sizes",()=>{
 assert.match(tsx,/className="state-box brain-preference-save"/);
 assert.match(tsx,/className="brain-preference-intro"/);
 assert.match(tsx,/className="brain-preference-field"/);
 assert.match(tsx,/className="brain-preference-actions"/);
 assert.match(css,/\.brain-panel \.brain-preference-save\{[\s\S]*?display:grid/);
 assert.match(css,/\.brain-panel \.brain-preference-field select\{[\s\S]*?min-height:44px/);
 assert.match(css,/\.brain-panel \.brain-preference-actions \.btn\{[\s\S]*?min-height:44px/);
 assert.match(css,/@media\(max-width:420px\)\{\s*\.brain-panel \.brain-preference-save/);
 assert.match(css,/flex-wrap:wrap/);
});
test("QA11 stored preference retry and delete controls retain native buttons and 44px touch targets at narrow widths",()=>{
 assert.match(tsx,/<button className="link brain-preference-retry" disabled=\{busy\|\|restoring\}/);
 assert.match(tsx,/<button className="link" onClick=\{\(\)=>void clear\(\)\} disabled=\{busy\|\|restoring\}>저장한 가격 기준 삭제<\/button>/);
 assert.match(css,/\.brain-panel \.brain-memory \.link\{[^}]*min-height:44px/);
 assert.match(css,/\.brain-panel \.brain-preference-retry\{[^}]*min-height:44px/);
 assert.match(css,/\.brain-panel \.brain-memory \.link\{[^}]*width:fit-content[^}]*max-width:100%[^}]*white-space:normal/);
 assert.match(css,/\.brain-panel \.brain-preference-retry\{[^}]*width:fit-content[^}]*max-width:100%[^}]*white-space:normal/);
 assert.match(css,/@media\(max-width:420px\)\{[\s\S]*?\.brain-panel \.brain-preference-actions \.btn\{max-width:100%\}/);
});
test("QA11 core shopping CTAs render before the secondary preference save card",()=>{
 assert.ok(tsx.indexOf('{showExplore&&!busy&&')<tsx.indexOf('className="state-box brain-preference-save"'));
 assert.match(tsx,/조건 바꾸기/);assert.match(tsx,/다른 상품 보기/);
});
test("QA11 UI checks saved value, synchronizes persisted selection, prevents redundant propose",()=>{
 assert.match(tsx,/const storedPrice=memories\.find\(m=>m\.key==="price_priority"\)\?\.value/);
 assert.match(tsx,/const alreadySaved=storedPrice===selected/);
 assert.match(tsx,/setSelected\(preference\.value as typeof selected\)/);
 assert.match(tsx,/!preferencesReady\|\|alreadySaved\)return/);
 assert.match(tsx,/alreadySaved\?<p role="status"/);
 assert.match(tsx,/disabled=\{busy\|\|restoring\|\|!preferencesReady/);
 assert.match(tsx,/storedPrice&&<button[^>]*onClick=\{\(\)=>void clear\(\)\}/);
});
test("QA11 selection change invalidates pending proposal and approval only persists matching value",()=>{
 assert.match(tsx,/setSelected\(e\.target\.value as typeof selected\);setPending\(null\);setPendingValue\(null\)/);
 assert.match(tsx,/setPendingValue\(value\)/);
 assert.match(tsx,/if\(!pending\|\|!pendingValue\|\|lock\.current\)return/);
 assert.match(tsx,/r\.data\.key==="price_priority"&&r\.data\.value===expected/);
 assert.match(tsx,/\/api\/brain\/preferences\/proposals/);
 assert.match(tsx,/\/api\/brain\/preferences\/confirm/);
 assert.match(tsx,/setPending\(null\);setPendingValue\(null\)/);
 assert.match(tsx,/lock\.current=true;setBusy\(true\)/);
});
test("QA11 uncertain confirmation reconciles persisted memory rather than overwriting it or claiming a fresh write",()=>{
 assert.match(tsx,/A consumed confirmation or a lost HTTP reply may already be committed/);
 assert.match(tsx,/synced\.ok&&synced\.data\.some\(m=>m\.key==="price_priority"&&m\.value===expected\)/);
 assert.match(tsx,/r\.error\.code==="CONFIRMATION_REQUIRED"/);
 assert.match(tsx,/setPreferencesReady\(result\.ok\)/);
 assert.match(tsx,/저장된 선호 다시 확인/);
});
test("QA11 proposal alone does not persist; final confirmation writes exact selected code",async()=>{
 for(const value of priceValues){
  const {api,store}=makeService();
  const proposed=await api("POST","/api/brain/preferences/proposals","actor-a",{
    conversation_id:cid,source_message_id:msg,key:"price_priority",value
  });
  assert.equal(proposed.status,201);
  assert.deepEqual(unbox<unknown[]>(await api("GET","/api/brain/preferences","actor-a",{})),[]);
  assert.equal(store.size,0);
  const id=unbox<{proposal_id:string}>(proposed).proposal_id;
  const confirmed=await api("POST","/api/brain/preferences/confirm","actor-a",{proposal_id:id});
  assert.equal(confirmed.status,200);
  assert.equal(unbox<{value:string}>(confirmed).value,value);
  assert.equal(store.get("actor-a"),value);
  const stored=unbox<Array<{value:string}>>(await api("GET","/api/brain/preferences","actor-a",{}));
  assert.equal(stored[0].value,value);
 }
});
test("QA11 duplicate confirmation and unauthorized actor cannot reapply previous proposal",async()=>{
 const {api,store}=makeService();
 const proposal=await api("POST","/api/brain/preferences/proposals","actor-a",{
  conversation_id:cid,source_message_id:msg,key:"price_priority",value:"balanced"});
 const id=unbox<{proposal_id:string}>(proposal).proposal_id;
 const stolen=await api("POST","/api/brain/preferences/confirm","actor-b",{proposal_id:id});
 assert.notEqual(stolen.status,200);
 assert.equal(store.size,0);
 const approved=await api("POST","/api/brain/preferences/confirm","actor-a",{proposal_id:id});
 assert.equal(approved.status,200);
 const replay=await api("POST","/api/brain/preferences/confirm","actor-a",{proposal_id:id});
 assert.notEqual(replay.status,200);
 assert.equal(store.get("actor-a"),"balanced");
});
test("QA11 can update a confirmed preference via a new approval and delete without touching other actors",async()=>{
 const {api,store}=makeService();
 const save=async(value:"value"|"balanced"|"performance")=>{
  const request=await api("POST","/api/brain/preferences/proposals","actor-a",{
   conversation_id:cid,source_message_id:msg,key:"price_priority",value});
  const token=unbox<{proposal_id:string}>(request).proposal_id;
  assert.equal((await api("POST","/api/brain/preferences/confirm","actor-a",{proposal_id:token})).status,200);
 };
 await save("value");
 await save("performance");
 assert.equal(store.get("actor-a"),"performance");
 store.set("actor-b","balanced");
 const deleted=await api("DELETE","/api/brain/preferences/price_priority","actor-a",{});
 assert.equal(deleted.status,200);
 assert.equal(store.has("actor-a"),false);
 assert.equal(store.get("actor-b"),"balanced");
});
