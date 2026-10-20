import {useEffect,useRef,useState} from "react";
import {apiSafe,newActionKey,fmtWon} from "../api.ts";
import {resolveBrainInterviewState} from "../brain-interview-state.ts";
import {BrainAnswer} from './BrainAnswer.tsx';
import type {WishlistView} from "../../brain/wishlist-task.ts";
import type {ShoppingHandoff} from "../../brain/shopping-handoff.ts";

type ProductCandidate={
 productId:string;productName?:string;variantId:string;productImage?:string;keywords?:string[];
 unitPriceWon?:number|null;shippingFeeWon?:number|null;
 rating?:number|null;ratingScale?:number|null;wholeReviewCount?:number|null;wholeReviewCountVerified?:boolean;
 sourceKind?:"REAL"|"SYNTHETIC";datasetVersion?:string;commerceVerified?:boolean;isSimulated?:boolean;
};
type RankedProduct={candidate:ProductCandidate;score:number;evidenceCoverage:number;recommendationRole?:"PERSONALIZED"|"REVIEW_VERIFIED"|"ALTERNATIVE";personalizationSignals?:("CART"|"WISHLIST"|"PURCHASE")[]};
type LimitedProduct={candidate:ProductCandidate;reasons:string[]};
type BrainRankingResult={ranked:RankedProduct[];referenceOnly:LimitedProduct[];rejected:LimitedProduct[];evaluatedCount:number};
type BrainReply={
 conversation_id:string;message_id:string;read_only:true;intent_kind?:string;
 shopping_plan?:{query:string;maxTotalWon:number|null;requiredConditions:string[];revision:number;attributePreferences?:string[]}|null;
 agent_ui?:WishlistView|null;
 shopping_handoffs?:ShoppingHandoff[];
 review_summary?:{productId:string;name:string;sampled:number;totalMatching:number;
  citations:{sourceId:string;quote:string;sourceKind:"REAL"|"SYNTHETIC";sourceVariantId:string|null}[]}|null;
 explanation?:{text:string;kind:string;items:{productId:string;variantId?:string;evidenceIds:string[];reason?:string}[];clarification?:{questions:{key:string;text:string;choices:string[]}[]};limitations:string[];
   failure?:{code:string;httpStatus?:number}}|null;
 ranking:BrainRankingResult;trace:{totalMs:number;graphWallMs?:number};
};
type MemoryItem={key:string;value:string;updatedAt:string};
type Entry={text:string;clientActionId?:string;conversationId?:string;reply?:BrainReply;status?:"sending"|"failed"|"completed";failure?:string};
type History={conversationId:string|null;entries:Entry[]};
type Conversation={id:string;title:string|null;createdAt:string};
const priceLabels:Record<string,string>={value:"가성비 중심",balanced:"균형",performance:"성능 중심",important:"중요",normal:"보통"};
const preferenceLabels:Record<string,string>={price_priority:"가격 선호",eye_comfort:"눈의 편안함",noise_sensitivity:"소음 선호"};
const friendlyFailure=(code:string)=>code==="MODEL_TIMEOUT"?"AI 응답이 늦어지고 있어요. 질문과 기존 조건은 보존했어요.":
 code==="RETRIEVAL_UNAVAILABLE"?"상품 정보를 불러오지 못했어요. 말씀하신 조건은 그대로예요. 잠시 후 다시 시도해 주세요.":
 code==="MODEL_OUTPUT_INVALID"?"답변을 정리하는 중 문제가 생겼어요. 같은 질문으로 다시 시도해 주세요.":
 code==="MODEL_RATE_LIMIT"?"AI 모델이 잠시 바빠요. 잠시 후 다시 시도해 주세요.":
 code==="CONVERSATION_BUSY"?"이전 요청이 처리 중이에요. 잠시 후 결과를 다시 확인해 주세요.":
 "응답을 받지 못했어요. 같은 질문으로 다시 시도하거나 내용을 수정할 수 있어요.";
