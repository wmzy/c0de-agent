CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"session_id" uuid,
	"project_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read" bigint DEFAULT 0,
	"cost" real,
	"timestamp" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_events_call" ON "usage_events" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_usage_events_project_ts" ON "usage_events" USING btree ("project_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_usage_events_ts" ON "usage_events" USING btree ("timestamp");