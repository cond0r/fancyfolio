CREATE FUNCTION app.tenant_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenants t WHERE t.id = app.tenant_id() AND t.owner_id = app.user_id()
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.tenant_id(), app.user_id(), app.is_owner() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO ff_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_id(), app.user_id(), app.is_owner() TO ff_app;
--> statement-breakpoint
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenants_select ON public.tenants AS PERMISSIVE FOR SELECT TO ff_app
  USING (id = (SELECT app.tenant_id()) OR owner_id = (SELECT app.user_id()));
--> statement-breakpoint
CREATE POLICY tenants_insert ON public.tenants AS PERMISSIVE FOR INSERT TO ff_app
  WITH CHECK (id = (SELECT app.tenant_id()) AND owner_id = (SELECT app.user_id()));
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ff_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.tenants TO ff_app;

--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, ff_app, ff_auth, ff_resolver', current_database());
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  holders text;
BEGIN
  SELECT string_agg(grantee, ', ') INTO holders
  FROM unnest(ARRAY['public', 'ff_app', 'ff_auth', 'ff_resolver']) AS grantee
  WHERE has_database_privilege(grantee, current_database(), 'TEMPORARY');
  IF holders IS NOT NULL THEN
    RAISE EXCEPTION 'TEMPORARY on database % is still held by %', current_database(), holders
      USING HINT = 'Run the migrations as the database owner.';
  END IF;
END
$$;
