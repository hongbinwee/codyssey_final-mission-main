export interface InterviewEntry {text:string;reply?:{explanation?:{kind:string;clarification?:{questions:{key:string;text:string;choices:string[]}[]}}|null}}
/** Server owns interview state, including restored conversation history. */
export function resolveBrainInterviewState(entries:readonly InterviewEntry[],busy:boolean){const reply=entries.at(-1)?.reply;return {questions:!busy&&reply?.explanation&&reply.explanation.kind!=='CONVERSATION'?reply.explanation.clarification?.questions??[]:[]};}
