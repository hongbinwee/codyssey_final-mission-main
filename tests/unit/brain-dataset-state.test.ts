import test from 'node:test';
import assert from 'node:assert/strict';
import {currentDatasetResult} from '../../src/brain/dataset-state.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';
test('dataset transition preserves preferences and immutable history while clearing old displayed targets',()=>{
 const old={datasetVersion:'old',pendingReview:{productId:'old',focus:'CONS'},recentTurns:[{user:'old product',assistant:'old review'}],shoppingPlan:{query:'cream',revision:3,maxTotalWon:20000,requiredConditions:['무향'],currentPreferences:{price_priority:'value'},
  lastDisplayedProductIds:['old'],lastDisplayedProducts:[{productId:'old',displayIndex:1}]},
  ranking:{ranked:[{candidate:{productId:'old'}}],referenceOnly:[],rejected:[]},explanation:{kind:'VERIFIED_CANDIDATES',text:'old facts',items:[{}]}} as unknown as ResearchResult;
 const safe=currentDatasetResult(old,'new');assert.notEqual(safe.shoppingPlan,old.shoppingPlan);
 assert.equal(safe.shoppingPlan?.lastDisplayedProductIds,undefined);assert.equal(safe.shoppingPlan?.lastDisplayedProducts,undefined);
 assert.equal(safe.pendingReview,undefined);assert.equal(safe.recentTurns,undefined);
 assert.equal(old.pendingReview?.productId,'old');assert.equal(old.recentTurns?.length,1);
 assert.equal(safe.shoppingPlan?.maxTotalWon,20000);assert.deepEqual(safe.shoppingPlan?.requiredConditions,['무향']);
 assert.deepEqual(safe.shoppingPlan?.currentPreferences,{price_priority:'value'});
 assert.equal(safe.ranking.ranked.length,0);assert.equal(safe.explanation?.kind,'CONVERSATION');assert.equal(old.ranking.ranked.length,1);
 assert.deepEqual(old.shoppingPlan?.lastDisplayedProductIds,['old']);
 assert.equal(currentDatasetResult(old,'old'),old);
 assert.equal(currentDatasetResult({...old,datasetVersion:undefined},'new').ranking.ranked.length,0);
});
