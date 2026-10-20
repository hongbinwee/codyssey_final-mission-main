import {useEffect,useRef,useState} from "react";
import {apiSafe,newActionKey,fmtWon} from "../api.ts";
import {resolveBrainInterviewState} from "../brain-interview-state.ts";
import {BrainAnswer} from './BrainAnswer.tsx';
import {reviewSortAspectLabel} from "../../brain/review-sort.ts";
import type {ReviewSummaryData} from "../../brain/contracts.ts";
import {sanitizePageContext,type SafePageContext} from "../../brain/page-context.ts";

type ProductCandidate={
 productId:string;productName?:string;variantId:string;productImage?:string;keywords?:string[];
 unitPriceWon?:number|null;shippingFeeWon?:number|null;
 rating?:number|null;ratingScale?:number|null;wholeReviewCount?:number|null;wholeReviewCountVerified?:boolean;
 sourceKind?:"REAL"|"SYNTHETIC";datasetVersion?:string;commerceVerified?:boolean;isSimulated?:boolean;
};
type ReviewSortEvidence={aspect:string;positiveCount:number;negativeCount:number;reviewIds:string[];sourceKinds:("REAL"|"SYNTHETIC")[]};
type RankedProduct={candidate:ProductCandidate;score:number;evidenceCoverage:number;recommendationRole?:"PERSONALIZED"|"REVIEW_VERIFIED"|"ALTERNATIVE";personalizationSignals?:("CART"|"WISHLIST"|"PURCHASE")[];reviewSortEvidence?:ReviewSortEvidence};
type LimitedProduct={candidate:ProductCandidate;reasons:string[]};
type BrainRankingResult={ranked:RankedProduct[];referenceOnly:LimitedProduct[];rejected:LimitedProduct[];evaluatedCount:number;explicitReviewSort?:{aspect:string;status:"APPLIED"|"INSUFFICIENT";scope:"RETRIEVED_REVIEWS"}};
type BrainReply={
 conversation_id:string;message_id:string;read_only:true;intent_kind?:string;
 shopping_plan?:{query:string;minTotalWon?:number;maxTotalWon:number|null;requiredConditions:string[];revision:number;attributePreferences?:string[];reviewSort?:{aspect:string;direction:"MOST_POSITIVE"}}|null;
 explanation?:{text:string;kind:string;items:{productId:string;variantId?:string;evidenceIds:string[];reason?:string}[];clarification?:{questions:{key:string;text:string;choices:string[]}[]};limitations:string[];reviewSummary?:ReviewSummaryData;
   failure?:{code:string;httpStatus?:number}}|null;
 ranking:BrainRankingResult;trace:{totalMs:number;graphWallMs?:number};
};
type MemoryItem={key:string;value:string;updatedAt:string};
type PricePreference="value"|"balanced"|"performance";
type PreferencePromptStatus="idle"|"requesting"|"confirming"|"saving"|"saved"|"failed";
type Entry={text:string;clientActionId?:string;conversationId?:string;pageContext?:SafePageContext;reply?:BrainReply;status?:"sending"|"failed"|"completed";failure?:string};
type History={conversationId:string|null;entries:Entry[]};
type Conversation={id:string;title:string|null;createdAt:string};
const priceLabels:Record<string,string>={value:"가성비 중심",balanced:"균형",performance:"성능 중심",important:"중요",normal:"보통"};
const preferenceLabels:Record<string,string>={price_priority:"가격 선호",eye_comfort:"눈의 편안함",noise_sensitivity:"소음 선호"};
const pricePreferenceChoices:{value:PricePreference;label:string}[]=[
 {value:"value",label:"가성비를 우선해요"},
 {value:"balanced",label:"가격과 품질을 균형 있게 봐요"},
 {value:"performance",label:"품질을 더 중요하게 생각해요"},
];
const isPricePreference=(value:string):value is PricePreference=>value==="value"||value==="balanced"||value==="performance";
export function isPricePreferenceConfirmation(value:unknown,expected:PricePreference):boolean{
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const result=value as Record<string,unknown>;
 return result.key==="price_priority"&&result.value===expected&&typeof result.updatedAt==="string"&&result.updatedAt.length>0;
}
const pageContextSnapshot=(value:unknown):SafePageContext|undefined=>{
 const safe=sanitizePageContext(value);return safe?{...safe}:undefined;
};
const userFacingMessage=(text:string)=>text.startsWith("리뷰 요약 상품 선택: ")?"리뷰 요약할 상품을 선택했어요.":text;
const friendlyFailure=(code:string)=>code==="MODEL_TIMEOUT"?"AI 응답이 늦어지고 있어요. 질문과 기존 조건은 보존했어요.":
 code==="RETRIEVAL_UNAVAILABLE"?"상품 정보를 불러오지 못했어요. 말씀하신 조건은 그대로예요. 잠시 후 다시 시도해 주세요.":
 code==="MODEL_OUTPUT_INVALID"?"답변을 정리하는 중 문제가 생겼어요. 같은 질문으로 다시 시도해 주세요.":
 code==="MODEL_RATE_LIMIT"?"AI 모델이 잠시 바빠요. 잠시 후 다시 시도해 주세요.":
 code==="CONVERSATION_BUSY"?"이전 요청이 처리 중이에요. 잠시 후 결과를 다시 확인해 주세요.":
 "응답을 받지 못했어요. 같은 질문으로 다시 시도하거나 내용을 수정할 수 있어요.";
