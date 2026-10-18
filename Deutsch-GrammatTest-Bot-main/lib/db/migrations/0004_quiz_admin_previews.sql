CREATE TABLE quiz_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_telegram_user_id text NOT NULL,
  topic_id uuid REFERENCES quiz_topics(id) ON DELETE SET NULL,
  topic_title text NOT NULL,
  scheduled_date date NOT NULL,
  question_count integer NOT NULL,
  questions jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX quiz_previews_admin_unique
  ON quiz_previews (admin_telegram_user_id);

CREATE INDEX quiz_previews_expiry_idx
  ON quiz_previews (expires_at);
