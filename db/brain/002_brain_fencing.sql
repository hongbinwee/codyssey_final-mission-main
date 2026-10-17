-- v9: AI-only fencing/canonical checkpoint publication. Never execute on Commerce.
BEGIN;
CREATE TABLE IF NOT EXISTS shopping_brain.turn_fence (
 conversation_id uuid PRIMARY KEY REFERENCES shopping_brain.conversations(id) ON DELETE CASCADE,
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 active_attempt_id uuid,
 published_action_id text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shopping_brain.turn_receipts (
 conversation_id uuid NOT NULL REFERENCES shopping_brain.conversations(id) ON DELETE CASCADE,
 client_action_id text NOT NULL,
 input_digest text NOT NULL,
 generation bigint NOT NULL,
 attempt_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','COMPLETED')),
 checkpoint_thread_id uuid,
 completed_result jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (conversation_id,client_action_id),
 CHECK ((status='COMPLETED' AND checkpoint_thread_id IS NOT NULL AND completed_result IS NOT NULL)
    OR (status='PENDING' AND checkpoint_thread_id IS NULL AND completed_result IS NULL))
);
CREATE INDEX IF NOT EXISTS brain_turn_receipts_attempt_idx ON shopping_brain.turn_receipts(conversation_id,generation);
COMMIT;