const safeImage=(value:string|undefined)=>value&&(/^(?:https?:\/\/|\/[^/])/.test(value))?value:undefined;
const money=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const validSortEvidence=(row:RankedProduct,aspect:string)=>{
 const value=row.reviewSortEvidence;
 return !!value&&value.aspect===aspect&&Number.isSafeInteger(value.positiveCount)&&value.positiveCount>=0&&
   Number.isSafeInteger(value.negativeCount)&&value.negativeCount>=0&&Array.isArray(value.reviewIds)&&
   Array.isArray(value.sourceKinds)&&value.reviewIds.length>0&&value.sourceKinds.length>0&&value.reviewIds.length===new Set(value.reviewIds).size&&
   value.positiveCount+value.negativeCount===value.reviewIds.length&&value.sourceKinds.length===new Set(value.sourceKinds).size&&
   value.reviewIds.every(id=>typeof id==="string"&&id.length>0)&&value.sourceKinds.every(kind=>kind==="REAL"||kind==="SYNTHETIC");
};
const recommendationLabel=(role:RankedProduct["recommendationRole"])=>role==="PERSONALIZED"?"나에게 맞춤":role==="REVIEW_VERIFIED"?"후기 검증형":role==="ALTERNATIVE"?"비교 대안":null;
const isRetrievalUnavailable=(entry:Entry)=>entry.reply?.explanation?.failure?.code==="RETRIEVAL_UNAVAILABLE";

