import type {ProductDetail,ProductSummary,ReviewItem,ReviewSort as CatalogReviewSort} from "../contracts.ts";
import type {EvidenceRecord,ReviewSummaryData,ReviewSummaryRequest} from "./contracts.ts";
import type {ResearchResult} from "./read-flow.ts";

type ReviewSummaryCatalog=Pick<ReturnType<typeof import("../catalog.ts")["createCatalog"]>,"searchProducts"|"getProduct"|"getReviews">;
type Selection={productId:string;variantId?:string;expectedName?:string;nameMatch?:"QUERY"|"EXACT"};
type PageAwareRequest=ReviewSummaryRequest & {pageProductId?:string};
type ReviewLookupRow=ReviewItem;
type SummaryStatus=ReviewSummaryData["status"];

const MAX_SEARCH_PAGES=3;
const SEARCH_PAGE_SIZE=50;
const MAX_CHOICES=5;
const MAX_REVIEW_SAMPLE=20;
const MAX_REVIEW_TEXT=1200;
const SELECTION_PREFIX=/^리뷰\s*요약\s*상품\s*선택\s*:/;
const SELECTION_COMMAND=/^리뷰\s*요약\s*상품\s*선택\s*:\s*([^\s]{1,160})\s*$/;
const SEARCH_SORTS:{sort:CatalogReviewSort;limit:number}[]=[
 {sort:"LATEST",limit:8},{sort:"RATING_ASC",limit:6},{sort:"RATING_DESC",limit:6},
];
const CONS_SORTS:{sort:CatalogReviewSort;limit:number}[]=[
 {sort:"LATEST",limit:6},{sort:"RATING_ASC",limit:10},{sort:"RATING_DESC",limit:4},
];

function validId(value:unknown):value is string{
 return typeof value==="string"&&value.length>0&&value.length<=160&&value===value.trim()&&!/[\u0000-\u001f]/.test(value);
}
function focusOf(request:ReviewSummaryRequest):"ALL"|"CONS"{return request.focus==="CONS"?"CONS":"ALL";}
function sameDataset(previous:ResearchResult|undefined,version:string|undefined):boolean{
 return !previous?.datasetVersion||!version||previous.datasetVersion===version;
}
function result(status:SummaryStatus,focus:"ALL"|"CONS",datasetVersion?:string,
 extra:Partial<ReviewSummaryData>={}):ReviewSummaryData{
 return {status,focus,evidence:[],...(datasetVersion!==undefined?{datasetVersion}:{}),...extra};
}
function previousProductIds(previous?:ResearchResult,version?:string):Set<string>{
 const ids=new Set<string>();
 if(!sameDataset(previous,version))return ids;
 for(const id of previous?.shoppingPlan?.lastDisplayedProductIds??[])if(validId(id))ids.add(id);
 for(const row of previous?.shoppingPlan?.lastDisplayedProducts??[])
  if(row&&validId(row.productId))ids.add(row.productId);
 for(const item of previous?.explanation?.items??[])if(validId(item.productId))ids.add(item.productId);
 const current=previous?.explanation?.reviewSummary?.product?.id;
 if(validId(current))ids.add(current);
 return ids;
}
function choiceId(query:string,previous?:ResearchResult):string|undefined{
 if(!SELECTION_PREFIX.test(query))return undefined;
 const parsed=query.match(SELECTION_COMMAND);
 if(!parsed||!validId(parsed[1]))return "";
 const id=parsed[1];
 return previous?.explanation?.reviewSummary?.choices?.some(choice=>choice.productId===id)?id:"";
}
function previousProductName(id:string,previous?:ResearchResult,version?:string):string|undefined{
 if(!sameDataset(previous,version))return;
 const displayed=previous?.shoppingPlan?.lastDisplayedProducts?.find(item=>item.productId===id);
 if(displayed&&typeof displayed.name==="string"&&displayed.name.trim())return displayed.name;
 const product=previous?.explanation?.reviewSummary?.product;
 if(product?.id===id&&typeof product.name==="string"&&product.name.trim())return product.name;
 const choice=previous?.explanation?.reviewSummary?.choices?.find(item=>item.productId===id);
 if(choice&&typeof choice.name==="string"&&choice.name.trim())return choice.name;
 const item=previous?.explanation?.items?.find(candidate=>candidate.productId===id);
 return item&&typeof item.name==="string"&&item.name.trim()?item.name:undefined;
}
function normalizedName(value:string):string{
 return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"");
}
function enoughNameMatch(query:string,name:string):boolean{
 const q=normalizedName(query),n=normalizedName(name);
 if(!q||!n)return false;
 if(q===n)return true;
 const qLength=[...q].length,nLength=[...n].length;
 if(qLength>=4&&n.includes(q))return true;
 if(q.startsWith(n)&&nLength>=6)return true;
 return q.includes(n)&&nLength>=8;
}
function displayedNameMatch(query:string,name:string):boolean{
 if(enoughNameMatch(query,name))return true;
 const normalized=normalizedName(name);
 const terms=query.trim().split(/\s+/).map(normalizedName).filter(term=>[...term].length>=2);
 if(terms.length<2)return false;
 let cursor=0;
 for(const term of terms){
  const index=normalized.indexOf(term,cursor);
  if(index<0)return false;
  cursor=index+term.length;
 }
 return true;
}
function summaryChoices(items:ProductSummary[]):{productId:string;name:string}[]{
 const seen=new Set<string>(),choices:{productId:string;name:string}[]=[];
 for(const item of items){
  if(!validId(item.product_id)||typeof item.name!=="string"||!item.name.trim()||seen.has(item.product_id))continue;
  seen.add(item.product_id);choices.push({productId:item.product_id,name:item.name.slice(0,160)});
  if(choices.length===MAX_CHOICES)break;
 }
 return choices;
}
function sameSource(a:ReviewLookupRow,b:ReviewLookupRow):boolean{
 return a.id===b.id&&a.product_id===b.product_id&&a.variant_id===b.variant_id&&a.rating===b.rating&&
  a.body===b.body&&a.source_kind===b.source_kind&&a.source_ref===b.source_ref&&a.written_at===b.written_at;
}
function validReviewRow(row:ReviewLookupRow,productId:string,variantId?:string):boolean{
 return validId(row.id)&&row.product_id===productId&&
  (row.variant_id===null||validId(row.variant_id)&&(!variantId||row.variant_id===variantId))&&
  typeof row.rating==="number"&&Number.isFinite(row.rating)&&row.rating>=1&&row.rating<=5&&
  typeof row.body==="string"&&row.body.length>0&&typeof row.source_ref==="string"&&row.source_ref.length>0&&
  (row.source_kind==="REAL"||row.source_kind==="SYNTHETIC");
}

