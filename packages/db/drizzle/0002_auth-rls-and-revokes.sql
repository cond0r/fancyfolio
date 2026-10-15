ALTER TABLE public.users ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_ff_auth ON public.users AS PERMISSIVE FOR ALL TO ff_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sessions_ff_auth ON public.sessions AS PERMISSIVE FOR ALL TO ff_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounts_ff_auth ON public.accounts AS PERMISSIVE FOR ALL TO ff_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.verifications ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY verifications_ff_auth ON public.verifications AS PERMISSIVE FOR ALL TO ff_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.apikeys ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY apikeys_ff_auth ON public.apikeys AS PERMISSIVE FOR ALL TO ff_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rate_limits_ff_auth ON public.rate_limits AS PERMISSIVE FOR ALL TO ff_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.sessions, public.accounts, public.verifications, public.apikeys, public.rate_limits TO ff_auth;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ff_auth;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public, app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, app FROM PUBLIC;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  role_name text;
BEGIN
  FOR role_name IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public, app FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, app FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, app FROM %I', role_name);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);
  END LOOP;
END
$$;