export function createRetrievalRetryEntry(entry:Pick<Entry,"text"|"clientActionId"|"conversationId"|"pageContext">,activeConversation:string|null):Entry{
 const conversationId=entry.conversationId??activeConversation;
 return {text:entry.text,clientActionId:newActionKey(),...(conversationId?{conversationId}:{}),
   ...(entry.pageContext?{pageContext:{...entry.pageContext}}:{}),status:"sending"};
}
export function canExploreBrainReply(reply:BrainReply|undefined):boolean{
 return !!reply&&reply.explanation?.kind!=="REVIEW_SUMMARY"&&reply.explanation?.failure?.code!=="RETRIEVAL_UNAVAILABLE"&&
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
 const simulated=rows.some(({candidate:p})=>p.sourceKind==="SYNTHETIC"||p.isSimulated);
 const explicitSort=ranking.explicitReviewSort;
 const appliedSort=explicitSort?.status==="APPLIED"?explicitSort:undefined;
 const insufficientSort=explicitSort?.status==="INSUFFICIENT"?explicitSort:undefined;
 const reviewSortNote=appliedSort
   ?`‘${reviewSortAspectLabel(appliedSort.aspect)}’ 기준으로 검색된 후기 표본을 비교했어요. 동수는 공동 순위로 표시했어요. 검색된 일부 후기라 전체를 대표하지 않아요.`
   :insufficientSort?`‘${reviewSortAspectLabel(insufficientSort.aspect)}’ 기준은 후기 수가 충분하지 않아 정렬 비교에 적용하지 않았어요. 검색된 후기는 전체가 아닌 일부 표본이에요.`:"";
 if(!rows.length)return null;
 return <section className="brain-products" aria-label="상품 비교 결과">
   <p className="muted sm">{ranked.length+references.length>rows.length?`${ranked.length+references.length}개 중 ${rows.length}개 표시`:`${rows.length}개 상품 표시`}</p>
   {!!reviewSortNote&&<p className="muted sm brain-review-sort-note" role="note">{reviewSortNote}</p>}
   {simulated&&<p className="muted sm" role="note">테스트 카탈로그의 가격·재고로 실제 주문·결제는 할 수 없어요. 합성 리뷰는 실제 구매 후기가 아니에요.</p>}
   {rows.map((row,index)=>{
     const {candidate:p,reference,recommendationRole,personalizationSignals}=row;
     const rankedRow=reference?undefined:row as RankedProduct;
     const rowSortEvidence=appliedSort&&rankedRow&&validSortEvidence(rankedRow,appliedSort.aspect)?rankedRow.reviewSortEvidence:undefined;
     const rankValue=appliedSort&&rowSortEvidence
       ?1+ranked.filter(other=>other.reviewSortEvidence&&validSortEvidence(other,appliedSort.aspect)&&other.reviewSortEvidence.positiveCount>rowSortEvidence.positiveCount).length
       :index+1;
     const tied=appliedSort&&rowSortEvidence&&ranked.some(other=>other.candidate.productId!==p.productId&&other.reviewSortEvidence&&
       validSortEvidence(other,appliedSort.aspect)&&other.reviewSortEvidence.positiveCount===rowSortEvidence.positiveCount);
     const rankLabel=!reference&&!insufficientSort&&(!appliedSort||!!rowSortEvidence)
       ?appliedSort?(tied?`공동 ${rankValue}순위`:`${rankValue}순위`):`${rankValue}순위`:null;
     const commerceVerified=p.commerceVerified===true;
     const unitPrice=commerceVerified&&money(p.unitPriceWon)?p.unitPriceWon:undefined;
     const shippingPrice=commerceVerified&&money(p.shippingFeeWon)?p.shippingFeeWon:undefined;
     const totalAmount=unitPrice!==undefined&&shippingPrice!==undefined&&Number.isSafeInteger(unitPrice+shippingPrice)?unitPrice+shippingPrice:null;
     return <article key={p.productId} className="brain-product-card">
     <div className="brain-product-image">{rankLabel&&<span className="brain-rank">{rankLabel}</span>}<span aria-hidden="true">상품 이미지</span>
       {safeImage(p.productImage)&&<img src={safeImage(p.productImage)} alt={p.productName??"상품"} loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.hidden=true;}}/>}</div>
     <div className="brain-product-info"><div className="brain-product-heading"><div className="brain-product-summary">
       {!reference&&recommendationLabel(recommendationRole)&&<p className="muted sm">{recommendationLabel(recommendationRole)}</p>}<b className="brain-product-name">{p.productName??"상품명 확인 중"}</b>
       <div className="brain-product-prices">
         <p><span>상품가</span><b>{unitPrice!==undefined?fmtWon(unitPrice):"확인 전"}</b></p>
         <p><span>배송비</span><b>{shippingPrice!==undefined?fmtWon(shippingPrice):"확인 전"}</b></p>
         <p className="brain-product-total"><span>합계</span><b>{totalAmount!==null?fmtWon(totalAmount):"확인 전"}</b></p>
       </div></div>
       {p.commerceVerified===true&&<button className="link brain-product-open" aria-label="상품 보기" onClick={()=>onOpenProduct(p.productId,p.variantId)}>상품 보기<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
       </div>
       {!!personalizationSignals?.length&&<p className="muted sm">맞춤 근거: {personalizationSignals.map(signal=>signal==="CART"?"장바구니":signal==="WISHLIST"?"찜":"구매 기록").join(" · ")}</p>}
       {recommendationRole==="REVIEW_VERIFIED"&&p.ratingScale===5&&typeof p.rating==="number"&&p.wholeReviewCountVerified===true&&typeof p.wholeReviewCount==="number"&&<p className="muted sm">평점 {p.rating.toFixed(1)}/5 · 상품 전체 리뷰 {p.wholeReviewCount}개 (3.5점 초과 · 10개 이상 기준)</p>}
       {recommendationRole==="PERSONALIZED"&&!personalizationSignals?.length&&<p className="muted sm">현재 조건과 검증된 상품 근거로 비교한 후보예요.</p>}
       {explanation?.items.find(i=>i.productId===p.productId&&(!i.variantId||i.variantId===p.variantId))?.reason&&<div className="brain-product-reason"><BrainAnswer text={explanation.items.find(i=>i.productId===p.productId&&(!i.variantId||i.variantId===p.variantId))!.reason!}/></div>}
       {(p.keywords??[]).filter(k=>!/(?:type|sub_category|source_kind|[a-z]+_[a-z]+)/.test(k)).slice(0,3).map((keyword,i)=><span key={i} className="chip">{keyword}</span>)}
       {reference&&<p className="muted sm">말씀하신 조건에 맞는지 더 확인이 필요한 상품이에요.</p>}
       {p.commerceVerified!==true&&<p className="muted sm">상품 확인 전 · 상세보기 준비 중</p>}
       {!reference&&onExcludeProduct&&<div className="brain-product-footer"><button className="link brain-product-exclude" onClick={()=>onExcludeProduct(p.productId)}>이 상품은 빼주세요</button></div>}
     </div>
   </article>;
   })}
 </section>;
}

