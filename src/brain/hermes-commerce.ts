import {createHash} from 'node:crypto';
import {sql,type Q} from '../db.ts';
import {setWishlist} from '../wishlist.ts';
import {addToCart} from '../cart.ts';
import type {createCatalog} from '../catalog.ts';
import type {AgentObservation} from './hermes-agent-step.ts';
import type {DisplayedReviewTarget} from './review-targets.ts';

export type CommerceMutationArgs={productId:string;quantity?:number;optionText?:string};
export type CommerceMutationResult={status:'SUCCEEDED'|'REJECTED'|'NEEDS_INPUT'|'UNKNOWN';productId:string;
 productName?:string;quantity?:number;operationId?:string;replayed?:boolean;message?:string;errorCode?:string};
export type CommercePorts={saveWishlist?:(args:CommerceMutationArgs)=>Promise<CommerceMutationResult>;
 addCart?:(args:CommerceMutationArgs)=>Promise<CommerceMutationResult>};
const compact=(s:string)=>s.toLocaleLowerCase().replace(/[\s\p{P}]/gu,'');
export function explicitCommerceRequest(name:string,message:string):boolean{
 if(/하지\s*마|말아|말고|않|취소|해제|예시|가정|만약|인용|번역|프롬프트/.test(message))return false;
 const end=message.trim().replace(/[.!?。！？~]+$/,'');
 return name==='save_to_wishlist'?/찜(?:에)?\s*(?:추가|저장)?\s*(?:해\s*줘|해\s*주세요|해줄래|부탁해)$/.test(end):
  name==='add_to_cart'&&/(?:담아|넣어)\s*(?:줘|주세요|줄래)$/.test(end)&&/(장바구니|카트)/.test(message);
}
/** This is a permission guard after LLM tool selection, never an intent router. */
export function authorizeCommerceAction(name:string,args:{productId?:string;targetText?:string;quantity?:number;quantityText?:string},
 message:string,displayed:readonly DisplayedReviewTarget[]|undefined,observations:readonly AgentObservation[]):boolean{
 const target=args.targetText?.trim();if(!target||!message.includes(target)||!args.productId)return false;
 if(!explicitCommerceRequest(name,message))return false;
 const rows=(displayed??[]).filter(p=>p.commerceVerified===true);
 const ordinal=/^(?:(\d+)\s*(?:순위|번(?:째)?)|(첫|두|세)\s*번째)$/.exec(target);
 let matches:ReadonlyArray<{productId:string}>;
 if(ordinal){const index=ordinal[1]?Number(ordinal[1]):['첫','두','세'].indexOf(ordinal[2]!)+1;matches=rows.filter(p=>p.displayIndex===index);}
 else{
  const known=[...rows.map(p=>({productId:p.productId,name:p.name})),...observations.flatMap(o=>{
   if(!o.ok||o.tool!=='get_product_detail')return [];
   const p=(o.data as {product?:{productId:string;name:string;active:boolean}})?.product;
   return p?.active?[{productId:p.productId,name:p.name}]:[];
  })];
  const unique=[...new Map(known.map(p=>[p.productId,p])).values()];
  const selected=/^(이\s*(?:상품|제품)|이거|그거)$/.test(target)?unique:
   unique.filter(p=>compact(target).length>=4&&compact(p.name).includes(compact(target)));
  matches=selected;
 }
 if(matches.length!==1||matches[0]!.productId!==args.productId)return false;
 if(name==='add_to_cart'){
  const qty=args.quantity??1,quote=args.quantityText??'';
  if(!Number.isSafeInteger(qty)||qty<1||qty>99)return false;
  if(quote){if(!message.includes(quote)||!new RegExp(`^${qty}\\s*(?:개|팩|세트)$`).test(quote.trim()))return false;}
  else if(qty!==1||/\d+\s*(?:개|팩|세트)/.test(message.replace(target,'')))return false;
 }
 return true;
}

