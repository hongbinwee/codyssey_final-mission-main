import {guardBrainMessage} from './routing.ts';
import type {ShoppingPlan} from './shopping-plan.ts';
import type {Preference,RankingResult} from './contracts.ts';
import {verifiedPriceTotal} from './price-sort.ts';
import {parseKrwTenThousandBand} from './price-band.ts';
export type InterviewKey='budget'|'purpose'|'product_type';
export type BudgetStatus='UNKNOWN'|'SET'|'UNRESTRICTED'|'DEFERRED';
export interface InterviewState {answered:InterviewKey[];pending:InterviewKey[];purpose?:string;typeQuestion?:string;budgetStatus?:BudgetStatus;budgetOptional?:boolean;budgetAsked?:boolean}
export interface InterviewQuestion {key:InterviewKey;text:string;choices:string[]}
const skip=/^(?:상관없(?:어|어요)?|아무거나|모르겠(?:어|어요)|그냥\s*(?:추천|찾아)(?:해)?\s*줘)[.!?\s]*$/;
const budget=/(\d+(?:,\d{3})*)\s*(만원|만\s*원|원)\s*(?:이하|까지)?/;
const unrestricted=/(?:예산|가격|금액)(?:은|는|이|가)?\s*(?:상관\s*없|제한\s*없|무관)|예산\s*없이/;
const unrestrictedAnswer=/^(?:예산|가격|금액)(?:은|는|이|가)?\s*(?:상관\s*없(?:어|어요)?|제한\s*없(?:어|어요)?|무관(?:해요)?)[.!?\s]*$/;
const deferred=/^(?:예산(?:은|을)?\s*)?(?:나중에\s*(?:정할게요|정할게|알려줄게요)|아직\s*(?:모르겠어요|모르겠어|안\s*정했어요))[.!?\s]*$/;
const unsafe=/시스템|프롬프트|비밀번호|api\s*key|ignore.{0,20}instruction|권한.{0,10}우회/i;
export function interviewAnswer(message:string,previous?:ShoppingPlan):ShoppingPlan|undefined {
 if(!previous)return;
 const text=message.trim();
 if(text==='조건 바꾸기')return {...previous,revision:previous.revision+1,interview:{...previous.interview,answered:(previous.interview?.answered??[]).filter(key=>key!=='budget'),pending:['budget'],budgetStatus:'UNKNOWN',budgetOptional:false,budgetAsked:false}};
 if(!previous.interview?.pending.length||unsafe.test(text)||guardBrainMessage(text))return;
 const state=previous.interview,answered=new Set(state.answered),pending=[...state.pending];
 // Skip applies only to the question actually displayed, never to unrelated conditions.
 if(skip.test(text)||pending[0]==='budget'&&deferred.test(text)){
  const key=pending[0];answered.add(key);
  const budgetStatus=key==='budget'?(previous.maxTotalWon!==null?'SET':/^상관없/.test(text)?'UNRESTRICTED':'DEFERRED'):state.budgetStatus;
  return {...previous,revision:previous.revision+1,
    interview:{...state,budgetStatus,answered:[...answered],pending:pending.slice(1)}};
 }
 const band=pending[0]==='budget'&&/^(?:(?:예산|가격)(?:은|는)?\s*)?[0-9만\s원~～–—-]+대[.!?\s]*$/.test(text)?parseKrwTenThousandBand(text):null;
 if(band){answered.add('budget');return {...previous,...band,revision:previous.revision+1,
  interview:{...state,budgetStatus:'SET',answered:[...answered],pending:pending.filter(k=>k!=='budget')}};}
 const match=/^(?:(?:예산|가격)(?:은|는)?\s*)?\d+(?:,\d{3})*\s*(?:만\s*원|원)\s*(?:이하|까지)?[.!?\s]*$/.test(text)&&!/미만|초과|이상|부터|최소|[-~]|만원대|만 원대/.test(text)?text.match(budget):null;
 if(pending.includes('budget')&&match){const value=Number(match[1].replaceAll(',',''))*(match[2].replace(/\s/g,'')==='만원'?10000:1);if(!Number.isSafeInteger(value)||value<0)return;answered.add('budget');return {...previous,maxTotalWon:value,minTotalWon:undefined,revision:previous.revision+1,interview:{...state,budgetStatus:'SET',answered:[...answered],pending:pending.filter(k=>k!=='budget')}};}
 if(pending.includes('budget')&&unrestrictedAnswer.test(text)){answered.add('budget');return {...previous,maxTotalWon:null,minTotalWon:undefined,revision:previous.revision+1,interview:{...state,budgetStatus:'UNRESTRICTED',answered:[...answered],pending:pending.filter(k=>k!=='budget')}};}
 if(pending[0]==='product_type'&&text.length>=2&&text.length<=80&&!/반드시|필수|제외|말고|\d|주문|취소|환불|안녕|고마/.test(text)){
   const query=text.replace(/(?:으로|로)[.!?\s]*$/,'').trim();
   if(query.length<2)return;
   answered.add('product_type');return {...previous,query,revision:previous.revision+1,
     excludedProductIds:[],lastDisplayedProductIds:[],interview:{...state,typeQuestion:undefined,answered:[...answered],pending:pending.slice(1)}};
 }
 if(/\d/.test(text)||/사고|구매|살까|추천|찾아|검색|골라|바꾸|대신|말고/.test(text))return;
 if(pending.includes('purpose')&&text.length>=2&&text.length<=120&&(/용|사용|쓰|쓸|중요|선호|원해|좋겠|필요|여행|선물|통화|운동/.test(text)||/^[가-힣A-Za-z]{2,12}$/.test(text))&&!/필수|반드시|추천|검색|찾아|고마|안녕|주문|취소|배송|환불|뭘 할|무엇을/.test(text)){
  answered.add('purpose');return {...previous,revision:previous.revision+1,interview:{...state,answered:[...answered],pending:pending.filter(k=>k!=='purpose'),purpose:text}};
 }
}
export function needsInterview(plan:ShoppingPlan,message:string,memories:Preference[]):InterviewQuestion[]{
 const answered=new Set(plan.interview?.answered??[]);
 const forced=message.trim()==='조건 바꾸기';
 if(forced||plan.interview?.pending[0]==='budget'&&!plan.interview.budgetOptional)return [{key:'budget',text:'예산을 얼마로 바꿔볼까요?',choices:['예산은 1만원 이하','예산은 3만원 이하','예산은 5만원 이하','예산은 상관없어요']}];
 // Named product requests already provide a searchable target. Broad goal/category
 // requests may need a type; no universal daily/gift or mandatory budget gate.
 const broad=/^(?:.{0,30}(?:식품|제품|상품)|아무거나)$/.test(plan.query.trim());
 if(!answered.has('product_type')&&(broad||plan.interview?.typeQuestion))return [{key:'product_type',
   text:plan.interview?.typeQuestion??`어떤 종류의 ${plan.query.trim()==='아무거나'?'상품':plan.query.trim()}을 찾으세요? 원하는 형태나 제품 종류를 적어주세요.`,choices:['상관없어요']}];
 return [];
}