export function BrainReviewSummary({summary,onOpenProduct,onChooseProduct}:{
 summary:ReviewSummaryData;onOpenProduct:(id:string,variantId?:string)=>void;onChooseProduct:(message:string)=>void;
}){
 const product=summary.product&&typeof summary.product.id==="string"&&summary.product.id.length>0&&
   typeof summary.product.name==="string"&&summary.product.name.trim()?summary.product:undefined;
 const choices=(Array.isArray(summary.choices)?summary.choices:[]).filter(choice=>
   typeof choice.productId==="string"&&choice.productId.length>0&&typeof choice.name==="string"&&choice.name.trim());
 const allEvidence=Array.isArray(summary.evidence)?summary.evidence:[];
 const seen=new Set<string>();
 const evidence=product?allEvidence.filter(row=>{
   if(row.kind!=="REVIEW"||row.verified!==true||row.productId!==product.id||typeof row.text!=="string"||!row.text.trim()||
      row.text.length>1200||(summary.datasetVersion!==undefined&&row.datasetVersion!==summary.datasetVersion)||
      (row.variantId!==null&&(!product.variantId||row.variantId!==product.variantId))||seen.has(row.id))return false;
   seen.add(row.id);return true;
 }).slice(0,20):[];
 const productEvidence=evidence.filter(row=>row.variantId===null);
 const variantEvidence=product?.variantId?evidence.filter(row=>row.variantId===product.variantId):[];
 const productImage=product?safeImage(product.image):undefined;
 const renderEvidence=(title:string,rows:typeof evidence)=>rows.length>0&&<section className="brain-review-evidence-scope" aria-label={title}>
   <h4>{title}</h4><ul>{rows.map(row=><li key={row.id}>
     <blockquote>{row.text}</blockquote>
     <span className="muted sm">{row.sourceKind==="SYNTHETIC"?"합성 리뷰 · 실제 구매 후기가 아니에요":row.sourceKind==="REAL"?"수집 리뷰 · 작성자의 의견이에요":"후기 출처 유형 확인 전"}</span>
   </li>)}</ul>
 </section>;
 if(!product&&!choices.length)return null;
 return <section className="brain-review-summary" aria-label="리뷰 요약 대상">
   {product&&<article className={`brain-review-summary-product${productImage?" has-image":""}`}>
     {productImage&&<img src={productImage} alt={product.name} loading="lazy" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}}/>}
     <div><b>{product.name}</b><button type="button" className="link brain-review-product-open" onClick={()=>onOpenProduct(product.id,product.variantId)}>상품 상세 보기</button></div>
   </article>}
   {choices.length>0&&<div className="brain-review-choices"><h3>어떤 상품의 리뷰를 요약할까요?</h3>
     {choices.map(choice=><button type="button" key={choice.productId} className="btn brain-review-choice"
       aria-label={`리뷰 요약 상품 선택: ${choice.name}`} onClick={()=>onChooseProduct(`리뷰 요약 상품 선택: ${choice.productId}`)}>{choice.name}</button>)}
   </div>}
   {product&&(productEvidence.length>0||variantEvidence.length>0)&&<div className="brain-review-evidence">
     <h3>요약에 사용한 후기 원문</h3>
     {renderEvidence("상품 단위 후기",productEvidence)}
     {renderEvidence("선택 옵션 후기",variantEvidence)}
   </div>}
 </section>;
}

