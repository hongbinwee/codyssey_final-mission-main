import {Fragment} from "react";
import type {AnalyzedReviewProduct,ReviewAnalysisData,ReviewOpinion} from "../../brain/review-analysis.ts";

const opinionLabels:Record<ReviewOpinion,string>={
 POSITIVE:"긍정",NEGATIVE:"부정",MIXED:"혼합",UNRELATED:"무관",UNCERTAIN:"판단 보류",
};
const sourceLabels={REAL:"수집 리뷰",SYNTHETIC:"합성 리뷰"} as const;
const statusLabels={COMPLETE:"전체 조회 완료",PARTIAL:"일부 조회",UNAVAILABLE:"조회 불가"} as const;
const emptyCounts={positive:0,negative:0,mixed:0,unrelated:0,uncertain:0};
type Counts=typeof emptyCounts;
function userFacingLimitation(limitation:string){
 const value=limitation.trim().toLocaleLowerCase();
 if(/datasetversion|데이터셋\s*버전|데이터\s*출처.*버전/u.test(value))return "데이터 출처의 버전을 원본과 대조하지 못했어요.";
 if(/commerce|catalog|상품\s*검증|상품\s*id|옵션\s*목록/u.test(value)){
  if(/리뷰\s*페이지|리뷰.*조회/u.test(value))return "리뷰 페이지를 끝까지 확인하지 못해 전체 의견 수를 확정할 수 없어요.";
  if(/옵션/u.test(value))return "선택한 상품 또는 옵션 정보를 확인하지 못했어요.";
  return "요청한 상품 정보를 확인하지 못했어요.";
 }
 if(/시간\s*상한|시간\s*제한/u.test(value))return "조회 시간 제한으로 일부 리뷰를 확인하지 못했어요.";
 if(/cursor|페이지|메타데이터|전체\s*조회\s*건수|조회가\s*끝나지/u.test(value))return "리뷰 페이지를 끝까지 확인하지 못해 전체 의견 수를 확정할 수 없어요.";
 if(/규칙|판정|분류|문맥/u.test(value))return "문장 표현을 기준으로 한 분류라 문맥에 따라 판단이 달라질 수 있어요.";
 return "일부 데이터 제약으로 확인 범위에 한계가 있어요.";
}
function countLine(counts:Counts){
 return <span>{`긍정 ${counts.positive} · 부정 ${counts.negative} · 혼합 ${counts.mixed} · 무관 ${counts.unrelated} · 판단 보류 ${counts.uncertain}`}</span>;
}
function statusMessage(status:ReviewAnalysisData["status"]){
 if(status==="PARTIAL")return "일부 페이지만 확인했어요. 전체 리뷰 의견 수로 해석하지 않도록 범위를 표시해요.";
 if(status==="UNAVAILABLE")return "리뷰를 끝까지 조회하지 못해 전체 의견 수를 확정할 수 없어요.";
 if(status==="NEEDS_TARGET")return "분석할 상품을 특정하지 못했어요. 먼저 상품을 추천받거나 상품을 선택해 주세요.";
 return "요청한 상품과 속성 범위에서 확인한 리뷰를 분류했어요.";
}
function productScope(product:AnalyzedReviewProduct){
 if(product.status==="COMPLETE")return `수집·합성 리뷰 합계 ${product.totalMatching}건 조회 · 고유 리뷰 ${product.uniqueCount}건 분석`;
 if(product.status==="PARTIAL")return `수집·합성 리뷰 일부 조회 · 확인한 ${product.fetchedCount}건 중 고유 리뷰 ${product.uniqueCount}건 분석 · 전체 의견 수 미확정`;
 return "조회가 완료되지 않아 의견 수를 확정하지 않았어요.";
}
function productEvidence(product:AnalyzedReviewProduct,focus:ReviewAnalysisData["focus"]){
 const seen=new Set<string>();
 const evidence=product.evidence.filter(row=>{
  if(row.productId!==product.productId||(product.variantId!==undefined&&row.variantId!==null&&row.variantId!==product.variantId)||
     typeof row.text!=="string"||!row.text.trim()||row.text.length>1200||seen.has(row.id))return false;
  seen.add(row.id);return true;
 }).slice(0,6);
 if(focus==="CONS"){
  const priority:Record<ReviewOpinion,number>={NEGATIVE:0,MIXED:1,UNCERTAIN:2,POSITIVE:3,UNRELATED:4};
  return evidence.sort((left,right)=>priority[left.opinion]-priority[right.opinion]);
 }
 return evidence;
}
function ProductReviewAnalysis({product,focus}:{product:AnalyzedReviewProduct;focus:ReviewAnalysisData["focus"]}){
 const counts=product.counts??emptyCounts;
 const evidence=productEvidence(product,focus);
 const mappedLimitations=(product.limitations??[]).map(userFacingLimitation);
 const limitations=mappedLimitations.filter((limitation,index)=>mappedLimitations.indexOf(limitation)===index);
 return <article className="brain-review-analysis-product">
  <header className="brain-review-analysis-product-head">
   <div><h3>{product.name}</h3><p className="muted sm">표시 목록 {product.displayIndex}번 · {statusLabels[product.status]}</p></div>
  </header>
  <p className="brain-review-analysis-scope">{productScope(product)}</p>
  <p className="brain-review-analysis-counts" aria-label="수집·합성 리뷰 합산 의견 수">{countLine(counts)}</p>
  <dl className="brain-review-analysis-source-counts" aria-label="리뷰 출처별 의견 수">
   {(Object.keys(sourceLabels) as (keyof typeof sourceLabels)[]).map(source=>{
    const sourceCounts=product.countsBySource?.[source]??emptyCounts;
    return <div key={source}><dt>{sourceLabels[source]}</dt><dd>{countLine(sourceCounts)}</dd></div>;
   })}
  </dl>
  <p className="muted sm">조회 {product.fetchedCount}건 · 중복 {product.duplicateCount}건 · 범위 제외 {product.excludedCount}건</p>
  {limitations.length>0&&<ul className="brain-review-analysis-limitations" aria-label="분석 한계">
   {limitations.map((limitation,index)=><li key={index}>{limitation}</li>)}
  </ul>}
  {evidence.length>0&&<section className="brain-review-analysis-evidence" aria-label={`${product.name} 대표 원문`}>
   <h4>{focus==="CONS"?"부정·혼재 의견 원문":"대표 리뷰 원문"}</h4>
   <ul>{evidence.map(row=><li key={row.id}>
    <blockquote>{row.text}</blockquote>
    <span className="muted sm">{sourceLabels[row.sourceKind]} · {opinionLabels[row.opinion]}</span>
   </li>)}</ul>
  </section>}
 </article>;
}
function ComparisonTable({products,status}:{products:AnalyzedReviewProduct[];status:ReviewAnalysisData["status"]}){
 const allComplete=status==="READY"&&products.every(product=>product.status==="COMPLETE");
 const realCounts=products.map(product=>product.countsBySource?.REAL??emptyCounts);
 const allRelated=realCounts.every(real=>real.positive+real.negative+real.mixed>0);
 const hasPositive=realCounts.some(real=>real.positive>0);
 const comparable=allComplete&&allRelated&&hasPositive;
 const displayProducts=[...products];
 if(comparable)displayProducts.sort((left,right)=>
  right.countsBySource.REAL.positive-left.countsBySource.REAL.positive||left.displayIndex-right.displayIndex);
 const positiveRank=(product:AnalyzedReviewProduct)=>{
  if(!comparable)return "비교 보류";
  const positive=product.countsBySource.REAL.positive;
  const rank=products.filter(other=>other.countsBySource.REAL.positive>positive).length+1;
  const tied=products.some(other=>other!==product&&other.countsBySource.REAL.positive===positive);
  return tied?`공동 ${rank}위`:`${rank}위`;
 };
 const holdReason=!allComplete
  ?"모든 비교 대상의 조회가 끝날 때까지 순위를 보류해요."
  :!allRelated?"수집 리뷰에 속성 관련 판정이 없는 상품이 있어 순위를 보류해요."
  :!hasPositive?"수집 리뷰에서 긍정 의견이 확인되지 않아 순위를 보류해요."
  :"순위는 수집 리뷰의 긍정 의견 수로 비교해요. 합성 리뷰 의견은 별도로 표시해요.";
 return <section className="brain-review-analysis-comparison" aria-label="상품 간 리뷰 비교">
  <h3>상품 간 비교</h3>
  <div className="brain-review-analysis-table-scroll"><table>
   <thead><tr><th scope="col">상품·순위</th><th scope="col">출처</th><th scope="col">긍정</th><th scope="col">부정</th><th scope="col">혼합</th><th scope="col">무관</th><th scope="col">판단 보류</th></tr></thead>
  <tbody>{displayProducts.map(product=><Fragment key={`${product.productId}:${product.variantId??"product"}:${product.displayIndex}`}>
    {(Object.keys(sourceLabels) as (keyof typeof sourceLabels)[]).map((source,index)=>{
     const counts=product.countsBySource?.[source]??emptyCounts;
     return <tr key={source}>
      {index===0&&<th scope="rowgroup" rowSpan={2}><span className="brain-review-analysis-rank">{positiveRank(product)}</span>{product.name}
       <span className="muted sm brain-review-analysis-display-index">표시 목록 {product.displayIndex}번</span></th>}
      <th scope="row">{sourceLabels[source]}</th><td>{counts.positive}</td><td>{counts.negative}</td><td>{counts.mixed}</td><td>{counts.unrelated}</td><td>{counts.uncertain}</td>
     </tr>;
    })}
   </Fragment>)}</tbody>
  </table></div>
  <p className="muted sm">{holdReason} 동률은 공동 순위로 표시하고, 표시 목록 번호는 원래 추천 순서예요.</p>
 </section>;
}

