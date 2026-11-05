-- Model calls per day (meet#321). One row per UTC day, provider, model and
-- purpose; every call site adds to it. Anthropic reports its token counts;
-- Workers AI does not for every model, so its tokens are an estimate of
-- characters / 4. The daily cron sums yesterday and counts a `model_spend`
-- failure (ops.ts) when the total is over SPEND_ALERT_DAILY_TOKENS.
CREATE TABLE model_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model, purpose)
);