export function BrainPreferencePrompt({selected,storedValue,status,pending,busy,error,onSelect,onRequest,onConfirm,onDefer}:{
 selected:PricePreference;storedValue:PricePreference|null;status:PreferencePromptStatus;pending:boolean;busy:boolean;error:string;
 onSelect:(value:PricePreference)=>void;onRequest:()=>void;onConfirm:()=>void;onDefer:()=>void;
}){
 const alreadySaved=storedValue===selected;
 return <section className="state-box brain-preference-prompt" aria-labelledby="brain-preference-title">
   <div><h3 id="brain-preference-title">이 가격 기준을 기억해둘까요?</h3>
     <p className="muted sm">다음 상품 추천에도 선택한 기준을 반영할 수 있어요.</p></div>
   <label className="brain-preference-select"><span>가격 기준</span>
     <select aria-label="가격 선호" value={selected} disabled={busy||status==="confirming"||status==="saving"} onChange={event=>onSelect(event.currentTarget.value as PricePreference)}>
       {pricePreferenceChoices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}
     </select>
   </label>
   {status==="idle"&&<>
     {alreadySaved?<p role="status" className="muted sm">이미 저장된 기준이에요.</p>
       :<button type="button" className="btn primary" onClick={onRequest} disabled={busy}>저장하기</button>}
     <button type="button" className="btn brain-preference-later" onClick={onDefer} disabled={busy}>원할 때 저장하고, 나중에 바꿀 수 있어요.</button>
   </>}
   {status==="requesting"&&<p role="status" className="muted sm">저장 요청 중…</p>}
   {status==="confirming"&&<>
     <p role="status" className="muted sm">저장 요청을 만들었어요. 최종 확인 후에 기억돼요.</p>
     <button type="button" className="btn primary" onClick={onConfirm} disabled={busy}>최종 확인</button>
     <button type="button" className="btn brain-preference-later" onClick={onDefer} disabled={busy}>원할 때 저장하고, 나중에 바꿀 수 있어요.</button>
   </>}
   {status==="saving"&&<p role="status" className="muted sm">저장 중…</p>}
   {status==="saved"&&<p role="status" className="muted sm">저장 완료</p>}
   {status==="failed"&&<>
     <p role="alert" className="brain-preference-error">{error||"선호 저장에 실패했어요. 기존에 저장한 기준은 유지돼요."}</p>
     <button type="button" className="btn primary" onClick={pending?onConfirm:onRequest} disabled={busy}>{pending?"다시 확인":"저장 요청 다시 하기"}</button>
     <button type="button" className="btn brain-preference-later" onClick={onDefer} disabled={busy}>원할 때 저장하고, 나중에 바꿀 수 있어요.</button>
   </>}
 </section>;
}

