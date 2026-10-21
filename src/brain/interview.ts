import {guardBrainMessage} from './routing.ts';
import type {ShoppingPlan} from './shopping-plan.ts';
import type {Preference} from './contracts.ts';
import {parseKrwTenThousandBand} from './price-band.ts';
export type InterviewKey='budget'|'purpose'|'product_type';
export interface InterviewState {answered:InterviewKey[];pending:InterviewKey[];purpose?:string;typeQuestion?:string}
export interface InterviewQuestion {key:InterviewKey;text:string;choices:string[]}
const skip=/^(?:상관없(?:어|어요)?|아무거나|모르겠(?:어|어요)|그냥\s*(?:추천|찾아)(?:해)?\s*줘)[.!?\s]*$/;
const budget=/(\d+(?:,\d{3})*)\s*(만원|만\s*원|원)\s*(?:이하|까지)?/;
const unsafe=/시스템|프롬프트|비밀번호|api\s*key|ignore.{0,20}instruction|권한.{0,10}우회/i;
const budgetChoices=['예산은 1만원 이하','예산은 3만원 이하','예산은 5만원 이하','예산은 상관없어요'];
const hasStoredBudget=(plan:ShoppingPlan)=>(Number.isSafeInteger(plan.maxTotalWon)&&plan.maxTotalWon!==null&&plan.maxTotalWon>=0)||
 (Number.isSafeInteger(plan.minTotalWon)&&plan.minTotalWon!==undefined&&plan.minTotalWon>=0);
const hasBudgetWaiver=(text:string)=>/예산.{0,12}(?:상관없|무관|제한\s*없)/.test(text);
const hasExplicitPrice=(text:string)=>budget.test(text);
const hasExplicitBudget=(text:string)=>hasExplicitPrice(text)||hasBudgetWaiver(text);
const hasExplicitPurpose=(text:string)=>/(?:[가-힣A-Za-z0-9]{1,12}용|선물할|용도|목적|사용(?:할|하려|하기)|쓰려고|쓸)/u.test(text);
const hasPlanDetail=(plan:ShoppingPlan)=>hasStoredBudget(plan)||(plan.requiredConditions?.length??0)>0||
 Object.keys(plan.currentPreferences??{}).length>0||(plan.attributePreferences?.length??0)>0||!!plan.reviewSort||
 !!plan.interview?.purpose?.trim();
const hasUsefulInfo=(plan:ShoppingPlan,message:string,memories:Preference[])=>hasPlanDetail(plan)||
 hasExplicitBudget(message)||hasExplicitPurpose(message)||memories.some(memory=>memory.key==='price_priority');
