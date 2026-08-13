CREATE TYPE "public"."asset_kind" AS ENUM('native', 'evm_erc20', 'stellar_classic_asset', 'stellar_soroban_token', 'spl_token');--> statement-breakpoint
CREATE TYPE "public"."attestation_status" AS ENUM('pending', 'attested', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chain_kind" AS ENUM('evm', 'stellar', 'solana');--> statement-breakpoint
CREATE TYPE "public"."challenge_status" AS ENUM('none', 'challenged', 'resolved_valid', 'resolved_invalid');--> statement-breakpoint
CREATE TYPE "public"."intent_status" AS ENUM('open', 'claimed', 'challenged', 'finalized', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."relay_job_status" AS ENUM('queued', 'waiting_attestation', 'submitted', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"chain_id" integer NOT NULL,
	"asset_kind" "asset_kind" NOT NULL,
	"asset_id" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"is_native_usdc" boolean DEFAULT false NOT NULL,
	CONSTRAINT "assets_chain_id_asset_id_pk" PRIMARY KEY("chain_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cctp_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"source_chain_id" integer NOT NULL,
	"dest_chain_id" integer NOT NULL,
	"initiator_address" text NOT NULL,
	"burn_tx_ref" text NOT NULL,
	"message_hash" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"attestation_status" "attestation_status" DEFAULT 'pending' NOT NULL,
	"mint_tx_ref" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chains" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "chain_kind" NOT NULL,
	"rpc_config_ref" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claims" (
	"intent_hash" text PRIMARY KEY NOT NULL,
	"solver_address" text NOT NULL,
	"dest_tx_ref" text NOT NULL,
	"delivered_amount" numeric(38, 0) NOT NULL,
	"bond_amount" numeric(38, 0) NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"challenge_status" "challenge_status" DEFAULT 'none' NOT NULL,
	"challenger_address" text,
	"challenged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corridors" (
	"id" text PRIMARY KEY NOT NULL,
	"source_chain_id" integer NOT NULL,
	"dest_chain_id" integer NOT NULL,
	"escrow_contract_address" text,
	"challenge_window_seconds" integer NOT NULL,
	"bond_bps" integer DEFAULT 1000 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "escrow_events" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_hash" text NOT NULL,
	"chain_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"tx_ref" text NOT NULL,
	"block_or_ledger_number" bigint,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intents" (
	"intent_hash" text PRIMARY KEY NOT NULL,
	"corridor_id" text NOT NULL,
	"user" jsonb NOT NULL,
	"source_asset_id" text NOT NULL,
	"source_amount" numeric(38, 0) NOT NULL,
	"dest_asset_id" text NOT NULL,
	"min_dest_amount" numeric(38, 0) NOT NULL,
	"dest_address" jsonb NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"nonce" numeric(38, 0) NOT NULL,
	"status" "intent_status" DEFAULT 'open' NOT NULL,
	"raw_intent" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"cctp_transfer_id" text NOT NULL,
	"status" "relay_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sol_gas_spent_lamports" numeric(38, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "solver_inventory_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"asset_id" text NOT NULL,
	"balance" numeric(38, 0) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_source_chain_id_chains_id_fk" FOREIGN KEY ("source_chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_dest_chain_id_chains_id_fk" FOREIGN KEY ("dest_chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_intent_hash_intents_intent_hash_fk" FOREIGN KEY ("intent_hash") REFERENCES "public"."intents"("intent_hash") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corridors" ADD CONSTRAINT "corridors_source_chain_id_chains_id_fk" FOREIGN KEY ("source_chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corridors" ADD CONSTRAINT "corridors_dest_chain_id_chains_id_fk" FOREIGN KEY ("dest_chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "escrow_events" ADD CONSTRAINT "escrow_events_intent_hash_intents_intent_hash_fk" FOREIGN KEY ("intent_hash") REFERENCES "public"."intents"("intent_hash") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "escrow_events" ADD CONSTRAINT "escrow_events_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intents" ADD CONSTRAINT "intents_corridor_id_corridors_id_fk" FOREIGN KEY ("corridor_id") REFERENCES "public"."corridors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relay_jobs" ADD CONSTRAINT "relay_jobs_cctp_transfer_id_cctp_transfers_id_fk" FOREIGN KEY ("cctp_transfer_id") REFERENCES "public"."cctp_transfers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "solver_inventory_snapshots" ADD CONSTRAINT "solver_inventory_snapshots_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