export function BrainPreview({onClose,onOpenProduct,pageContext}:{onClose:()=>void;onOpenProduct:(id:string,variantId?:string)=>void;pageContext?:unknown}){
 const [input,setInput]=useState("");
 const [conversation,setConversation]=useState<string|null>(null);
 const [conversations,setConversations]=useState<Conversation[]>([]);
 const [sourceMessage,setSourceMessage]=useState<string|null>(null);
 const [selected,setSelected]=useState<PricePreference>("value");
 const [pending,setPending]=useState<string|null>(null);
 const [pendingValue,setPendingValue]=useState<PricePreference|null>(null);
 const [preferenceStatus,setPreferenceStatus]=useState<PreferencePromptStatus>("idle");
 const [preferenceError,setPreferenceError]=useState("");
 const [memories,setMemories]=useState<MemoryItem[]>([]);
 const [deferredSourceMessage,setDeferredSourceMessage]=useState<string|null>(null);
 const [entries,setEntries]=useState<Entry[]>([]);
 const [busy,setBusy]=useState(false);
 const [restoring,setRestoring]=useState(true);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const lock=useRef(false),epoch=useRef(0),bottom=useRef<HTMLDivElement>(null),selectionTouched=useRef(false);
 const initialCreation=useRef<string|null>(null),newCreation=useRef<string|null>(null);
 const listConversations=async(generation=epoch.current)=>{
   const r=await apiSafe<{conversations:Conversation[]}>("/api/brain/conversations");
   if(generation===epoch.current&&r.ok)setConversations(r.data.conversations);
 };
 const applyHistory=(data:History)=>{
   setConversation(data.conversationId);setEntries(data.entries);
   setSourceMessage(data.entries.at(-1)?.reply?.message_id??null);
   setPending(null);setPendingValue(null);setPreferenceStatus("idle");setPreferenceError("");setDeferredSourceMessage(null);setInput("");
 };
 useEffect(()=>{
   const generation=epoch.current;
   void apiSafe<History>("/api/brain/history").then(r=>{
     if(generation!==epoch.current)return;
     if(r.ok)applyHistory(r.data);else setError("이전 대화를 복원하지 못했어요. 다시 열어 주세요.");
   }).finally(()=>{if(generation===epoch.current)setRestoring(false);});
   void listConversations(generation);
    void apiSafe<MemoryItem[]>("/api/brain/preferences").then(r=>{
      if(generation!==epoch.current||!r.ok)return;
      setMemories(r.data);
      const savedPrice=r.data.find(row=>row.key==="price_priority");
      if(!selectionTouched.current&&savedPrice&&isPricePreference(savedPrice.value))setSelected(savedPrice.value);
    });
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
   setBusy(true);setError("");setNotice("");setPending(null);setPendingValue(null);setPreferenceStatus("idle");setPreferenceError("");
   setDeferredSourceMessage(null);setSourceMessage(null);
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
        {method:"POST",body:JSON.stringify({user_message:entry.text,client_action_id:entry.clientActionId,
          ...(entry.pageContext?{page_context:entry.pageContext}:{})})});
     if(generation!==epoch.current)return;
     if(!r.ok){update({status:"failed",failure:friendlyFailure(r.error.code)});return;}
     if(r.data.conversation_id!==id){update({status:"failed",failure:"대화 결과를 확인하지 못했어요. 다시 시도해 주세요."});return;}
     update({reply:r.data,status:"completed",failure:undefined,conversationId:id});setSourceMessage(r.data.message_id);
     await listConversations(generation);
   }finally{if(generation===epoch.current){lock.current=false;setBusy(false);}}
 };
 const sendChoice=(text:string)=>{if(lock.current||restoring)return;
   const snapshot=pageContextSnapshot(pageContext);
   const entry:Entry={text,clientActionId:newActionKey(),...(conversation?{conversationId:conversation}:{}),...(snapshot?{pageContext:snapshot}:{}),status:"sending"};
   setEntries(previous=>[...previous,entry]);setInput("");void runEntry(entry);
 };
 const interview=resolveBrainInterviewState(entries,busy);
 const send=()=>{
   const text=input.trim();if(!text||lock.current||restoring)return;
   const snapshot=pageContextSnapshot(pageContext);
   const entry:Entry={text,clientActionId:newActionKey(),...(conversation?{conversationId:conversation}:{}),...(snapshot?{pageContext:snapshot}:{}),status:"sending"};
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
 const latestReply=entries.at(-1)?.reply;
 const currentSavedPrice=memories.find(memory=>memory.key==="price_priority");
 const storedPricePreference=currentSavedPrice&&isPricePreference(currentSavedPrice.value)?currentSavedPrice.value:null;
 const showPreferencePrompt=!!sourceMessage&&!!conversation&&latestReply?.explanation?.kind!=="REVIEW_SUMMARY"&&
   (latestReply?.ranking.ranked.length??0)>0&&deferredSourceMessage!==sourceMessage;
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
   const stored=memories.find(memory=>memory.key==="price_priority");
   const proposedValue=selected;
   if(!conversation||!sourceMessage||lock.current||pending||stored?.value===proposedValue)return;
   lock.current=true;setBusy(true);setPreferenceStatus("requesting");setPreferenceError("");setNotice("");
   try{
     const r=await apiSafe<{proposal_id:string}>("/api/brain/preferences/proposals",{method:"POST",body:JSON.stringify({conversation_id:conversation,source_message_id:sourceMessage,key:"price_priority",value:proposedValue})});
     if(r.ok&&typeof r.data.proposal_id==="string"&&r.data.proposal_id){setPending(r.data.proposal_id);setPendingValue(proposedValue);setPreferenceStatus("confirming");}
     else{setPending(null);setPendingValue(null);setPreferenceStatus("failed");setPreferenceError("선호 저장 요청을 만들지 못했어요. 기존에 저장한 기준은 유지돼요.");}
   }catch{setPending(null);setPendingValue(null);setPreferenceStatus("failed");setPreferenceError("선호 저장 요청에 실패했어요. 기존에 저장한 기준은 유지돼요.");}
   finally{lock.current=false;setBusy(false);}
 };
 const confirm=async()=>{
   const proposedValue=pendingValue;
   if(!pending||!proposedValue||lock.current)return;lock.current=true;setBusy(true);setPreferenceStatus("saving");setPreferenceError("");
   try{
     const r=await apiSafe<{key:string;value:string;updatedAt:string}>("/api/brain/preferences/confirm",{method:"POST",body:JSON.stringify({proposal_id:pending})});
     if(r.ok){
       if(!isPricePreferenceConfirmation(r.data,proposedValue)){
         setPreferenceStatus("failed");setPreferenceError("저장 결과를 선택한 기준과 확인하지 못했어요. 기존에 저장한 기준은 유지돼요.");return;
       }
       setPending(null);setPendingValue(null);setPreferenceStatus("saved");setPreferenceError("");
       setSelected(proposedValue);selectionTouched.current=true;
       setMemories(previous=>[...previous.filter(m=>m.key!==r.data.key),r.data]);
       setNotice("가격 기준을 저장했어요.");
       if(!await refresh())setNotice("가격 기준을 저장했어요. 저장 목록은 잠시 후 다시 확인해 주세요.");
     }else{setPreferenceStatus("failed");setPreferenceError("선호 저장 확인에 실패했어요. 기존에 저장한 기준은 유지돼요.");}
   }catch{setPreferenceStatus("failed");setPreferenceError("선호 저장 확인에 실패했어요. 기존에 저장한 기준은 유지돼요.");}
   finally{lock.current=false;setBusy(false);}
 };
 const clear=async()=>{
   if(lock.current)return;lock.current=true;setBusy(true);setError("");
   try{
     const r=await apiSafe<{deleted:boolean}>("/api/brain/preferences/price_priority",{method:"DELETE"});
     if(r.ok){setMemories(previous=>previous.filter(m=>m.key!=="price_priority"));setPending(null);setPendingValue(null);setPreferenceStatus("idle");setPreferenceError("");setNotice("저장된 가격 기준을 삭제했어요. 대화 기록과 현재 조건은 보존돼요.");}
     else setError("선호 삭제에 실패했어요.");
   }finally{lock.current=false;setBusy(false);}
 };
 const deferPreference=()=>{if(!sourceMessage||busy)return;setDeferredSourceMessage(sourceMessage);setNotice("원할 때 선호를 저장하고 나중에 바꿀 수 있어요.");};
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
        <div className="msg user"><p>{userFacingMessage(e.text)}</p></div>
       {e.status==="sending"&&<p role="status" className="muted sm">토스쇼핑 AI Brain이 요청을 살펴보고 있어요…</p>}
       {e.status==="failed"&&<div className="state-box error"><p role="alert">{e.failure}</p>
         <button className="link" disabled={busy} onClick={()=>retry(e)}>{isRetrievalUnavailable(e)?"다시 검색":"다시 시도"}</button>
         <button className="link" disabled={busy} onClick={()=>editQuestion(e)}>{isRetrievalUnavailable(e)?"조건 바꾸기":"질문 수정"}</button>
       </div>}
       {e.reply&&<><div className="brain-assistant-message"><span className="brain-avatar" aria-hidden="true">✦</span><div className="msg ai"><BrainAnswer text={e.reply.explanation?.failure
         ?e.reply.explanation.failure.code==="RETRIEVAL_UNAVAILABLE"
           ?e.reply.explanation.text.trim()||friendlyFailure(e.reply.explanation.failure.code)
           :e.reply.explanation.items.length>0?"AI 설명이 지연되어 확인된 상품 정보로 먼저 추천드려요. "+e.reply.explanation.text
             :friendlyFailure(e.reply.explanation.failure.code)+((e.reply.ranking.ranked.length+e.reply.ranking.referenceOnly.length)>0?" 아래 검색 결과는 확인할 수 있어요.":"")
         :e.reply.explanation?.text??"상품 정보를 확인했어요."}/></div></div>
         {isRetrievalUnavailable(e)&&<div className="brain-recovery-actions">
           <button className="link" disabled={busy} onClick={()=>retry(e)}>다시 검색</button>
           <button className="link" disabled={busy} onClick={()=>editQuestion(e)}>조건 바꾸기</button>
         </div>}
          {e.reply.explanation?.kind==="REVIEW_SUMMARY"&&e.reply.explanation.reviewSummary&&<BrainReviewSummary
            summary={e.reply.explanation.reviewSummary} onOpenProduct={onOpenProduct} onChooseProduct={sendChoice}/>}
          {e.reply.explanation?.kind!=="CONVERSATION"&&e.reply.explanation?.kind!=="CLARIFICATION"&&e.reply.explanation?.kind!=="REVIEW_SUMMARY"&&<BrainRanking explanation={e.reply.explanation} ranking={e.reply.ranking} onOpenProduct={onOpenProduct} onExcludeProduct={i===entries.length-1&&!busy?(id)=>sendChoice(`이 상품 제외: ${id}`):undefined}/>}
       </>}
     </div>)}
      {showPreferencePrompt&&<BrainPreferencePrompt selected={selected} storedValue={storedPricePreference} status={preferenceStatus}
        pending={!!pending} busy={busy} error={preferenceError}
        onSelect={value=>{selectionTouched.current=true;setSelected(value);setPending(null);setPendingValue(null);setPreferenceStatus("idle");setPreferenceError("");setNotice("");}}
        onRequest={()=>void propose()} onConfirm={()=>void confirm()} onDefer={deferPreference}/>}
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
