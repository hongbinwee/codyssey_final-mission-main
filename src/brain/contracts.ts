/** Contracts for an additive, read-only personalized ranking prototype. */
export type PreferenceKey = "price_priority" | "eye_comfort" | "noise_sensitivity";
export type PreferenceValue = "value" | "balanced" | "performance" | "important" | "normal";
export const MAX_DISPLAY_PRODUCTS = 3;
/** Bounded data-defined attributes; legacy names remain valid. */
export type Aspect = string;
export interface Preference { userId:string; key:PreferenceKey; value:PreferenceValue; sourceConversationId:string; sourceMessageId:string; updatedAt:string }
export interface MemoryRepository { list(userId:string):Promise<Preference[]>; put(p:Preference):Promise<void>; delete(userId:string,key:PreferenceKey):Promise<boolean> }
export interface PreferenceProofPort { verify(input:{actorUserId:string;key:PreferenceKey;value:PreferenceValue;conversationId:string;userMessageId:string;confirmationId:string}):Promise<boolean> }
export interface ShoppingContext { maxTotalWon:number|null;minTotalWon?:number; requiredConditions:string[]; currentPreferences:Partial<Record<PreferenceKey,PreferenceValue>>; category?:string;attributePreferences?:string[] }
export interface EvidenceRecord { id:string;productId:string;variantId:string|null;kind:"SPEC"|"REVIEW";sourceKind?:"REAL"|"SYNTHETIC";sourceRef?:string;text?:string;sourceId?:string;rating?:number;verified?:boolean;datasetVersion?:string }
export interface GroundedFacet {score:number;evidenceIds:string[]}
export interface ProductCandidate {productName?:string;productImage?:string;keywords?:string[];productId:string;variantId:string;unitPriceWon:number|null;shippingFeeWon:number|null;rating:number|null;ratingScale:number|null;wholeReviewCount:number|null;wholeReviewCountVerified:boolean;conditions:Record<string,string[]>;facets:Partial<Record<Aspect,GroundedFacet>>;sourceKind?:"REAL"|"SYNTHETIC";datasetVersion?:string;commerceVerified?:boolean;isSimulated?:boolean;qaRankingEligible?:boolean}
export interface RankedCandidate {candidate:ProductCandidate;score:number;evidenceCoverage:number;missingAspects:Aspect[];effectivePreferences:Record<PreferenceKey,PreferenceValue>;limitations?:string[];recommendationRole?:"PERSONALIZED"|"REVIEW_VERIFIED"|"ALTERNATIVE";personalizationSignals?:("CART"|"WISHLIST"|"PURCHASE")[]}
export interface BlockedCandidate {candidate:ProductCandidate;reasons:string[]}
export interface RankingResult {ranked:RankedCandidate[];referenceOnly:BlockedCandidate[];rejected:BlockedCandidate[];evaluatedCount:number}
export interface RetrieverPort {search(input:{query:string;maxTotalWon:number|null;requiredConditions:string[];preferences?:string[];requestId?:string;originalQuestion?:string;category?:string;reviewSortAspect?:string}):Promise<{candidates:ProductCandidate[];evidence:EvidenceRecord[];trace?:Record<string,number>}>}
export interface BrainTrace {actorUserId:string;conversationId:string;requestId:string}
