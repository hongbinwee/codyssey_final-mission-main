import type {Provider} from '../llm.ts';
import type {IntentModel} from './intent.ts';
import {BrainModelOutputError} from './intent.ts';
/** Reuses existing Responses API provider without exposing Commerce tools during planning. */
export function providerIntentModel(provider:Pick<Provider,'chat'>,timeoutMs=60000):IntentModel{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>180000)throw new Error('invalid planning budget');
 return {async complete(system:string,user:string):Promise<string>{
   const response=await provider.chat([{role:'system',content:system},{role:'user',content:user}],[],{signal:AbortSignal.timeout(timeoutMs)});
   if(response.tool_calls?.length||typeof response.content!=='string'||!response.content)throw new BrainModelOutputError('invalid planning response');
   return response.content;
 }};
}
