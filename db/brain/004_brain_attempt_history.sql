-- AI-only M15 append-only physical attempt index.
-- Required to track previous checkpoint threads after retries supersede a receipt.
-- No deletion/retention enforcement is performed by this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS shopping_brain.turn_attempts (
  attempt_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES shopping_brain.conversations(id) ON DELETE CASCADE,
  client_action_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation>0),
  status text NOT NULL CHECK(status IN ('PENDING','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(conversation_id,generation)
);
CREATE INDEX IF NOT EXISTS brain_turn_attempts_conv_idx
  ON shopping_brain.turn_attempts(conversation_id,created_at);
COMMIT;
