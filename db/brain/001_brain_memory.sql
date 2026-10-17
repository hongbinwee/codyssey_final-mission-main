-- Opt-in schema: run ONLY in a fresh, AI-owned PostgreSQL database.
-- Never touch pre-existing protected Commerce DB or migrations.
BEGIN;
CREATE SCHEMA IF NOT EXISTS shopping_brain;
CREATE TABLE IF NOT EXISTS shopping_brain.conversations (
 id uuid PRIMARY KEY, actor_user_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 UNIQUE(id,actor_user_id)
);
CREATE INDEX IF NOT EXISTS brain_conversations_actor_idx ON shopping_brain.conversations(actor_user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS shopping_brain.messages (
 id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL,
 actor_user_id text NOT NULL,
 FOREIGN KEY(conversation_id,actor_user_id) REFERENCES shopping_brain.conversations(id,actor_user_id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')),
 content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 12000),
 client_action_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,client_action_id),
 UNIQUE(id,conversation_id,actor_user_id)
);
CREATE INDEX IF NOT EXISTS brain_messages_conv_idx ON shopping_brain.messages(conversation_id,created_at,id);
CREATE TABLE IF NOT EXISTS shopping_brain.preference_proposals (
 id uuid PRIMARY KEY, actor_user_id text NOT NULL,
 conversation_id uuid NOT NULL,
 source_message_id uuid NOT NULL,
 FOREIGN KEY(conversation_id,actor_user_id) REFERENCES shopping_brain.conversations(id,actor_user_id) ON DELETE CASCADE,
 FOREIGN KEY(source_message_id,conversation_id,actor_user_id) REFERENCES shopping_brain.messages(id,conversation_id,actor_user_id) ON DELETE CASCADE,
 preference_key text NOT NULL CHECK(preference_key IN ('price_priority','eye_comfort','noise_sensitivity')),
 preference_value text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_proposals_actor_idx ON shopping_brain.preference_proposals(actor_user_id,expires_at) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS shopping_brain.user_preferences (
 actor_user_id text NOT NULL,
 preference_key text NOT NULL CHECK(preference_key IN ('price_priority','eye_comfort','noise_sensitivity')),
 preference_value text NOT NULL,
 source_conversation_id uuid NOT NULL,
 source_message_id uuid NOT NULL,
 FOREIGN KEY(source_conversation_id,actor_user_id) REFERENCES shopping_brain.conversations(id,actor_user_id) ON DELETE CASCADE,
 FOREIGN KEY(source_message_id,source_conversation_id,actor_user_id) REFERENCES shopping_brain.messages(id,conversation_id,actor_user_id) ON DELETE CASCADE,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_user_id,preference_key)
);
CREATE INDEX IF NOT EXISTS brain_preferences_actor_idx ON shopping_brain.user_preferences(actor_user_id,updated_at DESC);
COMMIT;
