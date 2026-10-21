import test from 'node:test';
import assert from 'node:assert/strict';
import {subcatOf} from '../../src/web/display-meta.ts';
import type {ProductSummary} from '../../src/contracts.ts';
const product=(specs:Record<string,string>,category='beauty')=>({product_id:'arbitrary-new-id',category,matched_variants:[{effective_specs:specs}]} as ProductSummary);
test('new source sub_category drives the four beauty subcategories without fixture IDs',()=>{
 for(const [id,label]of [['sun','선케어'],['skincare','스킨케어'],['cleansing','클렌징'],['makeup','메이크업']]){
  const p=product({sub_category:label});assert.equal(subcatOf('beauty',id)!.matches(p),true,id);
  for(const other of ['sun','skincare','cleansing','makeup'].filter(x=>x!==id))assert.equal(subcatOf('beauty',other)!.matches(p),false);
 }
});
test('type fallback and source category paths are accepted, not guessed from product names',()=>{
 assert.equal(subcatOf('beauty','skincare')!.matches(product({type:'스킨케어'})),true);
 assert.equal(subcatOf('beauty','makeup')!.matches(product({sub_category:'뷰티 > 메이크업 > 아이라이너'})),true);
 assert.equal(subcatOf('beauty','sun')!.matches(product({type:'선케어'},'food')),false);
 assert.equal(subcatOf('beauty','sun')!.matches({...product({}),name:'선케어 크림'}),false);
});
test('legacy source taxonomy and supported specification fallbacks remain compatible',()=>{
 assert.equal(subcatOf('beauty','skincare')!.matches(product({'원본 목록 세부 카테고리':'스킨케어'})),true);
 assert.equal(subcatOf('beauty','sun')!.matches(product({spf:'50'})),true);
 assert.equal(subcatOf('beauty','cleansing')!.matches(product({cleanser_type:'foam'})),true);
});
test('food protein source taxonomy maps only explicit 프로틴 categories',()=>{
 assert.equal(subcatOf('food','protein')!.matches(product({sub_category:'뷰티 > 헬스/푸드 > 헬스 보충제 > 프로틴'},'food')),true);
 assert.equal(subcatOf('food','protein')!.matches(product({type:'프로틴'},'food')),true);
 assert.equal(subcatOf('food','protein')!.matches(product({sub_category:'건강식품'},'food')),false);
 assert.equal(subcatOf('food','coffee')!.matches(product({sub_category:'푸드'},'food')),false);
 assert.equal(subcatOf('beauty','protein')?.matches(product({sub_category:'프로틴'},'food')),undefined);
});
test('fashion source taxonomy maps only the explicit tee aliases and sneaker path',()=>{
 for(const label of ['반소매 티셔츠','긴소매 티셔츠','후드 티셔츠','피케/카라 티셔츠'])
  assert.equal(subcatOf('fashion','tee')!.matches(product({sub_category:`상의 > ${label}`},'fashion')),true,label);
 assert.equal(subcatOf('fashion','tee')!.matches(product({sub_category:'상의'},'fashion')),false);
 assert.equal(subcatOf('fashion','shoes')!.matches(product({sub_category:'신발 > 스니커즈 > 캔버스/단화'},'fashion')),true);
 assert.equal(subcatOf('fashion','shoes')!.matches(product({sub_category:'신발 > 구두 > 더비 슈즈'},'fashion')),false);
});
test('source taxonomy matching preserves existing fashion and food spec fallbacks',()=>{
 assert.equal(subcatOf('fashion','tee')!.matches(product({fit:'regular'},'fashion')),true);
 assert.equal(subcatOf('fashion','shoes')!.matches(product({sole:'rubber'},'fashion')),true);
 assert.equal(subcatOf('food','coffee')!.matches(product({roast:'medium'},'food')),true);
 assert.equal(subcatOf('food','protein')!.matches(product({protein_per_serving:'20g'},'food')),true);
});
