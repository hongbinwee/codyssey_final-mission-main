import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGroundedExplanation} from '../../src/brain/grounded-response.ts';
import type {ProductCandidate,RankingResult} from '../../src/brain/contracts.ts';
import type {ShoppingPlan} from '../../src/brain/shopping-plan.ts';

const candidate:ProductCandidate={productId:'p-detergent',variantId:'v-detergent',productName:'세제',
 unitPriceWon:20_000,shippingFeeWon:0,rating:null,ratingScale:null,wholeReviewCount:null,
 wholeReviewCountVerified:false,conditions:{},facets:{},sourceKind:'REAL',commerceVerified:true};
const plan:ShoppingPlan={query:'식기세척기 세제',maxTotalWon:10_000,requiredConditions:['무향'],currentPreferences:{},revision:1};
const empty:RankingResult={ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0};
const forbidden=/시연 데이터|참고 정보|검증 상태|REFERENCE_ONLY|Commerce/i;

test('empty search results name the query, budget, cause and next step in plain language',()=>{
 const result=buildGroundedExplanation(empty,[],plan);
 assert.equal(result.kind,'NO_MATCH');assert.equal(result.items.length,0);
 assert.match(result.text,/식기세척기 세제/);assert.match(result.text,/10,000원/);
 assert.match(result.text,/찾지 못했어요|검색 결과/);assert.match(result.text,/검색어|예산|조건/);
 assert.doesNotMatch(`${result.text}\n${result.limitations.join(' ')}`,forbidden);
});

test('budget rejection says the requested price range caused the empty result',()=>{
 const result=buildGroundedExplanation({...empty,evaluatedCount:1,rejected:[{candidate,reasons:['over_total_budget']}]},[],plan);
 assert.equal(result.kind,'NO_MATCH');
 assert.match(result.text,/식기세척기 세제/);assert.match(result.text,/10,000원/);
 assert.match(result.text,/예산.*(?:넘|초과|벗어나)/);
 assert.match(result.text,/높이거나|다른 상품/);
 assert.doesNotMatch(`${result.text}\n${result.limitations.join(' ')}`,forbidden);
});

test('mixed rejection reasons do not claim that the search returned no products',()=>{
 const result=buildGroundedExplanation({...empty,evaluatedCount:1,
   rejected:[{candidate,reasons:['over_total_budget','unverified_required_condition:무향']}]},[],plan);
 assert.match(result.text,/식기세척기 세제/);assert.match(result.text,/10,000원/);
 assert.match(result.text,/지금 조건으로 추천할 상품을 고르지 못했어요/);
 assert.doesNotMatch(result.text,/검색 결과를 찾지 못했어요/);
 assert.match(result.text,/예산|검색어|조건/);
});

test('missing mandatory facts and unavailable options each explain the cause and offer a next step',()=>{
 const missing=buildGroundedExplanation({...empty,evaluatedCount:1,
   rejected:[{candidate,reasons:['unverified_required_condition:무향']}]},[],plan);
 assert.match(missing.text,/무향/);assert.match(missing.text,/상품 정보에서.*확인하지 못했어요/);
 assert.match(missing.text,/조건을.*바꾸|다른 상품/);
 const unavailable=buildGroundedExplanation({...empty,evaluatedCount:1,
   rejected:[{candidate,reasons:['unavailable_variant']}]},[],plan);
 assert.match(unavailable.text,/선택할 수 있는 옵션/);assert.match(unavailable.text,/다른 상품/);
 assert.doesNotMatch(`${missing.text}\n${missing.limitations.join(' ')}\n${unavailable.text}`,forbidden);
});
