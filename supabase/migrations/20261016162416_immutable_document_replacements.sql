BEGIN;

-- Series are created lazily by an explicit replacement request, never backfilled.
CREATE TABLE public.document_series (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  active_document_id uuid NOT NULL REFERENCES public.user_documents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.document_series_members (
  document_id uuid PRIMARY KEY REFERENCES public.user_documents(id) ON DELETE RESTRICT,
  series_id uuid NOT NULL REFERENCES public.document_series(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (series_id, version)
);

CREATE TABLE public.document_replacement_candidates (
  job_id uuid PRIMARY KEY REFERENCES public.document_processing_jobs(id) ON DELETE CASCADE,
  series_id uuid NOT NULL REFERENCES public.document_series(id) ON DELETE RESTRICT,
  target_document_id uuid NOT NULL REFERENCES public.user_documents(id) ON DELETE RESTRICT,
  candidate_document_id uuid NOT NULL UNIQUE REFERENCES public.user_documents(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expected_active_document_id uuid NOT NULL REFERENCES public.user_documents(id) ON DELETE RESTRICT,
  promoted_at timestamptz
);

CREATE INDEX document_series_user_idx ON public.document_series(user_id);
CREATE INDEX document_series_active_document_idx ON public.document_series(active_document_id);
CREATE INDEX document_series_members_user_idx ON public.document_series_members(user_id);
-- The (series_id, version) unique index covers the series foreign key.
CREATE INDEX document_replacement_candidates_series_idx ON public.document_replacement_candidates(series_id);
CREATE INDEX document_replacement_candidates_target_idx ON public.document_replacement_candidates(target_document_id);
CREATE INDEX document_replacement_candidates_expected_active_idx ON public.document_replacement_candidates(expected_active_document_id);
CREATE INDEX document_replacement_candidates_user_idx ON public.document_replacement_candidates(user_id);

ALTER TABLE public.document_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_series_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_replacement_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.document_series FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.document_series_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.document_replacement_candidates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.document_series TO authenticated;
GRANT SELECT ON TABLE public.document_series_members TO authenticated;
GRANT SELECT ON TABLE public.document_replacement_candidates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_series TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_series_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_replacement_candidates TO service_role;
CREATE POLICY document_series_owner_select ON public.document_series
FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY document_series_members_owner_select ON public.document_series_members
FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY document_replacement_candidates_owner_select ON public.document_replacement_candidates
FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY versioned_document_identity_immutable ON public.user_documents
AS RESTRICTIVE FOR UPDATE TO authenticated
USING (NOT EXISTS (
  SELECT 1 FROM public.document_series_members AS member
  WHERE member.document_id = user_documents.id
))
WITH CHECK (NOT EXISTS (
  SELECT 1 FROM public.document_series_members AS member
  WHERE member.document_id = user_documents.id
));

-- Versioned source objects are immutable even through a direct Storage client.
-- These restrictive rules preserve the existing permissive ownership policies
-- for unversioned files, and never grant broader access to another bucket.
CREATE POLICY userfiles_versioned_source_no_delete ON storage.objects
AS RESTRICTIVE FOR DELETE TO authenticated
USING (bucket_id <> 'userfiles' OR NOT EXISTS (
  SELECT 1 FROM public.user_documents AS doc
  JOIN public.document_series_members AS member ON member.document_id = doc.id
  WHERE doc.file_path = storage.objects.name AND doc.user_id = (SELECT auth.uid())
));
CREATE POLICY userfiles_versioned_source_no_update ON storage.objects
AS RESTRICTIVE FOR UPDATE TO authenticated
USING (bucket_id <> 'userfiles' OR NOT EXISTS (
  SELECT 1 FROM public.user_documents AS doc
  JOIN public.document_series_members AS member ON member.document_id = doc.id
  WHERE doc.file_path = storage.objects.name AND doc.user_id = (SELECT auth.uid())
))
WITH CHECK (bucket_id <> 'userfiles' OR NOT EXISTS (
  SELECT 1 FROM public.user_documents AS doc
  JOIN public.document_series_members AS member ON member.document_id = doc.id
  WHERE doc.file_path = storage.objects.name AND doc.user_id = (SELECT auth.uid())
));

CREATE FUNCTION public.reserve_document_replacement(
  p_user_id uuid, p_target_document_id uuid, p_file_name text, p_file_path text
)
RETURNS SETOF public.document_processing_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $reserve_replacement$
DECLARE
  saved_job public.document_processing_jobs%ROWTYPE;
  target_doc public.user_documents%ROWTYPE;
  target_member public.document_series_members%ROWTYPE;
  series public.document_series%ROWTYPE;
  replacement public.document_replacement_candidates%ROWTYPE;
  next_version integer;
  version_title text;
  version_suffix text;
  title_nonce uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_user_id IS NULL OR p_target_document_id IS NULL
    OR p_file_name IS NULL OR p_file_path IS NULL
    OR pg_catalog.char_length(p_file_name) NOT BETWEEN 1 AND 255
    OR p_file_name <> pg_catalog.btrim(p_file_name)
    OR p_file_name ~ U&'[\0001-\001F\007F-\009F]'
    OR pg_catalog.strpos(p_file_name, '/') > 0
    OR pg_catalog.strpos(p_file_name, pg_catalog.chr(92)) > 0
    OR p_file_name !~* '[.]pdf$'
    OR p_file_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]pdf$'
    OR pg_catalog.split_part(p_file_path, '/', 1) <> p_user_id::text
  THEN RAISE EXCEPTION 'Invalid document replacement'; END IF;

  -- Match reservation/control/completion lock order before taking any row locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-owner:' || p_user_id::text, 0));

  SELECT job.* INTO saved_job FROM public.document_processing_jobs AS job
  WHERE job.user_id = p_user_id AND job.file_path = p_file_path FOR UPDATE;
  IF FOUND THEN
    SELECT candidate.* INTO replacement FROM public.document_replacement_candidates AS candidate
    WHERE candidate.job_id = saved_job.id;
    IF NOT FOUND OR replacement.user_id IS DISTINCT FROM p_user_id
      OR replacement.target_document_id IS DISTINCT FROM p_target_document_id
      OR replacement.expected_active_document_id IS DISTINCT FROM p_target_document_id
      OR replacement.candidate_document_id IS DISTINCT FROM saved_job.document_id
      OR saved_job.file_name IS DISTINCT FROM p_file_name
    THEN RAISE EXCEPTION 'Document replacement path conflicts with an existing job'; END IF;
    RETURN NEXT saved_job;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_documents AS doc
    WHERE doc.user_id = p_user_id AND doc.file_path = p_file_path)
  THEN RAISE EXCEPTION 'Document replacement path conflicts with an existing document'; END IF;

  SELECT doc.* INTO target_doc FROM public.user_documents AS doc
  WHERE doc.id = p_target_document_id AND doc.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR target_doc.processing_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Document replacement target is unavailable';
  END IF;

  SELECT member.* INTO target_member FROM public.document_series_members AS member
  WHERE member.document_id = target_doc.id;
  IF FOUND THEN
    IF target_member.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'Document replacement target is unavailable';
    END IF;
    SELECT s.* INTO series FROM public.document_series AS s
    WHERE s.id = target_member.series_id FOR UPDATE;
    IF NOT FOUND OR series.user_id IS DISTINCT FROM p_user_id
      OR series.active_document_id IS DISTINCT FROM target_doc.id THEN
      RAISE EXCEPTION 'Document replacement target is no longer active';
    END IF;
  ELSE
    INSERT INTO public.document_series(user_id, display_name, active_document_id)
    VALUES (p_user_id, target_doc.title, target_doc.id) RETURNING * INTO series;
    INSERT INTO public.document_series_members(document_id, series_id, user_id, version)
    VALUES (target_doc.id, series.id, p_user_id, 1);
  END IF;

  SELECT max(member.version) + 1 INTO next_version FROM public.document_series_members AS member
  WHERE member.series_id = series.id;
  version_suffix := ' [v' || next_version::text || '-' ||
    pg_catalog.left(pg_catalog.replace(title_nonce::text, '-', ''), 8) || '].pdf';
  version_title := pg_catalog.left(
    COALESCE(NULLIF(pg_catalog.left(p_file_name, pg_catalog.char_length(p_file_name) - 4), ''), 'Document'),
    255 - pg_catalog.char_length(version_suffix)
  ) || version_suffix;

  -- Only the candidate gets a new immutable title/path/document/job. The existing
  -- reservation enforces the one-active-job-per-owner and source-path contracts.
  SELECT job.* INTO saved_job
  FROM public.reserve_document_job(p_user_id, version_title, p_file_path) AS job;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document replacement could not be reserved'; END IF;
  UPDATE public.document_processing_jobs AS job SET file_name = p_file_name
  WHERE job.id = saved_job.id RETURNING job.* INTO saved_job;

  INSERT INTO public.document_series_members(document_id, series_id, user_id, version)
  VALUES (saved_job.document_id, series.id, p_user_id, next_version);
  INSERT INTO public.document_replacement_candidates(
    job_id, series_id, target_document_id, candidate_document_id, user_id, expected_active_document_id
  ) VALUES (saved_job.id, series.id, target_doc.id, saved_job.document_id, p_user_id, target_doc.id);
  RETURN NEXT saved_job;
END;
$reserve_replacement$;

CREATE FUNCTION public.promote_document_replacement(p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $promote_replacement$
DECLARE
  owner_id uuid;
  job public.document_processing_jobs%ROWTYPE;
  replacement public.document_replacement_candidates%ROWTYPE;
  series public.document_series%ROWTYPE;
  candidate_member public.document_series_members%ROWTYPE;
  target_member public.document_series_members%ROWTYPE;
BEGIN
  SELECT j.user_id INTO owner_id FROM public.document_processing_jobs AS j WHERE j.id = p_job_id;
  IF NOT FOUND THEN RETURN true; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-owner:' || owner_id::text, 0));
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  SELECT candidate.* INTO replacement FROM public.document_replacement_candidates AS candidate
  WHERE candidate.job_id = p_job_id;
  IF NOT FOUND THEN RETURN true; END IF;
  SELECT s.* INTO series FROM public.document_series AS s WHERE s.id = replacement.series_id FOR UPDATE;
  IF NOT FOUND OR job.user_id IS DISTINCT FROM owner_id OR job.status IS DISTINCT FROM 'ready'
    OR replacement.user_id IS DISTINCT FROM owner_id OR series.user_id IS DISTINCT FROM owner_id
    OR replacement.candidate_document_id IS DISTINCT FROM job.document_id
    OR replacement.target_document_id IS DISTINCT FROM replacement.expected_active_document_id
  THEN RAISE EXCEPTION 'Document replacement cannot be promoted'; END IF;
  SELECT member.* INTO candidate_member FROM public.document_series_members AS member
  WHERE member.document_id = replacement.candidate_document_id;
  IF NOT FOUND OR candidate_member.series_id IS DISTINCT FROM series.id
    OR candidate_member.user_id IS DISTINCT FROM owner_id THEN
    RAISE EXCEPTION 'Document replacement membership is inconsistent';
  END IF;
  SELECT member.* INTO target_member FROM public.document_series_members AS member
  WHERE member.document_id = replacement.target_document_id;
  IF NOT FOUND OR target_member.series_id IS DISTINCT FROM series.id
    OR target_member.user_id IS DISTINCT FROM owner_id
    OR target_member.version >= candidate_member.version THEN
    RAISE EXCEPTION 'Document replacement membership is inconsistent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_documents AS doc
    WHERE doc.id = job.document_id AND doc.user_id = owner_id
      AND doc.processing_status = 'ready' AND doc.processing_job_id = job.id::text)
    OR NOT EXISTS (SELECT 1 FROM public.user_documents AS doc
    WHERE doc.id = replacement.target_document_id AND doc.user_id = owner_id AND doc.processing_status = 'ready')
  THEN RAISE EXCEPTION 'Document replacement cannot be promoted'; END IF;

  IF replacement.promoted_at IS NOT NULL THEN
    -- Valid historical promotion replays must not rewind a later active version.
    RETURN true;
  END IF;
  UPDATE public.document_series AS s SET active_document_id = replacement.candidate_document_id
  WHERE s.id = series.id AND s.user_id = owner_id
    AND s.active_document_id = replacement.expected_active_document_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document replacement target is no longer active'; END IF;
  UPDATE public.document_replacement_candidates AS candidate SET promoted_at = pg_catalog.now()
  WHERE candidate.job_id = job.id AND candidate.promoted_at IS NULL;
  RETURN true;
END;
$promote_replacement$;

CREATE OR REPLACE FUNCTION public.complete_document_job(p_job_id uuid, p_generation integer, p_run_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $complete$
DECLARE
  job public.document_processing_jobs%ROWTYPE;
  nonblank_pages integer[];
  owner_id uuid;
BEGIN
  SELECT j.user_id INTO owner_id FROM public.document_processing_jobs AS j WHERE j.id = p_job_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-owner:' || owner_id::text, 0));
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL THEN RETURN false; END IF;
  IF job.status = 'ready' THEN RETURN public.promote_document_replacement(job.id); END IF;
  IF job.status <> 'indexing' OR job.metadata IS NULL OR job.total_pages IS NULL THEN RETURN false; END IF;
  IF (SELECT count(*) FROM public.document_processing_pages AS page WHERE page.job_id = job.id) <> job.total_pages
    OR (SELECT min(page.page_number) FROM public.document_processing_pages AS page WHERE page.job_id = job.id) IS DISTINCT FROM 1
    OR (SELECT max(page.page_number) FROM public.document_processing_pages AS page WHERE page.job_id = job.id) IS DISTINCT FROM job.total_pages
    OR EXISTS (SELECT 1 FROM public.document_processing_pages AS page WHERE page.job_id = job.id AND NOT page.indexed)
  THEN RETURN false; END IF;
  SELECT COALESCE(pg_catalog.array_agg(page.page_number ORDER BY page.page_number), ARRAY[]::integer[])
  INTO nonblank_pages FROM public.document_processing_pages AS page
  WHERE page.job_id = job.id AND page.markdown <> '';
  -- The unchanged legacy completion function rejects an all-blank document.
  PERFORM public.complete_document_processing(job.document_id, job.user_id, job.id::text, nonblank_pages);
  UPDATE public.document_processing_jobs AS j
  SET status = 'ready', error_code = NULL, completed_pages = job.total_pages, updated_at = pg_catalog.now()
  WHERE j.id = job.id;
  IF NOT public.promote_document_replacement(job.id) THEN
    RAISE EXCEPTION 'Document replacement cannot be promoted';
  END IF;
  DELETE FROM public.document_processing_pages AS page WHERE page.job_id = job.id;
  RETURN true;
END;
$complete$;

CREATE OR REPLACE FUNCTION public.control_document_job(p_job_id uuid, p_user_id uuid, p_action text)
RETURNS SETOF public.document_processing_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $control$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-owner:' || p_user_id::text, 0));
  SELECT j.* INTO job FROM public.document_processing_jobs AS j
  WHERE j.id = p_job_id AND j.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document job access denied'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('cancel','resume') THEN RAISE EXCEPTION 'Invalid document action'; END IF;
  IF p_action = 'cancel' AND job.status IN ('queued','parsing','metadata','indexing') THEN
    UPDATE public.document_processing_jobs AS j
    SET generation = j.generation + 1, run_id = NULL, status = 'cancelled',
      error_code = CASE WHEN j.parser_submit_started_at IS NOT NULL AND j.parser_job_id IS NULL
        THEN 'parser_submission_unknown' ELSE NULL END,
      updated_at = pg_catalog.now() WHERE j.id = job.id;
    UPDATE public.user_documents AS doc
    SET processing_status = 'failed', processing_error = 'Document processing was cancelled.', updated_at = pg_catalog.now()
    WHERE doc.id = job.document_id AND doc.user_id = job.user_id AND doc.processing_job_id = job.id::text;
  ELSIF p_action = 'resume' AND job.status IN ('failed','cancelled') THEN
    IF EXISTS (
      SELECT 1 FROM public.document_replacement_candidates AS candidate
      LEFT JOIN public.document_series AS series ON series.id = candidate.series_id
      WHERE candidate.job_id = job.id AND (
        candidate.user_id IS DISTINCT FROM job.user_id
        OR candidate.candidate_document_id IS DISTINCT FROM job.document_id
        OR series.user_id IS DISTINCT FROM job.user_id
        OR series.active_document_id IS DISTINCT FROM candidate.expected_active_document_id
      )
    ) THEN
      RAISE EXCEPTION 'Current document version has changed; this replacement cannot resume';
    END IF;
    IF EXISTS (SELECT 1 FROM public.document_processing_jobs AS active
      WHERE active.user_id = p_user_id AND active.id <> job.id
        AND active.status IN ('queued','parsing','metadata','indexing'))
    THEN RAISE EXCEPTION 'Another document is processing' USING ERRCODE = '55000'; END IF;
    IF job.parser_submit_started_at IS NOT NULL AND job.parser_job_id IS NULL THEN
      RAISE EXCEPTION 'Parser submission outcome is unknown; automatic resubmission is blocked';
    END IF;
    UPDATE public.document_processing_jobs AS j
    SET generation = j.generation + 1, run_id = NULL, status = 'queued', error_code = NULL,
      updated_at = pg_catalog.now() WHERE j.id = job.id;
    UPDATE public.user_documents AS doc
    SET processing_status = 'processing', processing_error = NULL, updated_at = pg_catalog.now()
    WHERE doc.id = job.document_id AND doc.user_id = job.user_id AND doc.processing_job_id = job.id::text;
  END IF;
  RETURN QUERY SELECT j.* FROM public.document_processing_jobs AS j WHERE j.id = job.id;
END;
$control$;

CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding extensions.vector,
  match_count integer,
  filter_user_id uuid,
  file_ids uuid[],
  similarity_threshold double precision DEFAULT 0.30
)
RETURNS TABLE (
  id uuid,
  text_content text,
  title text,
  doc_timestamp timestamp with time zone,
  ai_title text,
  ai_description text,
  ai_maintopics text[],
  ai_keyentities text[],
  page_number integer,
  total_pages integer,
  similarity double precision
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    vec.id,
    vec.text_content,
    doc.title,
    doc.created_at AS doc_timestamp,
    doc.ai_title,
    doc.ai_description,
    doc.ai_maintopics,
    doc.ai_keyentities,
    vec.page_number,
    doc.total_pages,
    1 - (vec.embedding <=> query_embedding) AS similarity
  FROM public.user_documents_vec AS vec
  INNER JOIN public.user_documents AS doc
    ON vec.document_id = doc.id
  WHERE doc.user_id = filter_user_id
    AND doc.user_id = (SELECT auth.uid())
    AND doc.processing_status = 'ready'
    AND doc.id = ANY(file_ids)
    AND NOT EXISTS (
      SELECT 1 FROM public.document_series_members AS member
      INNER JOIN public.document_series AS series ON series.id = member.series_id
      WHERE member.document_id = doc.id AND series.active_document_id <> doc.id
    )
    AND 1 - (vec.embedding <=> query_embedding) > similarity_threshold
  ORDER BY vec.embedding <=> query_embedding ASC
  LIMIT LEAST(match_count, 200);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_document_replacement(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.promote_document_replacement(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_document_job(uuid,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.control_document_job(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_document_replacement(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.promote_document_replacement(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_document_job(uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.control_document_job(uuid,uuid,text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.match_documents(
  extensions.vector, integer, uuid, uuid[], double precision
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_documents(
  extensions.vector, integer, uuid, uuid[], double precision
) TO authenticated, service_role;

COMMIT;
