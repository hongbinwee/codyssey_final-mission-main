/** Small text-only renderer. No HTML, URLs or model-generated attributes execute. */
export function BrainAnswer({text}:{text:string}){
 const plain=text.replace(/```(?:[\w-]+)?\n?/g,'').replace(/^#{1,6}\s+/gm,'').replace(/`([^`\n]+)`/g,'$1');
 const paragraphs=plain.split(/\n\s*\n/).flatMap(block=>{
   if(block.length<=220||block.includes('\n'))return [block];
   const sentences=block.match(/[^.!?。！？]+[.!?。！？]+(?:\s+|$)|.+$/g)??[block];
   const groups:string[]=[];for(let i=0;i<sentences.length;i+=2)groups.push(sentences.slice(i,i+2).join('').trim());return groups;
 }).filter(p=>p.trim());
 return <div className="brain-answer">{paragraphs.map((paragraph,index)=><p key={index}>{paragraph.split(/(\*\*[^*\n]+\*\*)/g).map((part,i)=>
   part.startsWith('**')&&part.endsWith('**')?<strong key={i}>{part.slice(2,-2)}</strong>:part.replaceAll('**',''))}</p>)}</div>;
}
