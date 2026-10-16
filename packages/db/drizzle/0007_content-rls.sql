ALTER TABLE public.case_studies ADD CONSTRAINT case_studies_experience_fk
  FOREIGN KEY (tenant_id, experience_id) REFERENCES public.experiences (tenant_id, id)
  ON DELETE SET NULL (experience_id);
--> statement-breakpoint
CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app.clear_source_hash() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.source_hash IS NOT DISTINCT FROM OLD.source_hash AND (
    NEW.slug IS DISTINCT FROM OLD.slug
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.body_md IS DISTINCT FROM OLD.body_md
    OR (NEW.published_at IS NULL) IS DISTINCT FROM (OLD.published_at IS NULL)
  ) THEN
    NEW.source_hash := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app.links_valid(links jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = '' AS $$
  SELECT jsonb_typeof(links) IS DISTINCT FROM 'array' OR NOT EXISTS (
    SELECT FROM jsonb_array_elements(links) AS item
    WHERE CASE WHEN jsonb_typeof(item) = 'object'
      AND jsonb_typeof(item -> 'label') = 'string' AND jsonb_typeof(item -> 'url') = 'string'
      THEN item - 'label' - 'url' <> '{}'::jsonb
        OR char_length(item ->> 'label') NOT BETWEEN 1 AND 40
        OR char_length(item ->> 'url') > 2048
        OR item ->> 'url' !~ '^(https://|mailto:)[!-~]+$'
      ELSE true END
  )
$$;
--> statement-breakpoint
CREATE FUNCTION app.tags_valid(tags text[]) RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT FROM unnest(tags) AS tag WHERE tag IS NULL OR char_length(tag) NOT BETWEEN 1 AND 32
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.touch(), app.clear_source_hash(), app.links_valid(jsonb),
  app.tags_valid(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.links_valid(jsonb), app.tags_valid(text[]) TO ff_app;
--> statement-breakpoint
ALTER TABLE public.profiles ADD CONSTRAINT profiles_links_items_check
  CHECK (app.links_valid(links));
--> statement-breakpoint
ALTER TABLE public.projects ADD CONSTRAINT projects_tags_items_check
  CHECK (app.tags_valid(tags));
--> statement-breakpoint
CREATE TRIGGER profiles_touch BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER experiences_touch BEFORE INSERT OR UPDATE ON public.experiences
  FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER case_studies_touch BEFORE INSERT OR UPDATE ON public.case_studies
  FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER projects_touch BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER case_studies_clear_source_hash BEFORE UPDATE ON public.case_studies
  FOR EACH ROW EXECUTE FUNCTION app.clear_source_hash();
--> statement-breakpoint
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.experiences ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.case_studies ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY profiles_select ON public.profiles AS PERMISSIVE FOR SELECT TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()));
--> statement-breakpoint
CREATE POLICY profiles_write ON public.profiles AS PERMISSIVE FOR ALL TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()));
--> statement-breakpoint
CREATE POLICY experiences_select ON public.experiences AS PERMISSIVE FOR SELECT TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()));
--> statement-breakpoint
CREATE POLICY experiences_write ON public.experiences AS PERMISSIVE FOR ALL TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()));
--> statement-breakpoint
CREATE POLICY case_studies_select ON public.case_studies AS PERMISSIVE FOR SELECT TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()) AND (published_at IS NOT NULL OR (SELECT app.is_owner())));
--> statement-breakpoint
CREATE POLICY case_studies_write ON public.case_studies AS PERMISSIVE FOR ALL TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()));
--> statement-breakpoint
CREATE POLICY projects_select ON public.projects AS PERMISSIVE FOR SELECT TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()));
--> statement-breakpoint
CREATE POLICY projects_write ON public.projects AS PERMISSIVE FOR ALL TO ff_app
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.is_owner()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.profiles TO ff_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.experiences, public.case_studies, public.projects TO ff_app;