export function BrainReviewAnalysis({analysis}:{analysis:ReviewAnalysisData}){
 const products=analysis.products??[];
 return <section className="brain-review-analysis" aria-label="리뷰 분석 결과">
  <header className="brain-review-analysis-heading">
   <h2>{analysis.aspectLabel} 리뷰 분석</h2>
   <p className="muted sm">보수 규칙 판정 · {statusMessage(analysis.status)}</p>
  </header>
  <p className="brain-review-analysis-method" role="note">문장 속 표현을 기준으로 한 규칙 분류예요. 문맥이나 반어를 놓칠 수 있어 전체 리뷰의 의미·여론을 확정하지 않아요.</p>
  {products.length===0&&<p className="muted sm">분석할 리뷰 결과가 없어요.</p>}
  {analysis.compare&&analysis.focus==="CONS"&&products.length>0&&<p className="brain-review-analysis-focus-note" role="note">부정·혼재 의견과 원문을 우선 보여드려요. 이 범위에서는 상품 순위를 매기지 않아요.</p>}
  {analysis.compare&&analysis.focus==="ALL"&&products.length>1&&<ComparisonTable products={products} status={analysis.status}/>}
  <div className="brain-review-analysis-products">{products.map(product=><ProductReviewAnalysis key={`${product.productId}:${product.variantId??"product"}:${product.displayIndex}`} product={product} focus={analysis.focus}/>)}</div>
 </section>;
}
