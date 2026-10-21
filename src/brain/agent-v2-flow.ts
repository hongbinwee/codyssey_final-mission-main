/** Domain-aware fast exits; never a replacement for actor-owned Tool verification. */
import type {ShoppingPlan} from "./shopping-plan.ts";
import type {BrainIntentKind} from "./routing.ts";
import type {RankingResult} from "./contracts.ts";
import type {AgentObservation} from "./hermes-agent-step.ts";
import {resolveDisplayedReviewTargets,type DisplayedReviewTarget} from "./review-targets.ts";

/** An explicit reference to a *displayed* recommendation's pros/cons can read
 * reviews without starting an unrelated catalog-wide search.
 * The LLM still chooses the Tool and server checks its product ID. */
export function isScopedProsConsFollowup(message:string,displayed?:readonly DisplayedReviewTarget[]):boolean{
 if(!resolveDisplayedReviewTargets(displayed,undefined,true))return false;
 const q=message.trim();
 if(q.length>140||/(?:추천|찾아|검색|비교|차이|가격|순서|순위|정렬|구매|취소|환불)/.test(q))return false;
 return /(?:[1-3]\s*번(?:째)?|첫\s*번째|두\s*번째|세\s*번째).{0,24}(?:단점|장점|아쉬운\s*점|좋은\s*점)/.test(q);
}

/** Skip an extra Agent decision only when we already have verified, ranked
 * candidates for a simple discovery. Attribute-focused and review-comparison
 * requests must not be short-circuited by arbitrary keyword exceptions. */
export function canFinishSimpleDiscovery(input:{
 intentKind:BrainIntentKind;ranking?:RankingResult;plan?:ShoppingPlan;
 observations:readonly AgentObservation[];
}):boolean{
 if(input.intentKind!=="SHOPPING_SEARCH"||!input.ranking?.ranked.length)return false;
 if(input.plan?.attributePreferences?.length)return false;
 if(input.observations.some(o=>o.tool!=="search_products"))return false;
 return input.ranking.ranked.some(row=>row.candidate.commerceVerified===true);
}
