import {Annotation,StateGraph,START,END,MemorySaver} from '@langchain/langgraph';
import {researchTurn} from '../../src/brain/read-flow.ts';

/** Experimental graph only. No Commerce writes and NO production persistence. */
const BrainState=Annotation.Root({
 actorUserId:Annotation(),
 conversationId:Annotation(),
 requestId:Annotation(),
 clientActionId:Annotation(),
 userMessage:Annotation(),
 researchResult:Annotation()
});
/** Always validate server-authenticated actor ownership BEFORE checkpoint access. */
export function createReadOnlyResearchGraph(deps,{checkpointer=new MemorySaver()}={}){
 const runnable=new StateGraph(BrainState)
  .addNode('research',async state=>({
   researchResult:await researchTurn({
    actorUserId:state.actorUserId,
    conversationId:state.conversationId,
    requestId:state.requestId,
    clientActionId:state.clientActionId,
    userMessage:state.userMessage
   },deps)
  }))
  .addEdge(START,'research')
  .addEdge('research',END)
  .compile({checkpointer});
 return {
  async invoke(req){
   if(!req?.actorUserId||!req?.conversationId)throw new Error('authenticated conversation required');
   await deps.conversations.assertOwned(req.actorUserId,req.conversationId);
   // Never accept a client-provided configurable.thread_id.
   const config={configurable:{thread_id:req.conversationId}};
   const result=await runnable.invoke(req,config);
   return {result:result.researchResult,config};
  },
  async getOwnedState(actorUserId,conversationId){
   await deps.conversations.assertOwned(actorUserId,conversationId);
   return runnable.getState({configurable:{thread_id:conversationId}});
  }
 };
}
