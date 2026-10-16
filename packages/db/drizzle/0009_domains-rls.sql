CREATE FUNCTION app.domain_live(verified_at timestamptz, checked_at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT verified_at IS NOT NULL AND checked_at > now() - interval '72 hours'
$$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_site(key text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN strpos(key, '.') = 0
    THEN (SELECT t.id FROM public.tenants t WHERE t.subdomain = key)
    ELSE (
      SELECT d.tenant_id FROM public.domains d
      WHERE d.hostname = key AND d.verified_at IS NOT NULL
        AND app.domain_live(d.verified_at, d.checked_at)
    )
  END
$$;
--> statement-breakpoint
CREATE FUNCTION app.require_recheck_job() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF current_setting('app.job', true) IS DISTINCT FROM 'domain-recheck' THEN
    RAISE EXCEPTION 'the domain re-check runs only in the job context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app.domains_to_recheck(max integer)
  RETURNS TABLE (hostname text, challenge_token text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.require_recheck_job();
  SELECT d.hostname, d.challenge_token FROM public.domains d
  WHERE d.verified_at IS NOT NULL
  ORDER BY d.checked_at, d.hostname
  LIMIT greatest(least(max, 500), 0)
$$;
--> statement-breakpoint
CREATE FUNCTION app.record_txt(host text, token text, seen boolean) RETURNS void
  LANGUAGE sql VOLATILE STRICT SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.require_recheck_job();
  UPDATE public.domains d
  SET checked_at = CASE WHEN seen THEN now() ELSE d.checked_at END,
    verified_at = CASE WHEN seen THEN d.verified_at END
  WHERE d.hostname = host AND d.challenge_token = token AND d.verified_at IS NOT NULL
    AND (seen OR d.checked_at < now() - interval '72 hours')
$$;
--> statement-breakpoint
CREATE FUNCTION app.guard_domain_claim() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.hostname IS DISTINCT FROM OLD.hostname
    OR NEW.challenge_token IS DISTINCT FROM OLD.challenge_token) THEN
    NEW.verified_at := NULL;
    NEW.checked_at := NULL;
  END IF;
  IF NEW.verified_at > clock_timestamp() OR NEW.checked_at > clock_timestamp() THEN
    RAISE EXCEPTION 'a domain claim cannot be verified or checked in the future'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'domains_claim_time_check';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER domains_guard_claim BEFORE INSERT OR UPDATE ON public.domains
  FOR EACH ROW EXECUTE FUNCTION app.guard_domain_claim();
--> statement-breakpoint
CREATE TRIGGER domains_touch BEFORE INSERT OR UPDATE ON public.domains
  FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.domain_live(timestamptz, timestamptz), app.resolve_site(text),
  app.require_recheck_job(), app.domains_to_recheck(integer), app.record_txt(text, text, boolean),
  app.guard_domain_claim() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.require_recheck_job() TO ff_resolver;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.domain_live(timestamptz, timestamptz) TO ff_app, ff_resolver;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_site(text), app.domains_to_recheck(integer),
  app.record_txt(text, text, boolean) TO ff_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO ff_resolver;
--> statement-breakpoint
-- A NOSUPERUSER owner can hand a function only to a role it may SET ROLE to and that may CREATE in app.
GRANT CREATE ON SCHEMA app TO ff_resolver;
--> statement-breakpoint
GRANT ff_resolver TO CURRENT_USER;
--> statement-breakpoint
ALTER FUNCTION app.resolve_site(text) OWNER TO ff_resolver;
--> statement-breakpoint
ALTER FUNCTION app.domains_to_recheck(integer) OWNER TO ff_resolver;
--> statement-breakpoint
ALTER FUNCTION app.record_txt(text, text, boolean) OWNER TO ff_resolver;
--> statement-breakpoint
REVOKE ff_resolver FROM CURRENT_USER;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM ff_resolver;
--> statement-breakpoint
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY domains_select ON public.domains AS PERMISSIVE FOR SELECT TO ff_app
  USING (tenant_id = (SELECT app.tenant_id())
    AND (app.domain_live(verified_at, checked_at) OR (SELECT app.is_owner())));
--> statement-breakpoint
CREATE POLICY domains_write ON public.domains AS PERMISSIVE FOR ALL TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()));
--> statement-breakpoint
-- An UPDATE's new row must also pass SELECT policies, and record_txt writes verified_at = null.
CREATE POLICY domains_resolve ON public.domains AS PERMISSIVE FOR SELECT TO ff_resolver
  USING (true);
--> statement-breakpoint
CREATE POLICY domains_recheck ON public.domains AS PERMISSIVE FOR UPDATE TO ff_resolver
  USING (verified_at IS NOT NULL) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY tenants_resolve ON public.tenants AS PERMISSIVE FOR SELECT TO ff_resolver
  USING (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.domains TO ff_app;
--> statement-breakpoint
GRANT SELECT (id, subdomain) ON public.tenants TO ff_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, hostname, challenge_token, verified_at, checked_at) ON public.domains
  TO ff_resolver;
--> statement-breakpoint
GRANT UPDATE (verified_at, checked_at) ON public.domains TO ff_resolver;
