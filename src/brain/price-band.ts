/** Exact KRW band interpretation for user-selected 만원대 chips.
 * No implicit widening; additional non-Won currencies are not converted. */
export function parseKrwTenThousandBand(text:string):{minTotalWon:number;maxTotalWon:number}|null{
 if(/이하|이상|초과|미만|부터|까지|정도|쯤|안팎/.test(text))return null;
 const boundary="(?=$|\\s|[,.!?]|에서|으로|로|를|은|는|에|와|과|도|부터)";
 const ranges=[...text.matchAll(new RegExp(`(?:^|\\s)(\\d{1,3})\\s*(?:만\\s*)?[~〜～]\\s*(\\d{1,3})\\s*만\\s*원대${boundary}`,"g"))];
 const malformedRange=/\d+\s*(?:만\s*)?[~〜～]\s*\d+\s*만\s*원대/.test(text);
 if(malformedRange&&ranges.length!==1)return null;
 if(ranges.length>1)return null;
 if(ranges.length===1){
  const match=ranges[0],start=Number(match[1]),end=Number(match[2]);
  const withoutRange=text.slice(0,match.index)+" "+text.slice(match.index!+match[0].length);
  const otherBands=[...withoutRange.matchAll(new RegExp(`(?:^|\\s)\\d{1,3}\\s*만\\s*원대${boundary}`,"g"))];
  if(otherBands.length||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end>999||start>=end)return null;
  const trailingZeros=String(end).match(/0+$/)?.[0].length??0;
  const max=end*10000+10000*10**trailingZeros-1,min=start*10000;
  return Number.isSafeInteger(max)?{minTotalWon:min,maxTotalWon:max}:null;
 }
 const found=[...text.matchAll(new RegExp(`(?:^|\\s)(\\d{1,3})\\s*만\\s*원대${boundary}`,"g"))];
 if(found.length!==1)return null;
 const n=Number(found[0][1]);
 if(!Number.isSafeInteger(n)||n<1||n>999)return null;
 // "1만원대" = 10,000–19,999, "15만원대" = 150,000–159,999.
 const trailingZeros=String(n).match(/0+$/)?.[0].length??0;
 const min=n*10000,max=min+10000*10**trailingZeros-1;
 return Number.isSafeInteger(max)?{minTotalWon:min,maxTotalWon:max}:null;
}