export function createHermesCommercePorts(input:{actorUserId:string;conversationId:string;clientActionId:string;
 bridge:{ensureProduct:(id:string)=>Promise<void>;ensureVariant:(id:string,version?:number)=>Promise<number>};
 catalog:Pick<ReturnType<typeof createCatalog>,'getProduct'>;db?:Q;
 services?:{wishlist:typeof setWishlist;cart:typeof addToCart}}):CommercePorts{
 const db=input.db??sql,services=input.services??{wishlist:setWishlist,cart:addToCart};
 const ctx={actorUserId:input.actorUserId,origin:'AGENT' as const};
 const key=(kind:string)=>'hermes-'+createHash('sha256').update(JSON.stringify([ctx.actorUserId,input.conversationId,input.clientActionId,kind])).digest('hex');
 async function execute(kind:'SET_WISHLIST'|'ADD_CART',args:CommerceMutationArgs):Promise<CommerceMutationResult>{
  const result=(status:CommerceMutationResult['status'],more:Partial<CommerceMutationResult>={}):CommerceMutationResult=>({status,productId:args.productId,...more});
  const quantity=args.quantity??1;
  if(!ctx.actorUserId||!input.conversationId||!input.clientActionId||!args.productId||!Number.isSafeInteger(quantity)||quantity<1||quantity>99)return result('REJECTED',{message:'상품과 수량을 다시 확인해 주세요.'});
  const actionKey=key(kind);
  try{
   const [previous]=await db.unsafe<Array<{payload_json:Record<string,unknown>}>>('SELECT payload_json FROM action_requests WHERE actor_user_id=$1 AND kind=$2 AND idempotency_key=$3',[ctx.actorUserId,kind,actionKey]);
   const got=await input.catalog.getProduct({product_id:args.productId});
   if(!got.ok)return result('REJECTED',{message:'상품 정보를 확인하지 못했어요.'});
   const {product,variants}=got.data;
   if(product.id!==args.productId)return result('REJECTED',{message:'상품 정보가 요청한 대상과 일치하지 않아요.'});
   const base={productName:product.name};
   let response;
   if(kind==='SET_WISHLIST'){
    if(previous&&(previous.payload_json.product_id!==args.productId||previous.payload_json.saved!==true))return result('REJECTED',{...base,errorCode:'IDEMPOTENCY_CONFLICT',message:'이 요청은 이미 다른 상품으로 처리됐어요.'});
    if(!previous&&!product.active)return result('REJECTED',{...base,message:'판매 중단 상품은 찜할 수 없어요.'});
    if(!previous)await input.bridge.ensureProduct(args.productId);
    response=await services.wishlist({product_id:args.productId,saved:true},ctx,actionKey);
   }else{
    const available=variants.filter(v=>product.active&&v.availability==='AVAILABLE');
    const options=args.optionText?available.filter(v=>Object.values(v.option_values).every(value=>compact(args.optionText!).includes(compact(value)))):available;
    if(options.length!==1)return result('NEEDS_INPUT',{...base,message:available.length?'상품 옵션을 선택한 뒤 다시 담아 주세요.':'현재 담을 수 있는 판매 중인 옵션이 없어요.'});
    const variant=options[0]!;
    const old=previous?.payload_json;
    if(old&&(old.variant_id!==variant.variant_id||old.quantity!==quantity))return result('REJECTED',{...base,errorCode:'IDEMPOTENCY_CONFLICT',message:'이 요청은 이미 다른 옵션이나 수량으로 처리됐어요.'});
    const version=old?Number(old.expected_variant_version):await input.bridge.ensureVariant(variant.variant_id,variant.version);
    const [cart]=old?[]:await db.unsafe<Array<{version:number}>>('SELECT version FROM carts WHERE user_id=$1',[ctx.actorUserId]);
    response=await services.cart({variant_id:variant.variant_id,quantity,expected_cart_version:old?Number(old.expected_cart_version):cart?.version??1,expected_variant_version:version},ctx,actionKey);
   }
   if(!response.ok)return result(['OUTCOME_UNKNOWN','INTERNAL','NETWORK'].includes(response.error.code)?'UNKNOWN':'REJECTED',{...base,errorCode:response.error.code,message:response.error.message});
   return result('SUCCEEDED',{...base,...(kind==='ADD_CART'?{quantity}:{}),operationId:response.operation_id,replayed:response.replayed===true});
  }catch{return result('UNKNOWN',{message:'처리 결과를 확인하지 못했어요. 같은 요청을 다시 보내 결과를 확인해 주세요.'});}
 }
 return {saveWishlist:args=>execute('SET_WISHLIST',args),addCart:args=>execute('ADD_CART',args)};
}