/** Read-only direct Commerce lookup. It never calls RAG or applies recommendation budget/stock gates. */
export function createReviewSummaryLookup(catalog:ReviewSummaryCatalog,datasetVersion?:string){
 const version=datasetVersion;
 return async (request:ReviewSummaryRequest,previous?:ResearchResult):Promise<ReviewSummaryData>=>{
  const focus=focusOf(request),scopedRequest=request as PageAwareRequest;
  const notFound=()=>result("NOT_FOUND",focus,version);
  if(request.variantId!==undefined&&!validId(request.variantId)||request.useCurrent===true&&
    scopedRequest.pageProductId!==undefined&&!validId(scopedRequest.pageProductId))return notFound();
  const explicitVariant=validId(request.variantId)?request.variantId:undefined;
  const choicesFromIds=async(ids:string[]):Promise<ReviewSummaryData>=>{
   const choices:{productId:string;name:string}[]=[];
   for(const id of [...new Set(ids)].filter(validId).slice(0,MAX_CHOICES)){
    const checked=await catalog.getProduct({product_id:id});
    if(!checked.ok){if(checked.error.code==="NOT_FOUND"||checked.error.code==="VALIDATION")continue;throw new Error("Commerce product lookup failed");}
    if(checked.data.product.id===id&&typeof checked.data.product.name==="string"&&checked.data.product.name.trim())
     choices.push({productId:id,name:checked.data.product.name.slice(0,160)});
   }
   return choices.length?result("AMBIGUOUS",focus,version,{choices}):notFound();
  };
  let selection:Selection|undefined;
  const query=typeof request.query==="string"?request.query.trim():"";

  if(request.useCurrent===true&&validId(scopedRequest.pageProductId)){
   // Only the graph-sanitized current-page product may bypass previous-result allowlists.
   selection={productId:scopedRequest.pageProductId,...(explicitVariant?{variantId:explicitVariant}:{})};
  }else if(query&&SELECTION_PREFIX.test(query)){
   const id=choiceId(query,previous);
   const choice=previous?.explanation?.reviewSummary?.choices?.find(item=>item.productId===id);
   if(!id||!choice||typeof choice.name!=="string"||!choice.name.trim())return notFound();
   selection={productId:id,expectedName:choice.name,nameMatch:"EXACT",...(explicitVariant?{variantId:explicitVariant}:{})};
  }else if(request.productId!==undefined){
   if(!validId(request.productId)||!previousProductIds(previous,version).has(request.productId))return notFound();
   const expectedName=previousProductName(request.productId,previous,version);
   selection={productId:request.productId,...(expectedName?{expectedName,nameMatch:"EXACT" as const}:{}),...(explicitVariant?{variantId:explicitVariant}:{})};
  }else if(request.displayIndex!==undefined){
   if(!Number.isSafeInteger(request.displayIndex)||request.displayIndex<1)return notFound();
   if(!sameDataset(previous,version))return notFound();
   const index=request.displayIndex-1;
   const displayedItem=previous?.explanation?.items?.[index];
   const displayed=displayedItem?.productId;
   const id=validId(displayed)?displayed:previous?.shoppingPlan?.lastDisplayedProductIds?.[index];
   if(!validId(id))return notFound();
   const expectedName=displayedItem?.productId===id&&typeof displayedItem.name==="string"&&displayedItem.name.trim()&&sameDataset(previous,version)
    ?displayedItem.name:previousProductName(id,previous,version);
   selection={productId:id,...(expectedName?{expectedName,nameMatch:"EXACT" as const}:{}),...(explicitVariant?{variantId:explicitVariant}:{})};
  }else if(request.useCurrent===true){
   const prior=previous?.explanation?.reviewSummary;
   if(validId(prior?.product?.id)){
    if(!sameDataset(previous,version))return notFound();
    const expectedName=typeof prior.product.name==="string"&&prior.product.name.trim()?prior.product.name:previousProductName(prior.product.id,previous,version);
    selection={productId:prior.product.id,...(expectedName?{expectedName,nameMatch:"EXACT" as const}:{}),
     ...(explicitVariant?{variantId:explicitVariant}:validId(prior.product.variantId)?{variantId:prior.product.variantId}:{})};
   }else if(prior?.status==="AMBIGUOUS"&&prior.choices?.length){
    return choicesFromIds(prior.choices.map(choice=>choice.productId));
   }else{
    if(!sameDataset(previous,version))return notFound();
    const ids=[...(previous?.explanation?.items??[]).map(item=>item.productId),...(previous?.shoppingPlan?.lastDisplayedProductIds??[])];
    const unique=[...new Set(ids.filter(validId))];
    if(unique.length>1)return choicesFromIds(unique);
    if(unique.length===1){const id=unique[0]!,expectedName=previousProductName(id,previous,version);selection={productId:id,...(expectedName?{expectedName,nameMatch:"EXACT" as const}:{}),...(explicitVariant?{variantId:explicitVariant}:{})};}
    else return notFound();
   }
  }else if(query){
   if(query.length>200)return notFound();
   const displayed:{productId:string;name:string;displayIndex:number;variantId?:string}[]=[];
   for(const item of sameDataset(previous,version)?previous?.shoppingPlan?.lastDisplayedProducts??[]:[]){
    if(!validId(item.productId)||typeof item.name!=="string"||!item.name.trim()||
       !Number.isSafeInteger(item.displayIndex)||item.displayIndex<1||item.displayIndex>3||
       item.variantId!==undefined&&!validId(item.variantId)||!displayedNameMatch(query,item.name))continue;
    displayed.push({productId:item.productId,name:item.name,displayIndex:item.displayIndex,
     ...(item.variantId?{variantId:item.variantId}:{})});
   }
   const normalizedQuery=normalizedName(query);
   const displayedExact=displayed.filter(item=>normalizedName(item.name)===normalizedQuery);
   const displayedMatches=displayedExact.length?displayedExact:displayed;
   const displayedUnique=[...new Map(displayedMatches.map(item=>[item.productId,item])).values()];
   if(displayedUnique.length>1)
    return result("AMBIGUOUS",focus,version,{choices:displayedUnique.slice(0,MAX_CHOICES).map(item=>({
     productId:item.productId,name:item.name.slice(0,160),
    }))});
   if(displayedUnique.length===1){
    const item=displayedUnique[0]!;
    selection={productId:item.productId,expectedName:item.name,nameMatch:"EXACT",
     ...(explicitVariant?{variantId:explicitVariant}:validId(item.variantId)?{variantId:item.variantId}:{})};
   }
   if(selection){
    // A unique verified display-name match is more authoritative than a fresh fuzzy catalog search.
   }else{
   let cursor:string|undefined,unfinished=false;
   const found:ProductSummary[]=[],seenCursors=new Set<string>();
   for(let page=0;page<MAX_SEARCH_PAGES;page++){
    const searched=await catalog.searchProducts({query,limit:SEARCH_PAGE_SIZE,...(cursor?{cursor}:{})});
    if(!searched.ok)throw new Error("Commerce product search failed");
    for(const item of searched.data.items){
     if(validId(item.product_id)&&typeof item.name==="string"&&enoughNameMatch(query,item.name))found.push(item);
    }
    if(!searched.data.has_more)break;
    const next=searched.data.next_cursor;
    if(!next||seenCursors.has(next)){unfinished=true;break;}
    seenCursors.add(next);cursor=next;
    if(page===MAX_SEARCH_PAGES-1)unfinished=true;
   }
   const unique=[...new Map(found.map(item=>[item.product_id,item])).values()];
   const exact=unique.filter(item=>normalizedName(item.name)===normalizedName(query));
   const candidates=exact.length?exact:unique;
   if(candidates.length!==1||unfinished){
    if(!candidates.length&&!unfinished)return notFound();
    return result("AMBIGUOUS",focus,version,{choices:summaryChoices(candidates)});
   }
   selection={productId:candidates[0]!.product_id,expectedName:query,nameMatch:"QUERY",...(validId(request.variantId)?{variantId:request.variantId}:{})};
   }
  }else return notFound();

  const productResult=await catalog.getProduct({product_id:selection.productId});
  if(!productResult.ok){
   if(productResult.error.code==="NOT_FOUND"||productResult.error.code==="VALIDATION")return notFound();
   throw new Error("Commerce product lookup failed");
  }
  const detail:ProductDetail=productResult.data;
  if(detail.product.id!==selection.productId||typeof detail.product.name!=="string"||!detail.product.name.trim())return notFound();
  if(selection.expectedName&&(selection.nameMatch==="EXACT"
    ?normalizedName(detail.product.name)!==normalizedName(selection.expectedName)
    :!enoughNameMatch(selection.expectedName,detail.product.name)))return notFound();
  const sorts=focus==="CONS"?CONS_SORTS:SEARCH_SORTS;
  const reviewResults=await Promise.all(sorts.map(({sort,limit})=>catalog.getReviews({product_id:selection.productId,
   ...(selection.variantId?{variant_id:selection.variantId}:{}),sort,limit})));
  for(const reviews of reviewResults)if(!reviews.ok){
   if(reviews.error.code==="NOT_FOUND"||reviews.error.code==="VALIDATION")return notFound();
   throw new Error("Commerce review lookup failed");
  }
  const groups=new Map<string,ReviewLookupRow[]>();
  reviewResults.forEach((reviews,index)=>{
   if(!reviews.ok)return;
   const limit=sorts[index]!.limit;
   for(const row of reviews.data.reviews.slice(0,limit)){
    if(!validId(row.id))continue;
    const rows=groups.get(row.id)??[];rows.push(row);groups.set(row.id,rows);
   }
  });
  const evidence:EvidenceRecord[]=[];
  for(const [id,rows] of groups){
   const first=rows[0]!;
   if(!rows.every(row=>sameSource(first,row))||!validReviewRow(first,selection.productId,selection.variantId))continue;
   evidence.push({id,productId:first.product_id,variantId:first.variant_id,kind:"REVIEW",sourceKind:first.source_kind,
    sourceRef:first.source_ref,text:first.body.slice(0,MAX_REVIEW_TEXT),sourceId:id,rating:first.rating,verified:true,
    ...(version!==undefined?{datasetVersion:version}:{})});
   if(evidence.length===MAX_REVIEW_SAMPLE)break;
  }
  const image=detail.product.images.find(value=>typeof value==="string"&&value.length>0);
  const product={id:detail.product.id,name:detail.product.name,
   ...(selection.variantId?{variantId:selection.variantId}:{}),...(image?{image}:{})};
  return result(evidence.length?"READY":"NO_REVIEWS",focus,version,{product,evidence});
 };
}
