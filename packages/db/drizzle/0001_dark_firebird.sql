ALTER TABLE "relay_jobs" ALTER COLUMN "cctp_transfer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_jobs" ADD COLUMN "source_domain_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_jobs" ADD COLUMN "source_tx_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_jobs" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "relay_jobs" ADD COLUMN "attestation" text;--> statement-breakpoint
ALTER TABLE "relay_jobs" ADD COLUMN "dest_tx_signature" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relay_jobs_source_tx_idx" ON "relay_jobs" USING btree ("source_domain_id","source_tx_hash");