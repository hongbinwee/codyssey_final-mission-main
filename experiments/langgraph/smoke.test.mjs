import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadOnlyResearchGraph} from './read-only-state-graph.mjs';

test('real LangGraph StateGraph invokes read-only research and checkpoints per owned conversation',async()=>{
 const actions=[];let lookup=0;
 const deps={
  conversations:{
   assertOwned:async(user,id)=>{if(user!=='user-1'||id!=='thread-1')throw Error('ownership denied');},
   appendUserMessage:async(user,id,action,text)=>{actions.push(action);return 'message-'+actions.length;}
  },
  memory:{list:async()=>[]},
  intent:{extract:async()=>({query:'keyboard',context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{price_priority:'value'}}})},
  retriever:{search:async()=>{lookup++;return {candidates:[],evidence:[]};}}
 };
 const graph=createReadOnlyResearchGraph(deps);
 const base={actorUserId:'user-1',conversationId:'thread-1',requestId:'trace-1',clientActionId:'action-1',userMessage:'키보드 비교'};
 const first=await graph.invoke(base);
 assert.equal(first.result.ranking.evaluatedCount,0);
 assert.equal(first.result.messageId,'message-1');
 const second=await graph.invoke({...base,clientActionId:'action-2',requestId:'trace-2',userMessage:'저가 제품'});
 assert.equal(second.result.messageId,'message-2');
 assert.equal(lookup,2);
 const snapshot=await graph.getOwnedState('user-1','thread-1');
 assert.equal(snapshot.values.clientActionId,'action-2');
 await assert.rejects(()=>graph.getOwnedState('attacker','thread-1'),/ownership denied/);
 await assert.rejects(()=>graph.invoke({...base,actorUserId:'attacker'}),/ownership denied/);
});
