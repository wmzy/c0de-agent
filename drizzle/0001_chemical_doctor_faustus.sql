CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"worktree" text NOT NULL,
	"vcs" text,
	"name" text,
	"git_remote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sessions_project" ON "sessions" USING btree ("project_id");