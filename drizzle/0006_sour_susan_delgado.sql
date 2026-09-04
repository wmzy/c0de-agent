ALTER TABLE "sessions" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "deleted_at" timestamp with time zone;