/** Only actual answers resolve a question; old auto-answered checkpoints do not prove a budget. */
export function rememberInterview(plan:ShoppingPlan,message:string,memories:Preference[]):ShoppingPlan {
 const questions=needsInterview(plan,message,memories).filter(question=>question.key!=='budget'||
  message.trim()==='조건 바꾸기'||plan.maxTotalWon===null&&!plan.priceSortOrder&&!plan.reviewSortAspect);
 const budgetStatus:BudgetStatus=plan.maxTotalWon!==null?'SET':unrestricted.test(message)?'UNRESTRICTED':
  plan.interview?.budgetStatus==='UNRESTRICTED'||plan.interview?.budgetStatus==='DEFERRED'?plan.interview.budgetStatus:'UNKNOWN';
 const answered:InterviewKey[]=(plan.interview?.answered??[]).filter(key=>key!=='budget'&&key!=='purpose');
 if(budgetStatus!=='UNKNOWN')answered.push('budget');
 if(plan.interview?.purpose)answered.push('purpose');
 return {...plan,...(budgetStatus==='UNRESTRICTED'?{maxTotalWon:null,minTotalWon:undefined}:{}),
  interview:{...plan.interview,budgetStatus,answered:[...new Set(answered)],pending:questions.map(q=>q.key)}};
}

/** Ask after retrieval using verified totals, never a mandatory pre-search budget gate. */
export function recommendationBudgetQuestion(plan:ShoppingPlan,ranking:RankingResult):InterviewQuestion|undefined {
 if(plan.maxTotalWon!==null||plan.minTotalWon!==undefined||plan.priceSortOrder||plan.reviewSortAspect||
   plan.interview?.budgetAsked||plan.interview?.budgetStatus&&plan.interview.budgetStatus!=='UNKNOWN')return;
 const displayed=new Set(plan.lastDisplayedProductIds??[]);
 const products=[...new Map(ranking.ranked.filter(row=>displayed.has(row.candidate.productId))
  .map(row=>[row.candidate.productId,row.candidate])).values()];
 const totals=products.map(verifiedPriceTotal);
 if(!totals.length||totals.some(total=>total===null))return;
 const min=Math.min(...totals as number[]),max=Math.max(...totals as number[]);
 // ponytail: bounded first page only; ask on one option or a >=2x spread, not a catalogue-wide price claim.
 if(products.length!==1&&!(min>0&&max>=min*2))return;
 const prices=min===max?min.toLocaleString('ko-KR')+'원':min.toLocaleString('ko-KR')+'~'+max.toLocaleString('ko-KR')+'원';
 return {key:'budget',text:`현재 확인한 상품은 배송비 포함 ${prices}이에요. 생각하신 총예산이 있나요?`,
  choices:['예산은 1만원 이하','예산은 3만원 이하','예산은 5만원 이하','예산은 상관없어요','나중에 정할게요']};
}
