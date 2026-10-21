import test from "node:test";
import assert from "node:assert/strict";
import {parseKrwTenThousandBand} from "../../src/brain/price-band.ts";
import {parseShoppingIntent} from "../../src/brain/intent.ts";
import {createFastIntentPort} from "../../src/brain/fast-intent.ts";
import {createIntentPort} from "../../src/brain/intent.ts";
import {resolveShoppingPlan} from "../../src/brain/shopping-plan.ts";
import {interviewAnswer} from "../../src/brain/interview.ts";

test("explicit ten-thousand KRW ranges preserve their exact inclusive endpoints",()=>{
 assert.deepEqual(parseKrwTenThousandBand("헤드폰 1~3만원대 추천해줘"),
  {minTotalWon:10000,maxTotalWon:39999});
 assert.deepEqual(parseKrwTenThousandBand("헤드폰 1만~3만원대 추천해줘"),
  {minTotalWon:10000,maxTotalWon:39999});
 assert.deepEqual(parseKrwTenThousandBand("10~20만원대"),
  {minTotalWon:100000,maxTotalWon:299999});
});

test("invalid or ambiguous price ranges fail closed while single bands remain exact",()=>{
 for(const input of ["3~1만원대","1~1만원대","0~3만원대","1~1000만원대",
   "1~3만원대와 5만원대","1~3만원대 이하","1~3만원대 정도"])
  assert.equal(parseKrwTenThousandBand(input),null,input);
 assert.deepEqual(parseKrwTenThousandBand("2만원대"),{minTotalWon:20000,maxTotalWon:29999});
 assert.equal(parseKrwTenThousandBand("2만원대 이하"),null);
});

test("shopping intent accepts a validated minimum and rejects malformed ranges",()=>{
 const parsed=parseShoppingIntent(JSON.stringify({query:"헤드폰",maxTotalWon:39999,minTotalWon:10000,
  requiredConditions:[],currentPreferences:{},queryMode:"SET",budgetMode:"SET"}));
 assert.equal(parsed.context.minTotalWon,10000);
 assert.equal(parsed.context.maxTotalWon,39999);
 for(const values of [[39999,40000],[0,-1],[null,10000]] as const){
  const [maxTotalWon,minTotalWon]=values;
  assert.throws(()=>parseShoppingIntent(JSON.stringify({query:"헤드폰",maxTotalWon,minTotalWon,
   requiredConditions:[],currentPreferences:{},queryMode:"SET",budgetMode:"SET"})));
 }
});

test("plan SET applies both range bounds and follow-up KEEP preserves both",()=>{
 const previous={query:"headphones",maxTotalWon:50000,minTotalWon:10000,revision:3,
  requiredConditions:["Bluetooth"],currentPreferences:{price_priority:"value" as const}};
 const kept=resolveShoppingPlan(previous,{query:"headphones",queryMode:"KEEP",budgetMode:"KEEP",
  requirementsMode:"KEEP",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}});
 assert.deepEqual([kept.minTotalWon,kept.maxTotalWon],[10000,50000]);
 const ranged=resolveShoppingPlan(kept,{query:"headphones",queryMode:"KEEP",budgetMode:"SET",
  requirementsMode:"KEEP",context:{minTotalWon:10000,maxTotalWon:39999,requiredConditions:[],currentPreferences:{}}});
 assert.deepEqual([ranged.minTotalWon,ranged.maxTotalWon],[10000,39999]);
});

test("fast intent sends explicit ranges to the lossless planner and keeps its bounds",async()=>{
 let calls=0;
 const port=createFastIntentPort({async extract(){calls++;return {query:"헤드폰",queryMode:"SET",budgetMode:"SET",
  context:{minTotalWon:10000,maxTotalWon:39999,requiredConditions:[],currentPreferences:{}}};}});
 const intent=await port.extract("1~3만원대 헤드폰 추천해줘",[]);
 assert.equal(calls,1);
 assert.deepEqual([intent.context.minTotalWon,intent.context.maxTotalWon],[10000,39999]);
});

