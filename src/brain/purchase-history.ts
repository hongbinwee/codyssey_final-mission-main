import type postgres from "postgres";
type Sql=Pick<ReturnType<typeof postgres>,"unsafe">;
export type PurchaseSnapshot={productId:string;variantId:string;productName:string;category:string;unitPriceWon:number;purchasedAt:string};
export async function purchaseSnapshots(db:Sql,actorId:string):Promise<PurchaseSnapshot[]>{
 if(!actorId)throw Error("missing actor");
 const rows=await db.unsafe<Array<{product_id:string;variant_id:string;product_name_snapshot:string;category:string;unit_price_won:number;purchased_at:string}>>(
  "SELECT v.product_id,i.variant_id,i.product_name_snapshot,p.category,i.unit_price_won,o.created_at AS purchased_at FROM orders o JOIN order_items i ON i.order_id=o.id JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE o.user_id=$1 AND o.status='CONFIRMED' ORDER BY o.created_at DESC LIMIT 20",[actorId]);
 return rows.map(x=>({productId:x.product_id,variantId:x.variant_id,productName:x.product_name_snapshot,category:x.category,unitPriceWon:x.unit_price_won,purchasedAt:String(x.purchased_at)}));
}
