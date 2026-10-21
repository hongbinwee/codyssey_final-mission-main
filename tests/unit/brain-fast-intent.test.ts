import test from "node:test";
import assert from "node:assert/strict";
import {createFastIntentPort} from "../../src/brain/fast-intent.ts";
test("obvious requests and budget follow-ups avoid LLM and never manufacture preferences",async()=>{
 let calls=0;const port=createFastIntentPort({async extract(){calls++;throw Error("unnecessary model call");}});
 const first=await port.extract("안녕, 5만원 이하 수분크림 추천해줘",[]);
 assert.equal(first.query,"수분크림");assert.equal(first.context.maxTotalWon,50000);
 assert.deepEqual(first.context.currentPreferences,{});
 const previous={query:first.query,...first.context,revision:1};
 const next=await port.extract("그럼 예산은 3만원 이하로",[],previous);
 assert.equal(next.queryMode,"KEEP");assert.equal(next.budgetMode,"SET");assert.equal(next.context.maxTotalWon,30000);
 assert.equal(calls,0);
});
test("named two-word product types avoid a model clarification while condition phrases still fall back",async()=>{
 let calls=0;const port=createFastIntentPort({async extract(message){calls++;return {query:`fallback:${message}`,context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};}});
 for(const [message,query] of [["단백질 쉐이크 추천해줘","단백질 쉐이크"],["식기세척기 세제 찾아줘","식기세척기 세제"]]){
  const parsed=await port.extract(message,[]);assert.equal(parsed.query,query);assert.equal(parsed.queryMode,"SET");
 }
 assert.equal(calls,0);
 const qualified=await port.extract("무선 헤드폰 추천해줘",[]);
 assert.equal(qualified.query,"fallback:무선 헤드폰 추천해줘");assert.equal(calls,1);
});
test("complex conditions fall back, but unspoken preferences are removed",async()=>{
 let calls=0;const port=createFastIntentPort({async extract(){calls++;return {query:"모니터",context:{maxTotalWon:null,requiredConditions:["개발용"],currentPreferences:{price_priority:"value",eye_comfort:"important"},category:"display",attributePreferences:["brightness"]}};}});
 const intent=await port.extract("개발용 모니터를 찾아줘",[]);
 assert.equal(calls,1);assert.deepEqual(intent.context.currentPreferences,{});
 assert.deepEqual(intent.context.attributePreferences,[]);assert.deepEqual(intent.context.requiredConditions,["개발용"]);
});
test("Korean explicit preferences carry exact current-message sources without category hardcoding",async()=>{
 const port=createFastIntentPort({async extract(){return {query:"모니터",context:{maxTotalWon:null,requiredConditions:[],
   currentPreferences:{price_priority:"balanced"},category:"display",attributePreferences:["brightness","noise"]},
   attributeSources:{brightness:"화면 밝기가 중요해",noise:"조용함이 중요해"}};}});
 const intent=await port.extract("화면 밝기가 중요해, 가격이 중요해. 모니터 찾아줘",[]);
 assert.equal(intent.context.currentPreferences.price_priority,"value");
 assert.deepEqual(intent.context.attributePreferences,["brightness"]);
});
test("same product retains constraints; complex requests and negations never use a lossy fast parse",async()=>{
 let calls=0;const previous={query:"헤드폰",maxTotalWon:50000,requiredConditions:["무선"],currentPreferences:{},revision:4};
 const fallback={query:"헤드폰",context:{...previous},queryMode:"KEEP" as const};
 const port=createFastIntentPort({async extract(){calls++;return fallback;}});
 const same=await port.extract("헤드폰 추천해줘",[],previous);
 assert.equal(same.queryMode,"KEEP");assert.equal(same.budgetMode,"KEEP");assert.equal(same.requirementsMode,"KEEP");
 for(const message of ["무선 헤드폰 추천해줘","5만원 미만 헤드폰 추천해줘","비싼건 말고 헤드폰 추천해줘"])
  await port.extract(message,[],previous);
 assert.equal(calls,3);
});

test("explicit breathability and sweat-wicking preference phrases survive the model source audit",async()=>{
 const port=createFastIntentPort({async extract(){return {query:"남성용 팬티",
   queryMode:"SET",budgetMode:"CLEAR",preferencesMode:"CLEAR",
   context:{maxTotalWon:null,requiredConditions:["남성용"],currentPreferences:{},
     category:"fashion",attributePreferences:["moisture_wicking","breathability"]},
   attributeSources:{moisture_wicking:"땀 잘 안 차고",breathability:"시원하면 좋겠어"}};}});
 const result=await port.extract("남성용 팬티 찾아줘. 땀 잘 안 차고 시원하면 좋겠어",[]);
 assert.deepEqual(result.context.attributePreferences,["moisture_wicking","breathability"]);
});
