ALTER TABLE "relay_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_jobs" ADD COLUMN "leased_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relay_jobs_due_idx" ON "relay_jobs" USING btree ("status","next_attempt_at");