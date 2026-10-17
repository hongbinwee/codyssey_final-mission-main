import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

// Disposable AI-only SQL characterization. NOT a production migration or saver hook.
test("monotonic generation CAS rejects stale writes within the same transaction",async()=>{
  const url=process.env.BRAIN_DATABASE_URL;
  if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
  const db=postgres(url,{max:3,connect_timeout:5});
  const id=crypto.randomUUID();
  try{
    await db.unsafe(`CREATE TABLE IF NOT EXISTS shopping_brain.qa_fence_probe (
      conversation_id uuid PRIMARY KEY, generation bigint NOT NULL,
      holder_id uuid NOT NULL, last_payload text NOT NULL)`);
    const oldHolder=crypto.randomUUID(),newHolder=crypto.randomUUID();
    await db.unsafe(`INSERT INTO shopping_brain.qa_fence_probe
      (conversation_id,generation,holder_id,last_payload) VALUES($1,1,$2,'base')`,[id,oldHolder]);
    const claim=await db.begin(tx=>tx.unsafe(`UPDATE shopping_brain.qa_fence_probe
      SET generation=generation+1, holder_id=$2 WHERE conversation_id=$1
      AND generation=1 AND holder_id=$3 RETURNING generation`,[id,newHolder,oldHolder]));
    assert.equal(Number(claim[0].generation),2);

    const stale=await db.begin(tx=>tx.unsafe(`UPDATE shopping_brain.qa_fence_probe
      SET last_payload='stale' WHERE conversation_id=$1 AND generation=1
      AND holder_id=$2 RETURNING last_payload`,[id,oldHolder]));
    assert.equal(stale.length,0,"old generation may not change canonical state");

    const current=await db.begin(tx=>tx.unsafe(`UPDATE shopping_brain.qa_fence_probe
      SET last_payload='new' WHERE conversation_id=$1 AND generation=2
      AND holder_id=$2 RETURNING last_payload`,[id,newHolder]));
    assert.equal(current[0].last_payload,"new");
    const rows=await db.unsafe("SELECT generation,last_payload FROM shopping_brain.qa_fence_probe WHERE conversation_id=$1",[id]);
    assert.equal(Number(rows[0].generation),2);
    assert.equal(rows[0].last_payload,"new");
  }finally{
    // Cleanup only rows belonging to this test, no DROP of any shared object.
    await db.unsafe("DELETE FROM shopping_brain.qa_fence_probe WHERE conversation_id=$1",[id]).catch(()=>{});
    await db.end();
  }
});