const safeImage=(value:string|undefined)=>value&&(/^(?:https?:\/\/|\/[^/])/.test(value))?value:undefined;
const money=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const recommendationLabel=(role:RankedProduct["recommendationRole"])=>role==="PERSONALIZED"?"나에게 맞춤":role==="REVIEW_VERIFIED"?"후기 검증형":role==="ALTERNATIVE"?"비교 대안":null;
const isRetrievalUnavailable=(entry:Entry)=>entry.reply?.explanation?.failure?.code==="RETRIEVAL_UNAVAILABLE";

export function createRetrievalRetryEntry(entry:Pick<Entry,"text"|"clientActionId"|"conversationId">,activeConversation:string|null):Entry{
 const conversationId=entry.conversationId??activeConversation;
 return {text:entry.text,clientActionId:newActionKey(),...(conversationId?{conversationId}:{}),status:"sending"};
}
export function canExploreBrainReply(reply:BrainReply|undefined):boolean{
 return !!reply&&reply.explanation?.failure?.code!=="RETRIEVAL_UNAVAILABLE"&&
   (reply.ranking.ranked.length>0||reply.explanation?.kind==="NO_MATCH"||reply.explanation?.kind==="REFERENCE_ONLY");
}

export function BrainRanking({ranking,explanation,onOpenProduct,onExcludeProduct}:{explanation?:BrainReply["explanation"];ranking:BrainRankingResult;onOpenProduct:(id:string,variantId?:string)=>void;onExcludeProduct?:(id:string)=>void}){
 const seen=new Set<string>();
 const unique=<T extends {candidate:ProductCandidate}>(rows:T[]):T[]=>rows.filter(row=>{
   if(seen.has(row.candidate.productId))return false;seen.add(row.candidate.productId);return true;
 });
 const retrievalUnavailable=explanation?.failure?.code==="RETRIEVAL_UNAVAILABLE";
 const modelFallback=!!explanation?.failure&&!retrievalUnavailable;
 const ranked=unique(ranking.ranked.filter(r=>r.candidate.commerceVerified===true&&(!explanation||modelFallback||explanation.items.some(i=>i.productId===r.candidate.productId&&(!i.variantId||i.variantId===r.candidate.variantId)))));
 const references=unique(retrievalUnavailable?[]:ranking.referenceOnly);
 const rows=[...ranked.map(row=>({...row,reference:false})),...references.map(row=>({...row,reference:true,recommendationRole:undefined,personalizationSignals:undefined}))].slice(0,3);
 if(!rows.length)return null;
 return <section className="brain-products" aria-label="상품 비교 결과">
   <p className="muted sm">{rows.length}개 상품 표시</p>
   {rows.map(({candidate:p,reference,recommendationRole,personalizationSignals},index)=><article key={p.productId} className="brain-product-card">
     <div className="brain-product-image">{!reference&&<span className="brain-rank">{index+1}순위</span>}<span aria-hidden="true">상품 이미지</span>
       {safeImage(p.productImage)&&<img src={safeImage(p.productImage)} alt={p.productName??"상품"} loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.hidden=true;}}/>}</div>
     <div className="brain-product-info"><div className="brain-product-heading"><div className="brain-product-summary">
       {!reference&&recommendationLabel(recommendationRole)&&<p className="muted sm">{recommendationLabel(recommendationRole)}</p>}<b className="brain-product-name">{p.productName??"상품명 확인 중"}</b>
       <dl className="brain-price-breakdown" aria-label="상품 가격 구성">
         <div><dt>상품가</dt><dd>{p.commerceVerified===true&&money(p.unitPriceWon)?fmtWon(p.unitPriceWon):"확인 전"}</dd></div>
         <div><dt>배송비</dt><dd>{p.commerceVerified===true&&money(p.shippingFeeWon)?fmtWon(p.shippingFeeWon):"확인 전"}</dd></div>
         <div className="brain-price-total"><dt>배송비 포함 합계</dt><dd>{
          p.commerceVerified===true&&money(p.unitPriceWon)&&money(p.shippingFeeWon)&&
           Number.isSafeInteger(p.unitPriceWon+p.shippingFeeWon)?
           fmtWon(p.unitPriceWon+p.shippingFeeWon):"금액 확인 필요"
         }</dd></div>
       </dl></div>
       {p.commerceVerified===true&&<button className="link brain-product-open" aria-label="상품 보기" onClick={()=>onOpenProduct(p.productId,p.variantId)}>상품 보기<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
       </div>
       {!!personalizationSignals?.length&&<p className="muted sm">맞춤 근거: {personalizationSignals.map(signal=>signal==="CART"?"장바구니":signal==="WISHLIST"?"찜":"구매 기록").join(" · ")}</p>}
       {recommendationRole==="REVIEW_VERIFIED"&&p.ratingScale===5&&typeof p.rating==="number"&&p.wholeReviewCountVerified===true&&typeof p.wholeReviewCount==="number"&&<p className="muted sm">평점 {p.rating.toFixed(1)}/5 · 상품 전체 리뷰 {p.wholeReviewCount}개 (3.5점 초과 · 10개 이상 기준)</p>}
       {recommendationRole==="PERSONALIZED"&&!personalizationSignals?.length&&<p className="muted sm">현재 조건과 검증된 상품 근거로 비교한 후보예요.</p>}
       {explanation?.items.find(i=>i.productId===p.productId&&(!i.variantId||i.variantId===p.variantId))?.reason&&<div className="brain-product-reason"><BrainAnswer text={explanation.items.find(i=>i.productId===p.productId&&(!i.variantId||i.variantId===p.variantId))!.reason!}/></div>}
       {(p.keywords??[]).filter(k=>!/(?:type|sub_category|source_kind|[a-z]+_[a-z]+)/.test(k)).slice(0,3).map((keyword,i)=><span key={i} className="chip">{keyword}</span>)}
       {reference&&<p className="muted sm">{
        ranking.referenceOnly.some(row=>row.candidate.productId===p.productId&&row.reasons.includes("review_sort_evidence_insufficient"))?
        "확인된 리뷰가 부족해 요청하신 순위는 정하지 않았어요.":
        "말씀하신 조건에 맞는지 더 확인이 필요한 상품이에요."
       }</p>}
       {p.commerceVerified!==true&&<p className="muted sm">상품 확인 전 · 상세보기 준비 중</p>}
       {!reference&&onExcludeProduct&&<div className="brain-product-footer"><button className="link brain-product-exclude" onClick={()=>onExcludeProduct(p.productId)}>이 상품은 빼주세요</button></div>}
     </div>
   </article>)}
 </section>;
}

