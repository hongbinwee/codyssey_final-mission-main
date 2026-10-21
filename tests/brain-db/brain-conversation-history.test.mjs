import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import {PersistentConversations,PersistentPreferences} from '../../src/brain/persistent-store.ts';
import {brainDatabaseFromPostgres} from '../../src/brain/pg-adapter.ts';
import {readBrainHistory} from '../../src/brain/runtime.ts';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';
import {FencedTurns} from '../../src/brain/fenced-turns.ts';
import {postgresTurnLock} from '../../src/brain/turn-lock.ts';

test('real isolated PostgreSQL: creation replay, selected history ownership, new conversation keeps approved memory',async()=>{
 const url=process.env.BRAIN_DATABASE_URL;
 if(!url||new URL(url).pathname!=='/brain_ci')throw Error('disposable brain_ci required');
 const sql=postgres(url,{max:5}),lockSql=postgres(url,{max:3}),saver=PostgresSaver.fromConnString(url,{schema:'shopping_brain'});
 try{
  await saver.setup();
  const store=brainDatabaseFromPostgres(sql),conversations=new PersistentConversations(store),memory=new PersistentPreferences(store);
  const actor='history-a-'+crypto.randomUUID(),other='history-b-'+crypto.randomUUID();
  const created=await Promise.all([conversations.create(actor,'lost-creation'),conversations.create(actor,'lost-creation')]);
  assert.equal(created[0].id,created[1].id);
  assert.notEqual((await conversations.create(other,'lost-creation')).id,created[0].id);
  const first=created[0];
  const graph=createPersistentResearchGraph({conversations,memory,route:routeBrainMessage,fastResponses:true,
    intent:{async extract(){return {query:'상품',context:{maxTotalWon:30000,requiredConditions:[],currentPreferences:{}}};}},
    retriever:{async search(){return {candidates:[],evidence:[]};}}},saver,postgresTurnLock(lockSql,sql),new FencedTurns(store));
  const result=await graph.invoke({actorUserId:actor,conversationId:first.id,requestId:crypto.randomUUID(),clientActionId:'turn-one',userMessage:'3만원 이하 상품 추천해줘'});
  const proposal=await conversations.proposePreference({actorUserId:actor,conversationId:first.id,sourceMessageId:result.messageId,key:'price_priority',value:'value'});
  await conversations.confirmPreference(actor,proposal);
  const second=await conversations.create(actor,'new-chat');
  assert.notEqual(second.id,first.id);
  assert.deepEqual((await readBrainHistory(sql,actor,second.id)).entries,[]);
  assert.equal((await memory.list(actor))[0].value,'value');
  assert.deepEqual(await memory.list(other),[]);
  const history=await readBrainHistory(sql,actor,first.id);
  assert.equal(history.entries[0].clientActionId,'turn-one');
  assert.equal(history.entries[0].reply.shopping_plan.maxTotalWon,30000);
  await assert.rejects(()=>readBrainHistory(sql,other,first.id),/not owned/);
  const list=await conversations.list(actor);
  assert.equal(list.length,2);assert.ok(list.every(row=>created.every(c=>c.actorUserId===actor)));
  assert.deepEqual(new Set(list.map(c=>c.id)),new Set([first.id,second.id]));
  const newTurn=await graph.invoke({actorUserId:actor,conversationId:second.id,requestId:crypto.randomUUID(),clientActionId:'hello-new',userMessage:'안녕?'});
  assert.equal(newTurn.shoppingPlan,undefined);assert.equal(newTurn.explanation.kind,'CONVERSATION');
 }finally{await Promise.all([saver.end(),sql.end(),lockSql.end()]);}
});
