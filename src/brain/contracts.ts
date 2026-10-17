/** Contracts for an additive, read-only personalized ranking prototype. */
export type PreferenceKey = "price_priority" | "eye_comfort" | "noise_sensitivity";
export type PreferenceValue = "value" | "balanced" | "performance" | "important" | "normal";
export type Aspect = "performance" | "eye_comfort" | "noise";
export interface Preference { userId:string; key:PreferenceKey; value:PreferenceValue; sourceConversationId:string; sourceMessageId:string; updatedAt:string }
export interface MemoryRepository { list(userId:string):Promise<Preference[]>; put(p:Preference):Promise<void>; delete(userId:string,key:PreferenceKey):Promise<boolean> }
export interface PreferenceProofPort { verify(input:{actorUserId:string;key:PreferenceKey;value:PreferenceValue;conversationId:string;userMessageId:string;confirmationId:string}):Promise<boolean> }
export interface ShoppingContext { maxTotalWon:number|null; requiredConditions:string[]; currentPreferences:Partial<Record<PreferenceKey,PreferenceValue>> }
export interface EvidenceRecord { id:string;productId:string;variantId:string|null;kind:"SPEC"|"REVIEW";sourceKind?:"REAL"|"SYNTHETIC";sourceRef?:string }
export interface GroundedFacet {score:number;evidenceIds:string[]}
export interface ProductCandidate {productName?:string;productId:string;variantId:string;unitPriceWon:number|null;shippingFeeWon:number|null;rating:number|null;ratingScale:number|null;wholeReviewCount:number|null;wholeReviewCountVerified:boolean;conditions:Record<string,string[]>;facets:Partial<Record<Aspect,GroundedFacet>>}
export interface RankedCandidate {candidate:ProductCandidate;score:number;evidenceCoverage:number;missingAspects:Aspect[];effectivePreferences:Record<PreferenceKey,PreferenceValue>}
export interface BlockedCandidate {candidate:ProductCandidate;reasons:string[]}
export interface RankingResult {ranked:RankedCandidate[];referenceOnly:BlockedCandidate[];rejected:BlockedCandidate[];evaluatedCount:number}
export interface RetrieverPort {search(input:{query:string;maxTotalWon:number|null;requiredConditions:string[]}):Promise<{candidates:ProductCandidate[];evidence:EvidenceRecord[]}>}
export interface BrainTrace {actorUserId:string;conversationId:string;requestId:string}
