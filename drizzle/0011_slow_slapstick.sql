CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kanban_boards" DROP CONSTRAINT "kanban_boards_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "kanban_boards" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kanban_boards" ADD COLUMN "deleted_at" timestamp with time zone DEFAULT null;--> statement-breakpoint
ALTER TABLE "kanban_boards" ADD COLUMN "deleted_project_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "trusted_at" timestamp with time zone DEFAULT null;--> statement-breakpoint
ALTER TABLE "kanban_boards" ADD CONSTRAINT "kanban_boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;