const budgetQuestion=(change=false):InterviewQuestion=>({key:'budget',text:change?'예산을 얼마로 바꿔볼까요?':'예산은 어느 정도로 생각하세요?',choices:budgetChoices});
const recommendationRequest=(message:string)=>/(?:추천|구매|구입|사고\s*싶|살까|살\s*거|필요해)/.test(message);
export function interviewAnswer(message:string,previous?:ShoppingPlan):ShoppingPlan|undefined {
 if(!previous)return;
 const text=message.trim();
 if(text==='조건 바꾸기')return {...previous,revision:previous.revision+1,interview:{...previous.interview,answered:[],pending:['budget']}};
 if(!previous.interview?.pending.length||unsafe.test(text)||guardBrainMessage(text))return;
 const state=previous.interview,answered=new Set(state.answered),pending=[...state.pending];
 // Skip applies only to the question actually displayed, never to unrelated conditions.
 if(skip.test(text)){const key=pending[0];answered.add(key);return {...previous,revision:previous.revision+1,interview:{...state,answered:[...answered],pending:pending.slice(1)}};}
 const budgetText=text.replace(/^(?:예산|가격)(?:은|는)?\s*/,"");
 const exactBand=/^\d{1,3}\s*만\s*원대[.!?？]*$/.test(budgetText);
 const exactRange=/^\d{1,3}\s*(?:만\s*)?[~〜～]\s*\d{1,3}\s*만\s*원대[.!?？]*$/.test(budgetText);
 if(pending.includes('budget')&&(exactBand||exactRange)){
  const band=parseKrwTenThousandBand(budgetText);
  if(!band)return;
  answered.add('budget');
  return {...previous,...band,revision:previous.revision+1,
   interview:{...state,answered:[...answered],pending:pending.filter(k=>k!=='budget')}};
 }
 const match=/^(?:(?:예산|가격)(?:은|는)?\s*)?\d+(?:,\d{3})*\s*(?:만\s*원|원)\s*(?:이하|까지)?[.!?\s]*$/.test(text)&&!/미만|초과|이상|부터|최소|[-~]|만원대|만 원대/.test(text)?text.match(budget):null;
 if(pending.includes('budget')&&match){const value=Number(match[1].replaceAll(',',''))*(match[2].replace(/\s/g,'')==='만원'?10000:1);if(!Number.isSafeInteger(value)||value<0)return;answered.add('budget');return {...previous,maxTotalWon:value,minTotalWon:undefined,revision:previous.revision+1,interview:{...state,answered:[...answered],pending:pending.filter(k=>k!=='budget')}};}
 if(pending.includes('budget')&&/^(?:예산|가격)(?:은|는)?\s*상관없어요[.!?\s]*$/.test(text)){answered.add('budget');return {...previous,maxTotalWon:null,minTotalWon:undefined,revision:previous.revision+1,interview:{...state,answered:[...answered],pending:pending.filter(k=>k!=='budget')}};}
 if(pending[0]==='product_type'&&text.length>=2&&text.length<=80&&!/반드시|필수|제외|말고|\d|주문|취소|환불|안녕|고마/.test(text)){
   const query=text.replace(/(?:으로|로)[.!?\s]*$/,'').trim();
   if(query.length<2)return;
   answered.add('product_type');return {...previous,query,revision:previous.revision+1,
     excludedProductIds:[],lastDisplayedProductIds:[],interview:{...state,typeQuestion:undefined,answered:[...answered],pending:pending.slice(1)}};
 }
 if(/\d/.test(text)||/사고|구매|살까|추천|찾아|검색|골라|바꾸|대신|말고/.test(text))return;
 if(pending.includes('purpose')&&text.length>=2&&text.length<=120&&(/용|사용|쓰|쓸|중요|선호|원해|좋겠|필요|여행|선물|통화|운동/.test(text)||/^[가-힣A-Za-z]{2,12}$/.test(text))&&!/필수|반드시|추천|검색|찾아|고마|안녕|주문|취소|배송|환불|뭘 할|무엇을/.test(text)){
  answered.add('purpose');return {...previous,revision:previous.revision+1,interview:{answered:[...answered],pending:pending.filter(k=>k!=='purpose'),purpose:text}};
 }
}
export function needsInterview(plan:ShoppingPlan,message:string,memories:Preference[]):InterviewQuestion[]{
 const answered=new Set(plan.interview?.answered??[]);
 const forced=message.trim()==='조건 바꾸기';
 if(forced)return [budgetQuestion(true)];
 if(plan.interview?.pending[0]==='budget'){
  if(answered.has('budget')||hasBudgetWaiver(message)||(hasExplicitPrice(message)&&hasStoredBudget(plan)))return [];
  // Old checkpoints could retain an already answered purpose beside a stale budget prompt.
  if(plan.interview.pending.includes('purpose')&&hasStoredBudget(plan)&&plan.interview.purpose)return [];
  return [budgetQuestion()];
 }
 // Named product requests already provide a searchable target. Broad goal/category
 // requests may need a type; budget is optional and only asked for a new recommendation.
 const broad=/^(?:.{0,30}(?:식품|제품|상품)|아무거나)$/.test(plan.query.trim());
 if(!answered.has('product_type')&&(broad||plan.interview?.typeQuestion))return [{key:'product_type',
   text:plan.interview?.typeQuestion??`어떤 종류의 ${plan.query.trim()==='아무거나'?'상품':plan.query.trim()}을 찾으세요? 원하는 형태나 제품 종류를 적어주세요.`,choices:['상관없어요']}];
 if(answered.has('budget')||answered.has('product_type')||hasUsefulInfo(plan,message,memories)||!recommendationRequest(message))return [];
 return [budgetQuestion()];
}

export function rememberInterview(plan:ShoppingPlan,message:string,memories:Preference[]):ShoppingPlan {
 const questions=needsInterview(plan,message,memories);
 const pending=questions.map(q=>q.key),missing=new Set(pending),answered=new Set(plan.interview?.answered??[]);
 if(!missing.has('budget')&&(hasStoredBudget(plan)||hasExplicitBudget(message)))answered.add('budget');
 if(!missing.has('purpose')&&(plan.interview?.purpose||hasExplicitPurpose(message)))answered.add('purpose');
 return {...plan,interview:{...plan.interview,answered:[...answered],pending}};
}
