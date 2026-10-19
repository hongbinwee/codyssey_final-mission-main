// Dedicated Hermes QA projection: external DGX catalog is always SELECT-only.
// Local Commerce keeps its existing FK, quote, inventory and order transaction rules.
import type postgres from "postgres";
import type {createCatalog} from "./catalog.ts";

type Sql=ReturnType<typeof postgres>;
type Catalog=Pick<ReturnType<typeof createCatalog>,"getProduct">;
type Reader=Pick<Sql,"unsafe">;
type RemoteProduct={id:string;name:string;brand:string;category:string;description:string;images:string[];specs:Record<string,string>;active:boolean;version:number};
type RemoteVariant={variant_id:string;option_values:Record<string,string>;effective_specs:Record<string,string>;unit_price_won:number;stock_qty:number;availability:string;version:number};
const SOURCE="test_items2";

/** Only the explicitly isolated Hermes QA database may call this bridge. */
export function createHermesQaCatalog(reader:Reader,catalog:Catalog,local:Sql){
 async function projection(product:RemoteProduct,variant?:RemoteVariant):Promise<number|null>{
  if(!product.id||!product.name||product.version<1)throw Error("invalid external product");
  return local.begin(async q=>{
   const existing=await q.unsafe<Array<{specs_json:Record<string,unknown>}>>("SELECT specs_json FROM products WHERE id=$1 FOR UPDATE",[product.id]);
   if(existing.length&&existing[0].specs_json?._hermes_qa_source!==SOURCE)throw Error("local catalog collision");
   if(!existing.length){
    const specs={...product.specs,_hermes_qa_source:SOURCE};
    await q.unsafe("INSERT INTO products (id,name,brand,category,description,image_urls,specs_json,active,version) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) ON CONFLICT (id) DO NOTHING",
      [product.id,product.name,product.brand,product.category,product.description,JSON.stringify(product.images),JSON.stringify(specs),product.active,product.version]);
    const [owned]=await q.unsafe<Array<{specs_json:Record<string,unknown>}>>("SELECT specs_json FROM products WHERE id=$1 FOR UPDATE",[product.id]);
    if(owned?.specs_json?._hermes_qa_source!==SOURCE)throw Error("local catalog collision");
   }
   if(!variant)return null;
   const active=product.active&&variant.availability!=="UNAVAILABLE";
   if(!variant.variant_id||!Number.isSafeInteger(variant.unit_price_won)||variant.unit_price_won<0||
      !Number.isSafeInteger(variant.stock_qty)||variant.stock_qty<0||!Number.isSafeInteger(variant.version)||variant.version<1)
      throw Error("invalid external variant");
   const [old]=await q.unsafe<Array<{product_id:string;version:number;stock_qty:number;unit_price_won:number;active:boolean;option_values_json:Record<string,string>}>>(
      "SELECT product_id,version,stock_qty,unit_price_won,active,option_values_json FROM product_variants WHERE id=$1 FOR UPDATE",[variant.variant_id]);
   if(old&&(old.product_id!==product.id||JSON.stringify(old.option_values_json)!==JSON.stringify(variant.option_values)))
     throw Error("local variant collision");
   if(!old){
    await q.unsafe("INSERT INTO product_variants (id,product_id,option_values_json,spec_overrides_json,unit_price_won,stock_qty,active,version) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
      [variant.variant_id,product.id,JSON.stringify(variant.option_values),JSON.stringify(variant.effective_specs),variant.unit_price_won,variant.stock_qty,active,variant.version]);
   }else if(old.unit_price_won!==variant.unit_price_won||old.active!==active||old.stock_qty>variant.stock_qty){
    // A local simulated purchase reduces local stock; never replenish it from DGX.
    await q.unsafe("UPDATE product_variants SET unit_price_won=$2,stock_qty=LEAST(stock_qty,$3),active=$4,version=version+1 WHERE id=$1",
      [variant.variant_id,variant.unit_price_won,variant.stock_qty,active]);
   }
   const [current]=await q.unsafe<Array<{version:number}>>("SELECT version FROM product_variants WHERE id=$1",[variant.variant_id]);
   if(!current)throw Error("QA variant projection failed");
   return current.version;
  });
 }
 async function ensureProduct(productId:string){
  const got=await catalog.getProduct({product_id:productId});
  if(!got.ok)throw Error("external product not found");
  await projection(got.data.product);
 }
 async function ensureVariant(variantId:string,sourceVersion?:number):Promise<number>{
  if(!variantId||variantId.length>128)throw Error("invalid QA variant");
  const [match]=await reader.unsafe<Array<{product_id:string}>>(
   "SELECT product_id FROM test_items2.product_variants WHERE id=$1",[variantId]);
  if(!match)throw Error("external variant not found");
  const got=await catalog.getProduct({product_id:match.product_id});
  if(!got.ok)throw Error("external product not found");
  const variant=got.data.variants.find(v=>v.variant_id===variantId);
  if(!variant)throw Error("external variant unavailable");
  if(sourceVersion!==undefined&&sourceVersion!==variant.version)throw Error("external variant version changed");
  const version=await projection(got.data.product,variant);
  if(version===null)throw Error("QA variant projection failed");
  return version;
 }
 async function refreshCart(userId:string){
  const rows=await local.unsafe<Array<{variant_id:string}>>(
    "SELECT DISTINCT i.variant_id FROM carts c JOIN cart_items i ON i.cart_id=c.id WHERE c.user_id=$1",[userId]);
  for(const row of rows)await ensureVariant(row.variant_id);
 }
 return {ensureProduct,ensureVariant,refreshCart};
}
