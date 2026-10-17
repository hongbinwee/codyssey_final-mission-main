-- AI-only M15 request windows; rows expire by policy, never store raw actor IDs.
-- Never migrate or alter Commerce tables.
BEGIN;
CREATE TABLE IF NOT EXISTS shopping_brain.rate_limit_windows (
  scope text NOT NULL CHECK (scope IN ('brain_turn_user','brain_turn_global','brain_mutation_user','brain_mutation_global')),
  subject_digest text NOT NULL CHECK(char_length(subject_digest)=64),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0 CHECK (hits>=0),
  PRIMARY KEY(scope,subject_digest,window_start)
);
CREATE INDEX IF NOT EXISTS brain_rate_limit_expiry_idx ON shopping_brain.rate_limit_windows(window_start);
COMMIT;
