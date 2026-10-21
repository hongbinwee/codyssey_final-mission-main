/** Built-in procedural shopping skills only. No user/LLM supplied skill code. */
export type SkillId="monitor"|"audio"|"general";
export interface ShoppingSkill {id:SkillId;title:string;focus:readonly string[];guidance:string}
const skills:Record<SkillId,ShoppingSkill>={
 monitor:{id:"monitor",title:"모니터 비교",
   focus:["용도와 예산","화면 크기·해상도","연결 호환성","장시간 사용 경험"],
   guidance:"When relevant, identify user-requested display size, resolution and connection constraints. Only treat them as requirements when explicitly stated. Never infer eye-fatigue reductions or monitor quality from missing reviews."},
 audio:{id:"audio",title:"오디오 제품 비교",
   focus:["용도·착용 환경","연결 방식","소음 관련 경험","호환성"],
   guidance:"When relevant, identify explicit fit, connection and noise requirements. Do not claim noise cancellation, battery endurance or comfort without verified item evidence."},
 general:{id:"general",title:"일반 쇼핑 비교",
   focus:["현재 구매 목적","총 예산","필수 조건","근거의 불확실성"],
   guidance:"Do not infer category-specific hard constraints. Keep the current user's task, verified product attributes, and evidence uncertainty distinct."}
};
export function selectShoppingSkill(query:string):ShoppingSkill{
 const q=query.slice(0,240).toLowerCase();
 const kind:SkillId=/모니터|monitor|display|디스플레이/.test(q)?"monitor"
  :/헤드폰|이어폰|headphone|earphone|headset|헤드셋/.test(q)?"audio":"general";
 return skills[kind];
}
