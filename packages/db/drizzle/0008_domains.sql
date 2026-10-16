CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"challenge_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "domains_hostname_check" CHECK (char_length("domains"."hostname") <= 253 and "domains"."hostname" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "domains_challenge_token_check" CHECK (char_length("domains"."challenge_token") <= 64 and "domains"."challenge_token" ~ '^[A-Za-z0-9_-]{43,}$'),
	CONSTRAINT "domains_checked_when_verified_check" CHECK ("domains"."verified_at" is null or "domains"."checked_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_verified_hostname_unique" ON "domains" USING btree ("hostname") WHERE "domains"."verified_at" is not null;