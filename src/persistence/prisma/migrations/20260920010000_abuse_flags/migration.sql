-- Phase 4: bot-loop abuse flags (fmbot GlobalFilteredUsers parity).
-- Flagged users are excluded from who-knows, crowns, and guild leaderboards
-- until expiry; the nightly scan (AbuseFilterService) maintains the table.

CREATE TABLE IF NOT EXISTS "abuse_flags" (
  "user_id" INTEGER NOT NULL,
  "reason" VARCHAR(50) NOT NULL,
  "flagged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  CONSTRAINT "abuse_flags_pkey" PRIMARY KEY ("user_id")
);
