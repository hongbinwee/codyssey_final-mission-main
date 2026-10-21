import type {ReviewSort} from "./contracts.ts";

type ReviewPolarity="POSITIVE"|"NEGATIVE"|"NEUTRAL";

/** Fixed review-aspect vocabulary; canonical IDs are stable while labels remain Korean. */
const aspectDefinitions:Record<string,{label:string;terms:string[]} >={
 moisturizing:{label:"보습력",terms:["보습력","보습","수분감","수분","촉촉함","촉촉한","촉촉"]},
 comfort:{label:"사용감",terms:["사용감","발림성","편안함","편안한","부드러운"]},
 fit:{label:"착용감",terms:["착용감","착용이 편한","착용 편한"]},
 battery_life:{label:"배터리",terms:["배터리","사용시간","사용 시간"]},
 noise:{label:"소음",terms:["소음","조용함","조용한","정숙성"]},
 durability:{label:"내구성",terms:["내구성","튼튼함","튼튼한"]},
 cleaning_power:{label:"세정력",terms:["세정력","세척력"]},
 value:{label:"가성비",terms:["가성비","가격 대비"]},
 scent:{label:"향",terms:["향","냄새"]},
 connectivity:{label:"연결성",terms:["연결성","블루투스 연결"]},
 taste:{label:"맛",terms:["맛","고소함","달콤함"]},
 portability:{label:"휴대성",terms:["휴대성","휴대하기","가벼움","가벼운"]},
 performance:{label:"성능",terms:["성능","속도"]},
 quality:{label:"품질",terms:["품질","마감"]},
};

const positiveRequest=/긍정|좋은|호평|만족/;
const negativeRequest=/부정|나쁜|불만|혹평|싫은/;
const reviewRequest=/리뷰|후기|평가/;
const manyRequest=/많은\s*순|많이\s*언급|최다|가장\s*많/;
const negatedAspectRequest=/(?:촉촉하지|촉촉하진|촉촉한\s*(?:게|것이)\s*아니|촉촉함이\s*아니|촉촉하다는\s*(?:게\s*)?아니|아니라|말고)/;

/** Converts a supported Korean label or synonym to its bounded canonical aspect ID. */
export function normalizeReviewSortAspect(aspect:string):string|undefined{
 if(typeof aspect!=="string")return undefined;
 const value=aspect.normalize("NFKC").trim();
 if(Object.hasOwn(aspectDefinitions,value))return value;
 return Object.entries(aspectDefinitions).find(([,definition])=>
  definition.label===value||definition.terms.includes(value))?.[0];
}

/** Human-readable label for canonical IDs and original Korean aspect terms. */
export function reviewSortAspectLabel(aspect:string):string{
 const canonical=normalizeReviewSortAspect(aspect);
 return canonical?aspectDefinitions[canonical].label:aspect;
}

/** Only recognizes explicit positive-review-count ordering, never reverse or unrelated sorts. */
export function parseExplicitReviewSort(message:string):ReviewSort|undefined{
 if(typeof message!=="string"||message.length>2000)return undefined;
 const text=message.normalize("NFKC").replace(/\s+/g," ").trim();
 if(!text||negativeRequest.test(text)||negatedAspectRequest.test(text)||
   !reviewRequest.test(text)||!manyRequest.test(text))return undefined;
 const canonical=Object.entries(aspectDefinitions).find(([,definition])=>
  definition.terms.some(term=>text.includes(term)))?.[0];
 const positiveAspect=canonical==="moisturizing"&&/(?:촉촉하다는|촉촉한|촉촉함)/.test(text);
 if(!positiveAspect&&!positiveRequest.test(text))return undefined;
 return canonical?{aspect:canonical,direction:"MOST_POSITIVE"}:undefined;
}

const explicitPositive=/(?:긍정|호평|만족|만족스럽|추천|최고|훌륭|좋|우수|마음에\s*들|효과적|편리|안정적|기대\s*이상)/;
const explicitNegative=/(?:부정|혹평|불만|불만족|아쉬|실망|최악|나쁘|싫|후회|별로|부족|않|아니|못|없|불편|불량|건조|푸석|당김|시끄럽|금방\s*방전|빨리\s*닳|끊기)/;

/**
 * Classifies only a clearly stated opinion about the requested aspect. Matching
 * the aspect alone is neutral; mixed positive and negative language is neutral.
 */
export function reviewAspectPolarity(text:string,aspect:string):ReviewPolarity{
 const canonical=normalizeReviewSortAspect(aspect);
 if(typeof text!=="string"||!canonical||text.length>5000)return "NEUTRAL";
 const terms=aspectDefinitions[canonical].terms;
 const clauses=text.normalize("NFKC").split(/[.!?。！？;\n]+/).filter(Boolean);
 const outcomes=new Set<ReviewPolarity>();
 for(const clause of clauses){
  if(!terms.some(term=>clause.includes(term)))continue;
  const positive=explicitPositive.test(clause);
  const negative=explicitNegative.test(clause);
  if(positive!==negative)outcomes.add(positive?"POSITIVE":"NEGATIVE");
  else outcomes.add("NEUTRAL");
 }
 return outcomes.size===1?[...outcomes][0]:"NEUTRAL";
}
