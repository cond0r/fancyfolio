CREATE TABLE "case_studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"cover_url" text,
	"experience_id" uuid,
	"published_at" timestamp with time zone,
	"source_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_studies_tenant_id_slug_unique" UNIQUE("tenant_id","slug"),
	CONSTRAINT "case_studies_slug_check" CHECK (char_length("case_studies"."slug") <= 64 and "case_studies"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "case_studies_length_check" CHECK (char_length("case_studies"."title") <= 160 and char_length("case_studies"."summary") <= 300 and char_length("case_studies"."body_md") <= 20000 and char_length("case_studies"."cover_url") <= 2048),
	CONSTRAINT "case_studies_body_md_fences_check" CHECK ((length("case_studies"."body_md") - length(replace("case_studies"."body_md", ':::', ''))) / 3 <= 10),
	CONSTRAINT "case_studies_cover_url_check" CHECK ("case_studies"."cover_url" ~ '^https://[a-z0-9]+\.public\.blob\.vercel-storage\.com/tenants/[0-9a-f-]{36}/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$' and split_part("case_studies"."cover_url", '/', 5) = "case_studies"."tenant_id"::text),
	CONSTRAINT "case_studies_source_hash_check" CHECK ("case_studies"."source_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"summary_md" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiences_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "experiences_length_check" CHECK (char_length("experiences"."company") <= 120 and char_length("experiences"."role") <= 120 and char_length("experiences"."location") <= 80 and char_length("experiences"."summary_md") <= 2000),
	CONSTRAINT "experiences_summary_md_fences_check" CHECK ((length("experiences"."summary_md") - length(replace("experiences"."summary_md", ':::', ''))) / 3 <= 10),
	CONSTRAINT "experiences_dates_check" CHECK ("experiences"."ends_on" >= "experiences"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"bio_md" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_length_check" CHECK (char_length("profiles"."display_name") <= 80 and char_length("profiles"."headline") <= 120 and char_length("profiles"."location") <= 80 and char_length("profiles"."bio_md") <= 10000 and char_length("profiles"."avatar_url") <= 2048),
	CONSTRAINT "profiles_bio_md_fences_check" CHECK ((length("profiles"."bio_md") - length(replace("profiles"."bio_md", ':::', ''))) / 3 <= 10),
	CONSTRAINT "profiles_avatar_url_check" CHECK ("profiles"."avatar_url" ~ '^https://[a-z0-9]+\.public\.blob\.vercel-storage\.com/tenants/[0-9a-f-]{36}/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$' and split_part("profiles"."avatar_url", '/', 5) = "profiles"."tenant_id"::text),
	CONSTRAINT "profiles_links_check" CHECK (case jsonb_typeof("profiles"."links") when 'array' then jsonb_array_length("profiles"."links") <= 10 else false end)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text,
	"repo_url" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_length_check" CHECK (char_length("projects"."name") <= 80 and char_length("projects"."description") <= 1000),
	CONSTRAINT "projects_url_check" CHECK (char_length("projects"."url") <= 2048 and "projects"."url" ~ '^https://[!-~]+$'),
	CONSTRAINT "projects_repo_url_check" CHECK (char_length("projects"."repo_url") <= 2048 and "projects"."repo_url" ~ '^https://[!-~]+$'),
	CONSTRAINT "projects_tags_check" CHECK (cardinality("projects"."tags") <= 12 and (cardinality("projects"."tags") = 0 or array_ndims("projects"."tags") = 1 and array_lower("projects"."tags", 1) = 1))
);
--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_studies_tenant_id_experience_id_idx" ON "case_studies" USING btree ("tenant_id","experience_id");--> statement-breakpoint
CREATE INDEX "experiences_tenant_id_starts_on_idx" ON "experiences" USING btree ("tenant_id","starts_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "projects_tenant_id_created_at_idx" ON "projects" USING btree ("tenant_id","created_at" DESC NULLS LAST);