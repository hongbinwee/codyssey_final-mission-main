import {useEffect,useState} from "react";
import {apiSafe,newActionKey,fmtWon} from "../api.ts";

type RankedProduct={
 candidate:{productId:string;productName?:string;variantId:string;unitPriceWon:number|null;shippingFeeWon:number|null};
 score:number;evidenceCoverage:number;
};
type LimitedProduct={candidate:{productId:string;productName?:string;variantId:string};reasons:string[]};
type BrainReply={
 conversation_id:string;message_id:string;read_only:true;
 shopping_plan?:{query:string;maxTotalWon:number|null;requiredConditions:string[];revision:number}|null;
 explanation?:{text:string;kind:string;items:{productId:string;evidenceIds:string[]}[];limitations:string[]}|null;
 ranking:{ranked:RankedProduct[];referenceOnly:LimitedProduct[];rejected:LimitedProduct[];evaluatedCount:number};
 trace:{totalMs:number;graphWallMs?:number};
};
type MemoryItem={key:string;value:string;updatedAt:string};
type Entry={text:string;reply?:BrainReply;error?:boolean};

export function BrainPreview({onClose,onOpenProduct}:{onClose:()=>void;onOpenProduct:(id:string)=>void}){
 const [input,setInput]=useState("");
 const [conversation,setConversation]=useState<string|null>(null);
 const [sourceMessage,setSourceMessage]=useState<string|null>(null);
 const [selected,setSelected]=useState<"value"|"balanced"|"performance">("value");
 const [pending,setPending]=useState<string|null>(null);
 const [memories,setMemories]=useState<MemoryItem[]>([]);
 const [entries,setEntries]=useState<Entry[]>([]);
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
   let active=true;
   void apiSafe<MemoryItem[]>("/api/brain/preferences").then(r=>{
     if(active&&r.ok)setMemories(r.data);
   });
   return ()=>{active=false;};
 },[]);

 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");

 const refresh=async()=>{
   const result=await apiSafe<MemoryItem[]>("/api/brain/preferences");
   if(result.ok)setMemories(result.data);
 };
 const send=async()=>{
   const text=input.trim();if(!text||busy)return;
   setBusy(true);setError("");setPending(null);setSourceMessage(null);
   try{
     let id=conversation;
     if(!id){
       const created=await apiSafe<{id:string}>("/api/brain/conversations",{method:"POST",body:"{}"});
       if(!created.ok){setError("대화를 시작할 수 없어요.");return;}
       id=created.data.id;setConversation(id);
     }
     const r=await apiSafe<BrainReply>("/api/brain/conversations/"+encodeURIComponent(id)+"/turn",
       {method:"POST",body:JSON.stringify({user_message:text,client_action_id:newActionKey()})});
     if(!r.ok){
       const friendly=r.error.code==="MODEL_RATE_LIMIT"?
         "AI 모델 요청이 일시적으로 제한됐어요. 잠시 후 같은 질문을 다시 보내 주세요.":
         r.error.code==="MODEL_TIMEOUT"?
         "AI 모델 응답 시간이 초과됐어요. 이전 쇼핑 조건은 유지되니 다시 시도해 주세요.":
         r.error.code==="CONVERSATION_BUSY"?
         "이전 요청 처리 중이에요. 잠시 후 다시 보내 주세요.":
         "Brain 처리를 완료하지 못했어요. 다시 시도해 주세요.";
       setError(friendly);return;
     }
     setEntries(previous=>[...previous,{text,reply:r.data}]);
     setSourceMessage(r.data.message_id);setInput("");
     await refresh();
   }catch{setError("요청 처리 중 문제가 발생했어요.");}
   finally{setBusy(false);}
 };
 const propose=async()=>{
   if(!conversation||!sourceMessage||busy)return;
   setBusy(true);setError("");
   try{
     const r=await apiSafe<{proposal_id:string}>("/api/brain/preferences/proposals",{
       method:"POST",body:JSON.stringify({conversation_id:conversation,source_message_id:sourceMessage,
         key:"price_priority",value:selected})
     });
     if(r.ok)setPending(r.data.proposal_id);else setError("선호 저장 요청을 만들지 못했어요.");
   }catch{setError("네트워크 오류로 선호 저장 요청을 완료하지 못했어요.");}
   finally{setBusy(false);}
 };
 const confirm=async()=>{
   if(!pending||busy)return;
   setBusy(true);setError("");
   try{
     const r=await apiSafe<{key:string;value:string}>("/api/brain/preferences/confirm",{
       method:"POST",body:JSON.stringify({proposal_id:pending})
     });
     if(r.ok){setPending(null);await refresh();}else setError("선호 저장 확인에 실패했어요.");
   }catch{setError("네트워크 오류로 확인하지 못했어요. 다시 확인해 주세요.");}
   finally{setBusy(false);}
 };
 const clear=async()=>{
   if(busy)return;setBusy(true);setError("");setNotice("");
   try{
     const r=await apiSafe<{deleted:boolean}>("/api/brain/preferences/price_priority",{method:"DELETE"});
     if(r.ok){await refresh();setNotice("저장된 장기 가격 선호만 삭제했어요. 이전 대화 메시지와 현재 Shopping Plan은 별도로 보존될 수 있어요.");}else setError("선호 삭제에 실패했어요.");
   }catch{setError("네트워크 오류로 선호 삭제를 완료하지 못했어요.");}
   finally{setBusy(false);}
 };
 return <aside className="agent-panel" aria-label="Shopping Brain Preview">
   <div className="agent-head"><div><b>Shopping Brain Preview</b>
     <div className="muted sm">장기 선호 기반 비교 · 읽기 전용 · 검증되지 않은 후보는 추천하지 않아요</div>
   </div><button className="link" onClick={onClose}>닫기</button></div>
   <div className="agent-body">
    {entries.length===0&&<p className="muted sm">상품 조건을 입력해 주세요. 장기 기억은 아래에서 명시적으로 확인해야 저장됩니다.</p>}
    {entries.map((e,i)=><div key={i} className="msg ai">
      <p><b>질문:</b> {e.text}</p>
      {e.reply&&<>
        {e.reply.shopping_plan&&<p className="muted sm">유지된 구매 조건 · {e.reply.shopping_plan.query} ·  {e.reply.shopping_plan.maxTotalWon===null?"예산 미설정":fmtWon(e.reply.shopping_plan.maxTotalWon)} · {e.reply.shopping_plan.requiredConditions.length?e.reply.shopping_plan.requiredConditions.join(", "):"필수 조건 없음"}</p>}
        {e.reply.explanation&&<p>{e.reply.explanation.text}</p>}
        <p className="muted sm">Brain Graph 처리 시간(서버 측): {Math.round(e.reply.trace.graphWallMs ?? e.reply.trace.totalMs)}ms · 네트워크 전송 시간 제외</p>
        {e.reply.ranking.ranked.length>0
          ?<><p>현재 선호에 따라 비교한 검증 후보</p>{e.reply.ranking.ranked.slice(0,3).map((p,j)=>
              <div key={p.candidate.variantId} className="compare-row">
                <b>{j+1}. {p.candidate.productName ?? p.candidate.productId}</b>
                <span className="muted sm"> · {p.candidate.unitPriceWon===null?"가격 미확인":fmtWon(p.candidate.unitPriceWon)} · 옵션 {p.candidate.variantId}</span>
                <button className="link" onClick={()=>onOpenProduct(p.candidate.productId)}>상품 보기</button>
              </div>)}
            <p className="muted sm">점수는 초기 검증용 휴리스틱이며 최종 사용자 추천 품질을 보증하지 않아요.</p></>
          :<p>추천 적격성을 확인한 상품이 없어요. 데이터·근거가 충분하지 않을 수 있어요.</p>}
        {e.reply.ranking.referenceOnly.length>0&&<div className="muted sm">
          <b>참고 정보 (추천 아님)</b>{e.reply.ranking.referenceOnly.slice(0,3).map((p,j)=>
            <div key={j}>{p.candidate.productName ?? p.candidate.productId} · {p.reasons.join(", ")}</div>)}
        </div>}
        {e.reply.ranking.rejected.length>0&&<p className="muted sm">필수 조건/근거 미충족 후보 {e.reply.ranking.rejected.length}개 제외</p>}
      </>}
    </div>)}
    {sourceMessage&&conversation&&<div className="state-box">
      <b>대화에서 사용할 가격 선호를 장기 기억으로 저장할까요?</b>
      <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value as typeof selected);setPending(null);}}>
        <option value="value">가성비 중심</option><option value="balanced">균형</option><option value="performance">성능 중심</option>
      </select>
      {!pending?<button className="btn" onClick={propose} disabled={busy}>선호 저장 요청</button>
        :<button className="btn primary" onClick={confirm} disabled={busy}>이 선호를 기억하도록 확인</button>}
      <p className="muted sm">선호는 확인 버튼을 눌렀을 때만 저장됩니다.</p>
    </div>}
    {memories.length>0&&<div className="state-box">
      <b>저장된 장기 선호</b>
      {memories.map(m=><div key={m.key} className="muted sm">{m.key}: {m.value}</div>)}
      <button className="link" onClick={clear} disabled={busy}>가격 선호 기억 삭제</button>
    </div>}
    {notice&&<p role="status" className="muted sm">{notice}</p>}
    {error&&<p role="alert">{error}</p>}
    {busy&&<p role="status" className="muted sm">Brain이 데이터를 확인하고 있어요…</p>}
   </div>
   <div className="agent-input">
     <input value={input} disabled={busy} onChange={e=>setInput(e.target.value)}
       onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing)void send();}}
       placeholder="쇼핑 조건을 입력하세요"/>
     <button className="btn primary" disabled={busy||!input.trim()} onClick={()=>void send()}>보내기</button>
   </div>
 </aside>;
}
