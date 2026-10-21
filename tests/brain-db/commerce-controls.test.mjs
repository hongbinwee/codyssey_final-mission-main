import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';

test('isolated PostgreSQL: existing wishlist/cart services preserve variants, stock and user ownership',async()=>{
 const target=new URL(process.env.BRAIN_DATABASE_URL??'');
 assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/brain_ci');
 const admin=postgres(target.toString(),{max:1});let shop;
 try{
  // The existing runner supplies a brand-new disposable cluster; no protected database is used.
  await admin.unsafe('CREATE DATABASE commerce_controls_ci');target.pathname='/commerce_controls_ci';
  const {connectDb}=await import('../../src/db.ts');shop=connectDb(target.toString());
  for(const name of ['001_catalog_cart_actions.sql','002_orders_payments_shipments.sql','003_cancel_requests.sql','004_wishlist_items.sql'])await shop.unsafe(await readFile(new URL('../../db/migrations/'+name,import.meta.url),'utf8'));
  await shop.unsafe("INSERT INTO users(id,auth_subject,display_name,test_address_json) VALUES ('tester_05','isolated-five','Isolated five','{}'),('fixture_other','isolated-other','Isolated other','{}')");
  await shop.unsafe("INSERT INTO products(id,name,brand,category) VALUES ('p-control','Fixture product','QA','monitor')");
  await shop.unsafe("INSERT INTO product_variants(id,product_id,unit_price_won,stock_qty) VALUES ('v-small','p-control',10000,7),('v-large','p-control',15000,3),('v-sold','p-control',12000,0)");
  const {getCart,addToCart,updateCartQuantity,removeCartItem}=await import('../../src/cart.ts');
  const {getWishlist,setWishlist}=await import('../../src/wishlist.ts');
  const actor={actorUserId:'tester_05',origin:'UI'},other={actorUserId:'fixture_other',origin:'UI'};
  const empty=await getCart(actor);assert.ok(empty.ok);assert.equal(empty.data.items.length,0);
  const input={variant_id:'v-large',quantity:2,expected_cart_version:empty.data.version,expected_variant_version:1};
  const add=await addToCart(input,actor,'isolated-add');assert.ok(add.ok,JSON.stringify(add));
  assert.equal(add.data.cart.items[0].variant_id,'v-large');assert.equal(add.data.cart.total_won,33000);
  const replay=await addToCart(input,actor,'isolated-add');assert.ok(replay.ok);assert.equal(replay.replayed,true);
  const current=await getCart(actor);assert.ok(current.ok);assert.equal(current.data.items[0].quantity,2);
  const item=current.data.items[0].cart_item_id;
  const update=await updateCartQuantity({cart_item_id:item,quantity:3,expected_cart_version:current.data.version,expected_variant_version:1},actor,'isolated-update');assert.ok(update.ok);assert.equal(update.data.cart.total_won,48000);
  const over=await updateCartQuantity({cart_item_id:item,quantity:4,expected_cart_version:update.data.cart.version,expected_variant_version:1},actor,'isolated-over');assert.equal(over.ok,false);assert.equal(over.error.code,'OUT_OF_STOCK');
  const sold=await addToCart({variant_id:'v-sold',quantity:1,expected_cart_version:update.data.cart.version,expected_variant_version:1},actor,'isolated-sold');assert.equal(sold.ok,false);assert.equal(sold.error.code,'OUT_OF_STOCK');
  const foreign=await getCart(other);assert.ok(foreign.ok);assert.equal(foreign.data.items.length,0);
  const wrong=await updateCartQuantity({cart_item_id:item,quantity:1,expected_cart_version:foreign.data.version,expected_variant_version:1},other,'isolated-wrong-owner');assert.equal(wrong.ok,false);assert.equal(wrong.error.code,'NOT_FOUND');
  const save=await setWishlist({product_id:'p-control',saved:true},actor,'isolated-wish');assert.ok(save.ok);
  const list=await getWishlist(actor);assert.ok(list.ok);assert.equal(list.data.items[0].product_id,'p-control');
  const otherList=await getWishlist(other);assert.ok(otherList.ok);assert.equal(otherList.data.items.length,0);
  assert.ok((await setWishlist({product_id:'p-control',saved:false},actor,'isolated-unwish')).ok);
  const remove=await removeCartItem({cart_item_id:item,expected_cart_version:update.data.cart.version},actor,'isolated-remove');assert.ok(remove.ok);assert.equal(remove.data.cart.items.length,0);assert.equal(remove.data.cart.total_won,0);
  const stock=await shop.unsafe("SELECT id,stock_qty FROM product_variants ORDER BY id");
  assert.deepEqual(stock.map(r=>[r.id,r.stock_qty]),[['v-large',3],['v-small',7],['v-sold',0]]);
  const exports='C:/문서/codyssey_final/.local-data/v4-20261018-w01-20261018-190515-6435eb82/database_exports/toss/test_items/';
  const rows=async name=>(await readFile(exports+name+'.jsonl','utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const [products,variants,reviews]=await Promise.all(['products','product_variants','reviews'].map(rows));
  const pids=new Set(products.map(p=>p.id)),vids=new Map(variants.map(v=>[v.id,v.product_id]));
  assert.equal(variants.filter(v=>!pids.has(v.product_id)).length,0);
  assert.equal(reviews.filter(r=>!pids.has(r.product_id)||(r.variant_id!==null&&vids.get(r.variant_id)!==r.product_id)).length,0);
  const v4=variants.find(v=>v.active&&v.stock_qty>0),p4=products.find(p=>p.id===v4.product_id);
  await shop.unsafe('INSERT INTO products(id,name,brand,category) VALUES($1,$2,$3,$4)',[p4.id,p4.name,p4.brand,p4.category]);
  await shop.unsafe('INSERT INTO product_variants(id,product_id,unit_price_won,stock_qty) VALUES($1,$2,$3,$4)',[v4.id,p4.id,v4.unit_price_won,v4.stock_qty]);
  const v4add=await addToCart({variant_id:v4.id,quantity:1,expected_cart_version:remove.data.cart.version,expected_variant_version:1},actor,'isolated-v4-id');
  assert.ok(v4add.ok,JSON.stringify(v4add));assert.equal(v4add.data.cart.items[0].variant_id,v4.id);
  assert.ok((await setWishlist({product_id:p4.id,saved:true},actor,'isolated-v4-wish')).ok);
  console.log('V4_EXPORT_FK_PASS products='+products.length+' variants='+variants.length+' reviews='+reviews.length+'; original IDs saved only in new isolated DB');
 }finally{if(shop)await shop.end();await admin.end();}
});
