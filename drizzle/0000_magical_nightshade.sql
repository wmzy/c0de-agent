CREATE TABLE "compaction_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"compaction_id" uuid NOT NULL,
	"archive_type" text NOT NULL,
	"original_entries" jsonb NOT NULL,
	"file_snapshots" jsonb DEFAULT '[]'::jsonb,
	"summary" text NOT NULL,
	"token_count" integer,
	"searchable_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"entry_id" uuid,
	"file_path" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"token_count" integer DEFAULT 0,
	"version" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"role" text,
	"content" jsonb NOT NULL,
	"tool_name" text,
	"token_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"parent_id" uuid,
	"branch_point" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compaction_archives" ADD CONSTRAINT "compaction_archives_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_snapshots" ADD CONSTRAINT "file_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_id_sessions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_archives_session" ON "compaction_archives" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_snapshots_session_path" ON "file_snapshots" USING btree ("session_id","file_path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_snapshots_latest" ON "file_snapshots" USING btree ("session_id","file_path","version");--> statement-breakpoint
CREATE INDEX "idx_entries_session" ON "session_entries" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_parent" ON "sessions" USING btree ("parent_id");