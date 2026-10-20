import type {ShoppingPlan} from "./shopping-plan.ts";
import {reviewSummaryIntent} from "./review-summary.ts";

export type BrainIntentKind="GREETING"|"SOCIAL"|"CAPABILITY"|"SHOPPING_SEARCH"|"SHOPPING_FOLLOWUP"|"REVIEW_COMPARE"|"REVIEW_SUMMARY"|"CS_REQUEST"|"UNCERTAIN";
export interface BrainRoute {kind:BrainIntentKind;search:boolean;text?:string}
export const BRAIN_GREETING='안녕하세요! 😊 토스쇼핑 AI Brain이에요.\n\n찾으시는 상품이 있으신가요?\n원하시는 조건과 예산에 맞춰 찾아드릴게요!';
export const BRAIN_CAPABILITIES='토스쇼핑 AI Brain은 쇼핑 전담 AI 비서예요.\n\n원하는 상품을 찾고, 가격과 조건을 비교하며 확인된 리뷰의 장단점을 정리해 드려요.\n\n대화 중 조건을 바꿀 수 있고, 직접 저장한 선호를 다음 추천에도 활용해요.';
/** The active catalog's policy does not expose order reads to Brain. Never
 * bypass that policy via the unrestricted business pool or invent a history. */
export function serviceRequestRoute(message:string):BrainRoute|undefined{
 if(/추천|상품.*찾|제품.*찾|구매하고\s*싶|사고\s*싶/.test(message))return;
 const pastPurchase=/(?:구매|샀|샀었|샀는|산\s*(?:거|것|내역))/.test(message)&&/했|었|뭐|무엇|내역|기록|어제|그제|지난|언제/.test(message);
 const historyRequest=pastPurchase||/(?:주문|구매)\s*(?:내역|기록|조회|확인)|(?:내|제)\s*(?:주문|구매)(?:\s|$)/.test(message);
 if(/취소|환불|반품|교환/.test(message))return {kind:'CS_REQUEST',search:false,text:'주문 취소·반품 같은 변경 요청은 이 대화에서 아직 처리할 수 없어요.\n\n주문 화면에서 이용 가능한 절차를 확인해 주세요.'};
 const paymentQuery=/(?:내|제)\s*결제|(?:어제|그제|지난주).{0,8}결제|결제.{0,12}(?:상태|내역|확인|완료|언제|됐|했|되었|승인)|결제(?:했|됐)(?:어|나|는지)|결제한\s*(?:거|것|내역)/.test(message);
 if(paymentQuery)return {kind:'CS_REQUEST',search:false,text:'결제 여부나 결제 내역은 이 대화에서 확인하거나 처리할 수 없어요.\n\n결제 화면에서 확인해 주세요.'};
 if(/배송|택배/.test(message))return {kind:'CS_REQUEST',search:false,text:'배송 상황을 확인하고 싶으시군요.\n\n현재는 이 대화에서 배송 조회를 지원하지 않아요. 주문 화면에서 확인해 주세요.'};
 if(historyRequest)return {kind:'CS_REQUEST',search:false,text:'이전 구매 내역을 확인하고 싶으시군요!\n\n현재는 이 대화에 주문 내역 조회가 연결되어 있지 않아요.'};
}
/** Shared safety gate also applies to contextual interview answers. */
export function guardBrainMessage(text:string):BrainRoute|undefined {
 const shoppingQuestion=(value:string)=>/(?:.{2,}\s*(?:추천|찾아|검색|구매|살까|사고\s*싶|고르|비교))|(?:상품|제품|가격|예산|리뷰|후기|장단점)|(?:.{2,}(?:은|는)\s*(?:어때|괜찮))/.test(value);
 const shopping=shoppingQuestion(text);
 const role=()=>({kind:"UNCERTAIN" as const,search:false,text:"저는 상품 찾기와 비교를 도와드려요. 찾으시는 상품이나 궁금한 점을 알려주세요."});
 const attack=/(?:시스템\s*프롬프트|API\s*키|비밀번호|개인키).{0,25}(?:출력|공개|보여|알려|노출|검색)|(?:인증|권한|로그인).{0,15}우회|ignore.{0,20}(?:instructions|rules)|(?:이전|기존|모든).{0,8}(?:지침|규칙).{0,8}무시/i;
 // A separate normal shopping clause may proceed, but searching for credentials is not shopping.
 if(attack.test(text)&&!text.split(/[,.!?;\n]|그리고|(?:하고|한 뒤)\s*/).some(clause=>
   !attack.test(clause)&&shoppingQuestion(clause)&&!/(?:API\s*키|비밀번호|개인키|시스템\s*프롬프트)/i.test(clause)))return role();
 if(!shopping&&(/^[ㅋㅎㅠㅜ!?\s]+$/i.test(text)||/^(.{1,8})\1{2,}$/.test(text)||
   /^(?:asdf|qwer|zxcv){2,}$/i.test(text)))return {kind:"UNCERTAIN",search:false,text:"입력을 잘 이해하지 못했어요. 찾으시는 상품을 짧게 알려주시겠어요?"};
 if(!/(?:추천|찾아|상품|제품|가격|예산|리뷰|후기|장단점|비교)/.test(text)&&
    /날씨|주식\s*(?:전망|예측)|코드\s*(?:짜|작성)|정치|대통령|욕해|멍청|병신|씨발|바보/.test(text))return role();
 return serviceRequestRoute(text);
}
/** Pure, conservative routing: only complete social/help phrases bypass research. */
export function routeBrainMessage(message:string,previous?:ShoppingPlan):BrainRoute{
 const text=message.trim().replace(/[!?？!。.,~]+$/g,"").trim();
 const shoppingQuestion=(value:string)=>/(?:.{2,}\s*(?:추천|찾아|검색|구매|살까|사고\s*싶|고르|비교))|(?:상품|제품|가격|예산|리뷰|후기|장단점)|(?:.{2,}(?:은|는)\s*(?:어때|괜찮))/.test(value);
 const shopping=shoppingQuestion(text);
 const role=()=>({kind:"UNCERTAIN" as const,search:false,text:"저는 상품 찾기와 비교를 도와드려요. 찾으시는 상품이나 궁금한 점을 알려주세요."});
 const guarded=guardBrainMessage(text);if(guarded)return guarded;
 if(/^(안녕(?:하세요|하십니까)?|하이|반가워(?:요)?|hello|hi)$/i.test(text))
  return {kind:"GREETING",search:false,text:BRAIN_GREETING};
 if(/^(고마워(?:요)?|감사(?:합니다|해요)?|고맙습니다|thanks?|잘 알겠어(?:요)?)$/i.test(text))
  return {kind:"SOCIAL",search:false,text:"도움이 됐다니 좋아요. 더 궁금한 점이 있으면 말씀해 주세요."};
 if(!shopping&&/^(잘 지내(?:요)?|요즘 어때|좋은 하루(?: 보내)?|반가워(?:요)?|수고했어(?:요)?)$/i.test(text))
  return {kind:"SOCIAL",search:false,text:"반가워요. 오늘도 편하게 둘러보세요. 찾고 싶은 상품이 생기면 도와드릴게요."};
 if(/^(뭘 할 수 있(?:어|어요)|무엇을 할 수 있(?:어|나요)|기능(?: 소개| 알려줘)?|사용법|도움말|help)$/i.test(text))
  return {kind:"CAPABILITY",search:false,text:BRAIN_CAPABILITIES};
 if(!shopping&&/(?:내|제|주문번호|주문\s*(?:취소|변경|내역|조회)|환불|반품|교환\s*(?:신청|접수)|배송\s*(?:조회|추적|상태))/.test(text)&&
   /주문|취소|환불|반품|교환|배송/.test(text))
  return {kind:"CS_REQUEST",search:false,text:"주문 관련 요청은 주문 화면에서 이용 가능한 기능을 확인해 주세요."};
 const useCase=text.match(/(샤워(?:\s*할\s*때)?|운동(?:\s*할\s*때)?|잠(?:\s*잘\s*때)?|출근(?:\s*할\s*때)?|세안(?:\s*할\s*때)?|여행(?:\s*갈\s*때)?)/);
 const genericUseTarget=/(?:쓸|쓰는|사용할|사용하는|쓰려는)\s*(?:제품|상품|거|것|걸)|(?:쓰고|사용하고)\s*싶.{0,8}(?:제품|상품|거|것|걸)/;
 if(useCase&&(genericUseTarget.test(text)||
    /(?:상품|제품).{0,12}(?:모르겠|정하지\s*못|정해지지)/.test(text)&&
    /(?:쓰고\s*싶|사용하고\s*싶|쓸\s*제품|쓰려)/.test(text)))
  return {kind:"UNCERTAIN",search:false,text:`어떤 상품을 ${useCase[1]} 쓰고 싶으세요?`};
 if(/^(도와줘|도와주세요|뭐|음|글쎄|추천해\s*줘|골라\s*줘|아무거나|그거)$/i.test(text)&&!previous)
  return {kind:"UNCERTAIN",search:false,text:"어떤 상품을 찾으세요? 상품 종류와 대략적인 예산부터 알려주시면 돼요."};
 if(reviewSummaryIntent(text))return {kind:"REVIEW_SUMMARY",search:false};
 if(/리뷰|후기|장단점|비교/.test(text))return {kind:"REVIEW_COMPARE",search:true};
 if(previous&&(/^(그럼|그러면|그중|그 중|같은|그 제품|이 상품|좀 더|더 |예산|가격|조건|가성비|아까|이전|대신|이번엔|그대로|향|색상|사이즈|별로|맘에)/.test(text)||/^(?:[가-힣\w ]{2,40})(?:으로|로|이 중요해|가 중요해)$/.test(text)))
  return {kind:"SHOPPING_FOLLOWUP",search:true};
 if(text.length<2)return {kind:"UNCERTAIN",search:false,text:"찾으시는 상품이나 궁금한 점을 조금만 더 알려주세요."};
 return shopping?{kind:"SHOPPING_SEARCH",search:true}:{kind:"UNCERTAIN",search:false,text:"어떤 상품이나 조건을 말씀하시는지 조금만 더 알려주세요."};
}
