/** Pure latency summary for an explicitly labeled sample (e.g. mock-only CI). */
export interface LatencySummary {count:number;p50Ms:number;p95Ms:number;maxMs:number}
export function summarizeLatency(samples:readonly number[]):LatencySummary{
 if(!samples.length||samples.length>10000||samples.some(n=>!Number.isFinite(n)||n<0))
   throw new Error("invalid latency samples");
 const sorted=[...samples].sort((a,b)=>a-b);
 const percentile=(q:number)=>sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];
 return {count:sorted.length,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:sorted[sorted.length-1]};
}
