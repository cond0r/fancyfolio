DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ff_app') THEN
    CREATE ROLE ff_app;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ff_auth') THEN
    CREATE ROLE ff_auth;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ff_resolver') THEN
    CREATE ROLE ff_resolver;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE ff_app NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
ALTER ROLE ff_auth NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
ALTER ROLE ff_resolver NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;