export function BrainPreview({onClose,onOpenProduct,onOpenCart,onOpenCheckout,onOpenOrders,onOpenOrder,checkoutEnabled}:{
 onClose:()=>void;onOpenProduct:(id:string,variantId?:string)=>void;onOpenCart:()=>void;
 onOpenCheckout:()=>void;onOpenOrders:()=>void;onOpenOrder:(orderId:string)=>void;checkoutEnabled:boolean;
}){
 const [input,setInput]=useState("");
 const [conversation,setConversation]=useState<string|null>(null);
 const [conversations,setConversations]=useState<Conversation[]>([]);
 const [sourceMessage,setSourceMessage]=useState<string|null>(null);
 const [selected,setSelected]=useState<"value"|"balanced"|"performance">("value");
 const [pending,setPending]=useState<string|null>(null);
 const [saved,setSaved]=useState(false);
 const [memories,setMemories]=useState<MemoryItem[]>([]);
 const [entries,setEntries]=useState<Entry[]>([]);
 const [busy,setBusy]=useState(false);
 const [restoring,setRestoring]=useState(true);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const lock=useRef(false),epoch=useRef(0),bottom=useRef<HTMLDivElement>(null);
 const initialCreation=useRef<string|null>(null),newCreation=useRef<string|null>(null);
 const listConversations=async(generation=epoch.current)=>{
   const r=await apiSafe<{conversations:Conversation[]}>("/api/brain/conversations");
   if(generation===epoch.current&&r.ok)setConversations(r.data.conversations);
 };
 const applyHistory=(data:History)=>{
   setConversation(data.conversationId);setEntries(data.entries);
   setSourceMessage(data.entries.at(-1)?.reply?.message_id??null);
   setPending(null);setSaved(false);setInput("");
 };
 useEffect(()=>{
   const generation=epoch.current;
   void apiSafe<History>("/api/brain/history").then(r=>{
     if(generation!==epoch.current)return;
     if(r.ok)applyHistory(r.data);else setError("이전 대화를 복원하지 못했어요. 다시 열어 주세요.");
   }).finally(()=>{if(generation===epoch.current)setRestoring(false);});
   void listConversations(generation);
   void apiSafe<MemoryItem[]>("/api/brain/preferences").then(r=>{if(generation===epoch.current&&r.ok)setMemories(r.data);});
   return ()=>{epoch.current++;};
 },[]);
 useEffect(()=>{bottom.current?.scrollIntoView({block:"nearest",behavior:"smooth"});},[entries,busy]);

 const refresh=async()=>{
   const result=await apiSafe<MemoryItem[]>("/api/brain/preferences");
   if(result.ok)setMemories(result.data);
   return result.ok;
 };
 const runEntry=async(entry:Entry)=>{
   if(lock.current)return;lock.current=true;const generation=epoch.current;
   setBusy(true);setError("");setNotice("");setPending(null);setSaved(false);setSourceMessage(null);
   const update=(changes:Partial<Entry>)=>{
     if(generation===epoch.current)setEntries(previous=>previous.map(e=>e.clientActionId===entry.clientActionId?{...e,...changes}:e));
   };
   try{
     let id=entry.conversationId??conversation;
     if(!id){
       initialCreation.current??=newActionKey();
       const created=await apiSafe<{id:string}>("/api/brain/conversations",{method:"POST",body:JSON.stringify({client_action_id:initialCreation.current})});
       if(!created.ok){update({status:"failed",failure:"대화를 시작할 수 없어요. 다시 시도해 주세요."});return;}
       if(generation!==epoch.current)return;
       initialCreation.current=null;id=created.data.id;setConversation(id);update({conversationId:id});
     }
     const r=await apiSafe<BrainReply>("/api/brain/conversations/"+encodeURIComponent(id)+"/turn",
       {method:"POST",body:JSON.stringify({user_message:entry.text,client_action_id:entry.clientActionId})});
     if(generation!==epoch.current)return;
     if(!r.ok){update({status:"failed",failure:friendlyFailure(r.error.code)});return;}
     if(r.data.conversation_id!==id){update({status:"failed",failure:"대화 결과를 확인하지 못했어요. 다시 시도해 주세요."});return;}
     update({reply:r.data,status:"completed",failure:undefined,conversationId:id});setSourceMessage(r.data.message_id);
     await listConversations(generation);
   }finally{if(generation===epoch.current){lock.current=false;setBusy(false);}}
 };
 const sendChoice=(text:string)=>{if(lock.current||restoring)return;
   const entry:Entry={text,clientActionId:newActionKey(),...(conversation?{conversationId:conversation}:{}),status:"sending"};
   setEntries(previous=>[...previous,entry]);setInput("");void runEntry(entry);
 };
 const interview=resolveBrainInterviewState(entries,busy);
 const send=()=>{
   const text=input.trim();if(!text||lock.current||restoring)return;
   const entry:Entry={text,clientActionId:newActionKey(),...(conversation?{conversationId:conversation}:{}),status:"sending"};
   setEntries(previous=>[...previous,entry]);setInput("");void runEntry(entry);
 };
 const retry=(entry:Entry)=>{
   if(lock.current||!entry.clientActionId)return;
   if(isRetrievalUnavailable(entry)){
     const retryEntry=createRetrievalRetryEntry(entry,conversation);
     setEntries(previous=>[...previous,retryEntry]);void runEntry(retryEntry);return;
   }
   setEntries(previous=>previous.map(e=>e.clientActionId===entry.clientActionId?{...e,status:"sending",failure:undefined}:e));
   void runEntry(entry);
 };
 const editQuestion=(entry:Entry)=>{setInput(entry.text);setNotice("조건을 수정한 뒤 보내면 새 검색 요청으로 처리해요.");};
 const showExplore=canExploreBrainReply(entries.at(-1)?.reply);
 const changeConversation=async(id?:string)=>{
   if(lock.current||restoring)return;lock.current=true;setBusy(true);setError("");
   try{
     if(!id)newCreation.current??=newActionKey();
     const r=id?await apiSafe<History>(`/api/brain/conversations/${encodeURIComponent(id)}/history`):
       await apiSafe<{id:string}>("/api/brain/conversations",{method:"POST",body:JSON.stringify({client_action_id:newCreation.current})});
     if(!r.ok){setError("대화를 열지 못했어요. 현재 대화는 유지했어요.");return;}
     epoch.current++;
     newCreation.current=null;initialCreation.current=null;
     applyHistory("entries" in r.data?r.data:{conversationId:r.data.id,entries:[]});
     setNotice(id?"이전 대화로 돌아왔어요.":"새 대화를 시작했어요. 저장된 장기 선호와 이전 기록은 보존돼요.");
     await listConversations();
   }finally{lock.current=false;setBusy(false);}
 };
 const propose=async()=>{
   if(!conversation||!sourceMessage||lock.current)return;lock.current=true;setBusy(true);setError("");setNotice("");
   try{
     const r=await apiSafe<{proposal_id:string}>("/api/brain/preferences/proposals",{method:"POST",body:JSON.stringify({conversation_id:conversation,source_message_id:sourceMessage,key:"price_priority",value:selected})});
     if(r.ok)setPending(r.data.proposal_id);else setError("선호 저장 요청을 만들지 못했어요.");
   }finally{lock.current=false;setBusy(false);}
 };
 const confirm=async()=>{
   if(!pending||lock.current)return;lock.current=true;setBusy(true);setError("");
   try{
     const r=await apiSafe<{key:string;value:string;updatedAt:string}>("/api/brain/preferences/confirm",{method:"POST",body:JSON.stringify({proposal_id:pending})});
     if(r.ok){
       setPending(null);setSaved(true);
       setMemories(previous=>[...previous.filter(m=>m.key!==r.data.key),r.data]);
       setNotice("선호를 장기 기억에 저장했어요.");
       if(!await refresh())setNotice("선호를 저장했어요. 목록 새로고침은 잠시 후 다시 확인해 주세요.");
     }else setError("선호 저장 확인에 실패했어요. 다시 확인해 주세요.");
   }finally{lock.current=false;setBusy(false);}
 };
 const clear=async()=>{
   if(lock.current)return;lock.current=true;setBusy(true);setError("");
   try{
     const r=await apiSafe<{deleted:boolean}>("/api/brain/preferences/price_priority",{method:"DELETE"});
     if(r.ok){setMemories(previous=>previous.filter(m=>m.key!=="price_priority"));setSaved(false);setNotice("장기 가격 선호만 삭제했어요. 대화 기록과 현재 조건은 보존돼요.");}
     else setError("선호 삭제에 실패했어요.");
   }finally{lock.current=false;setBusy(false);}
 };
 return <aside className="agent-panel brain-panel" aria-label="토스쇼핑 AI Brain">
   <div className="agent-head"><div className="brain-brand"><span className="brain-avatar" aria-hidden="true">✦</span><div><b>토스쇼핑 AI Brain</b><div className="muted sm">나만의 쇼핑 전담 AI 비서</div></div></div><button className="link" onClick={onClose}>닫기</button></div>
   <div className="brain-conversations">
     <button className="btn" onClick={()=>void changeConversation()} disabled={busy||restoring}>새 대화 시작</button>
     <select aria-label="이전 대화" value="" disabled={busy||restoring} onChange={e=>{if(e.target.value)void changeConversation(e.target.value);}}>
       <option value="">이전 대화 선택</option>{conversations.map(c=><option key={c.id} value={c.id}>{c.title??"새 대화"}</option>)}
     </select>
   </div>
   <div className="agent-body">
     {entries.length===0&&<p className="muted sm">찾는 상품과 원하는 조건을 알려주세요. 새 대화에서도 직접 저장한 장기 선호는 유지돼요.</p>}
     {entries.map((e,i)=><div className="brain-turn" key={e.clientActionId??i}>
       <div className="msg user"><p>{e.text}</p></div>
       {e.status==="sending"&&<p role="status" className="muted sm">토스쇼핑 AI Brain이 요청을 살펴보고 있어요…</p>}
       {e.status==="failed"&&<div className="state-box error"><p role="alert">{e.failure}</p>
         <button className="link" disabled={busy} onClick={()=>retry(e)}>{isRetrievalUnavailable(e)?"다시 검색":"다시 시도"}</button>
         <button className="link" disabled={busy} onClick={()=>editQuestion(e)}>{isRetrievalUnavailable(e)?"조건 바꾸기":"질문 수정"}</button>
       </div>}
       {e.reply&&<><div className="brain-assistant-message"><span className="brain-avatar" aria-hidden="true">✦</span><div className="msg ai"><BrainAnswer text={e.reply.explanation?.failure
         ?e.reply.explanation.failure.code==="RETRIEVAL_UNAVAILABLE"
           ?e.reply.explanation.text.trim()||friendlyFailure(e.reply.explanation.failure.code)
           :e.reply.explanation.items.length>0?e.reply.explanation.text
             :friendlyFailure(e.reply.explanation.failure.code)+((e.reply.ranking.ranked.length+e.reply.ranking.referenceOnly.length)>0?" 아래 검색 결과는 확인할 수 있어요.":"")
         :e.reply.explanation?.text??"상품 정보를 확인했어요."}/></div></div>
         {e.reply.review_summary&&<section className="brain-review-summary state-box" aria-label="해당 상품 리뷰 요약">
          <div className="brain-review-summary-header"><b>{e.reply.review_summary.name}</b>
            <p className="muted sm">확인한 리뷰 {e.reply.review_summary.sampled}건
             {e.reply.review_summary.totalMatching>e.reply.review_summary.sampled?" · 일부 리뷰 기준":""}</p>
          </div>
          {e.reply.review_summary.citations.length>0&&<details className="brain-review-citations">
            <summary>확인한 리뷰 근거 보기 ({e.reply.review_summary.citations.length}건)</summary>
            <ul>{e.reply.review_summary.citations.map((c,index)=><li key={c.sourceId}>
              <span>“{c.quote}”</span><small>{c.sourceVariantId?"해당 옵션 리뷰":"상품 리뷰"}</small>
            </li>)}</ul>
          </details>}
        </section>}
         {e.reply.agent_ui?.kind==="WISHLIST"&&<section className="brain-products" aria-label="내 찜 상품">{e.reply.agent_ui.items.map((item,index)=><article className="brain-product-card" key={item.productId}><div className="brain-product-info"><b>{index+1}. {item.name}</b><p className="muted sm">{!item.active?"판매 중단":money(item.minPriceWon)?`옵션 최저가 ${fmtWon(item.minPriceWon)} · 배송비·재고는 상세에서 확인`:"판매 가능한 옵션 확인 필요"}</p><button className="link" disabled={!item.active||!money(item.minPriceWon)} onClick={()=>onOpenProduct(item.productId)}>{e.reply?.agent_ui?.selectedProductId===item.productId?"선택한 상품 상세 보기":"상품 상세 보기"}</button></div></article>)}</section>}
         {!!e.reply.shopping_handoffs?.length&&<section className="brain-recovery-actions" aria-label="쇼핑 화면으로 이동">
           {e.reply.shopping_handoffs.filter(action=>
             // Recommendation cards and wishlist already carry product detail buttons.
             !(action.kind==="PRODUCT_DETAIL"&&
               (e.reply!.ranking.ranked.some(row=>row.candidate.productId===action.productId)||
                e.reply!.agent_ui?.kind==="WISHLIST"&&e.reply!.agent_ui.items.some(item=>item.productId===action.productId)))&&
             !(action.kind==="CHECKOUT_REVIEW"&&!checkoutEnabled)
           ).map((action,index)=><button className="btn" key={action.kind+index} disabled={busy||restoring}
             onClick={()=>{switch(action.kind){
               case "PRODUCT_DETAIL":onOpenProduct(action.productId,action.variantId);break;
               case "CART_REVIEW":onOpenCart();break;
               case "CHECKOUT_REVIEW":onOpenCheckout();break;
               case "ORDER_LIST":onOpenOrders();break;
               case "ORDER_DETAIL":onOpenOrder(action.orderId);break;
             }}}>{action.label}</button>)}
         </section>}
         {isRetrievalUnavailable(e)&&<div className="brain-recovery-actions">
           <button className="link" disabled={busy} onClick={()=>retry(e)}>다시 검색</button>
           <button className="link" disabled={busy} onClick={()=>editQuestion(e)}>조건 바꾸기</button>
         </div>}
         {e.reply.explanation?.kind!=="CONVERSATION"&&e.reply.explanation?.kind!=="CLARIFICATION"&&<BrainRanking explanation={e.reply.explanation} ranking={e.reply.ranking} onOpenProduct={onOpenProduct} onExcludeProduct={i===entries.length-1&&!busy?(id)=>sendChoice(`이 상품 제외: ${id}`):undefined}/>}
       </>}
     </div>)}
     {sourceMessage&&conversation&&(entries.at(-1)?.reply?.ranking.ranked.length??0)>0&&<div className="state-box">
       <b>가격 선호를 장기 기억으로 저장할까요?</b>
       <select aria-label="가격 선호" value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value as typeof selected);setPending(null);setSaved(false);setNotice("");}}>
         <option value="value">가성비 중심</option><option value="balanced">균형</option><option value="performance">성능 중심</option>
       </select>
       {saved?<p>저장 완료</p>:!pending?<button className="btn" onClick={()=>void propose()} disabled={busy}>선호 저장 요청</button>
         :<button className="btn primary" onClick={()=>void confirm()} disabled={busy}>이 선호를 기억하도록 확인</button>}
       <p className="muted sm">최종 확인 후에만 장기 기억에 저장돼요.</p>
     </div>}
     {memories.length>0&&<div className="state-box brain-memory"><b>저장된 장기 선호</b>
       {memories.map(m=><div key={m.key} className="muted sm">{preferenceLabels[m.key]??"저장된 선호"}: {priceLabels[m.value]??"설정됨"}</div>)}
       <button className="link" onClick={()=>void clear()} disabled={busy}>가격 선호 기억 삭제</button>
     </div>}
     {interview.questions.length>0&&<section className="state-box brain-interview" aria-label="추천 조건 확인"><div className="brain-interview-heading"><span className="brain-section-icon" aria-hidden="true">☷</span><div><span className="brain-eyebrow">맞춤 추천 준비</span><h3>원하는 조건을 알려주세요</h3></div></div>{interview.questions.map((q,index)=><fieldset key={q.key}><legend><span className="brain-question-number">{index+1}</span>{q.text}</legend><div className="brain-quick-choices">{q.choices.map(choice=><button key={choice} className="btn brain-choice" aria-label={choice} disabled={busy||restoring} onClick={()=>sendChoice(choice)}>{choice.replace(/^예산은 /,"")}</button>)}</div></fieldset>)}<p className="muted sm">아래 입력창에 원하는 조건을 직접 적어도 좋아요.</p></section>}
     {showExplore&&!busy&&<div className="brain-explore"><button className="btn" disabled={restoring} onClick={()=>sendChoice("조건 바꾸기")}>조건 바꾸기</button><button className="btn" disabled={restoring} onClick={()=>sendChoice("다른 상품 보기")}>다른 상품 보기</button></div>}
     {notice&&<p role="status" className="muted sm">{notice}</p>}
     {error&&<p role="alert">{error}</p>}
     <div ref={bottom}/>
   </div>
   <div className="agent-input"><input value={input} disabled={busy||restoring} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing)send();}} aria-label="메시지 또는 원하는 조건" placeholder="쇼핑 조건을 입력하세요"/>
     <button className="btn primary brain-send" aria-label="보내기" disabled={busy||restoring||!input.trim()} onClick={send}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button></div>
 </aside>;
}
