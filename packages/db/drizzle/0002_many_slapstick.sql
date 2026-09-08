CREATE TABLE IF NOT EXISTS "watcher_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