test("budget interview accepts exact ranges and rejects reversed ranges",()=>{
 const previous={query:"헤드폰",maxTotalWon:null,revision:2,requiredConditions:[],currentPreferences:{},
  interview:{answered:[],pending:["budget" as const]}};
 const result=interviewAnswer("예산은 1~3만원대",previous);
 assert.deepEqual([result?.minTotalWon,result?.maxTotalWon],[10000,39999]);
 assert.deepEqual(result?.interview?.pending,[]);
 const single=interviewAnswer("예산은 2만원대",previous);
 assert.deepEqual([single?.minTotalWon,single?.maxTotalWon],[20000,29999]);
 const cap=interviewAnswer("예산은 3만원 이하",previous);
 assert.equal(cap?.maxTotalWon,30000);
 assert.equal(cap?.minTotalWon,undefined);
 assert.equal(interviewAnswer("예산은 3~1만원대",previous),undefined);
});

test("review sort requires an exact current-message aspect and positive review wording",async()=>{
 const raw=JSON.stringify({query:"수분크림",maxTotalWon:null,requiredConditions:[],currentPreferences:{},
  reviewSort:{aspect:"보습력",direction:"MOST_POSITIVE"}});
 assert.deepEqual(parseShoppingIntent(raw,"보습력 긍정 후기가 많은 순으로 보여줘").context.reviewSort,
  {aspect:"보습력",direction:"MOST_POSITIVE"});
 assert.equal(parseShoppingIntent(raw,"평점 높은 순으로 보여줘").context.reviewSort,undefined);
 assert.equal(parseShoppingIntent(raw,"보습력 후기 많은 순으로 보여줘").context.reviewSort,undefined);
 assert.equal(parseShoppingIntent(raw,"보습력 긍정 후기가 아니라 별점 높은 순으로 보여줘").context.reviewSort,undefined);
 assert.equal(parseShoppingIntent(raw,"진정력 긍정 후기 많은 순으로 보여줘").context.reviewSort,undefined);
 assert.equal(parseShoppingIntent(raw).context.reviewSort,undefined);
 assert.throws(()=>parseShoppingIntent(JSON.stringify({query:"수분크림",maxTotalWon:null,
  requiredConditions:[],currentPreferences:{},reviewSort:{aspect:"보습력!",direction:"MOST_POSITIVE"}}),
  "보습력! 긍정 후기가 많은 순으로 보여줘"));
 assert.throws(()=>parseShoppingIntent(JSON.stringify({query:"수분크림",maxTotalWon:null,
  requiredConditions:[],currentPreferences:{},reviewSort:{aspect:"보습력",direction:"HIGHEST"}}),
  "보습력 긍정 후기가 많은 순으로 보여줘"));
 let calls=0;let system="";
 const port=createIntentPort({async complete(prompt){calls++;system=prompt;return raw;}});
 const intent=await port.extract("보습력 긍정 후기가 많은 순으로 보여줘",[]);
 assert.equal(calls,1);
 assert.deepEqual(intent.context.reviewSort,{aspect:"보습력",direction:"MOST_POSITIVE"});
 assert.match(system,/reviewSort/);
});

test("review sort is validated, retained on a same-query SET fallback, and cleared for a new task",()=>{
 const sort={aspect:"보습력",direction:"MOST_POSITIVE" as const};
 const previous={query:"수분크림",maxTotalWon:40000,minTotalWon:10000,revision:3,
  requiredConditions:[],currentPreferences:{},reviewSort:sort};
 const same=resolveShoppingPlan(previous,{query:"수분크림",queryMode:"SET",budgetMode:"KEEP",
  requirementsMode:"KEEP",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}});
 assert.deepEqual(same.reviewSort,sort);
 const changed=resolveShoppingPlan(same,{query:"세럼",queryMode:"SET",budgetMode:"CLEAR",
  requirementsMode:"REPLACE",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}});
 assert.equal(changed.reviewSort,undefined);
 const replaced=resolveShoppingPlan(same,{query:"수분크림",queryMode:"SET",budgetMode:"KEEP",
  requirementsMode:"KEEP",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{},
   reviewSort:{aspect:"사용감",direction:"MOST_POSITIVE"}}});
 assert.deepEqual(replaced.reviewSort,{aspect:"사용감",direction:"MOST_POSITIVE"});
 for(const reviewSort of [
  {aspect:"",direction:"MOST_POSITIVE"},{aspect:"보습력".repeat(14),direction:"MOST_POSITIVE"},
  {aspect:"보습력",direction:"LOWEST"},{aspect:"보습력",direction:"MOST_POSITIVE",extra:true},
  {aspect:"보습력!",direction:"MOST_POSITIVE"},
 ] as unknown[]){
  assert.throws(()=>resolveShoppingPlan(same,{query:"수분크림",queryMode:"KEEP",budgetMode:"KEEP",
   requirementsMode:"KEEP",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{},reviewSort} as never}));
 }
});
