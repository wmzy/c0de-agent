CREATE TABLE "tool_metrics" (
	"model" text NOT NULL,
	"tool" text NOT NULL,
	"mode" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"avg_latency_ms" real DEFAULT 0 NOT NULL,
	"last_used" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tool_metrics_model_tool_mode" ON "tool_metrics" USING btree ("model","tool","mode");