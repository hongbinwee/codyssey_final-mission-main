import type postgres from "postgres";
import type {CommerceActivity} from "./recommendation-strategies.ts";
type ReadonlySql=Pick<ReturnType<typeof postgres>,"unsafe">;
/** Only authenticated actor IDs are supplied by Brain. Never read another user's rows. */
export async function readCommerceActivity(db:ReadonlySql,actorUserId:string):Promise<CommerceActivity>{
 if(!actorUserId||actorUserId.length>256)throw Error("invalid activity actor");
 // Fail closed to empty activity on missing demo-only tables; do not block the
 // user's explicit request or substitute records from a different actor.
 const [wish,cart]=await Promise.all([
  db.unsafe<Array<{product_id:string}>>(
   "SELECT product_id FROM wishlist_items WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[actorUserId]),
  db.unsafe<Array<{product_id:string}>>(
   "SELECT DISTINCT v.product_id FROM carts c JOIN cart_items i ON i.cart_id=c.id JOIN product_variants v ON v.id=i.variant_id WHERE c.user_id=$1 LIMIT 100",[actorUserId])
 ]);
 const activity:CommerceActivity={wishlistProductIds:wish.map(x=>x.product_id),cartProductIds:cart.map(x=>x.product_id)};
 const access=await db.unsafe<Array<{can_read:boolean}>>(
   "SELECT coalesce(has_table_privilege(current_user,to_regclass('public.orders'),'SELECT'),false) AND coalesce(has_table_privilege(current_user,to_regclass('public.order_items'),'SELECT'),false) AS can_read");
 if(access[0]?.can_read===true){
   const purchased=await db.unsafe<Array<{product_id:string}>>(
     "SELECT DISTINCT v.product_id FROM orders o JOIN order_items i ON i.order_id=o.id JOIN product_variants v ON v.id=i.variant_id WHERE o.user_id=$1 AND o.status='CONFIRMED' LIMIT 100",[actorUserId]);
   activity.purchasedProductIds=purchased.map(x=>x.product_id);
 }
 return activity;
}
