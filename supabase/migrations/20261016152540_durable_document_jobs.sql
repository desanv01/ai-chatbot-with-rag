BEGIN;

CREATE TABLE public.document_processing_jobs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL UNIQUE REFERENCES public.user_documents(id) ON DELETE CASCADE,
  file_name text NOT NULL CHECK (
    pg_catalog.char_length(file_name) BETWEEN 1 AND 255
    AND file_name = pg_catalog.btrim(file_name)
    AND file_name !~ U&'[\0001-\001F\007F-\009F]'
    AND file_name ~* '[.]pdf$'
  ),
  file_path text NOT NULL CHECK (
    file_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]pdf$'
    AND pg_catalog.split_part(file_path, '/', 1) = user_id::text
  ),
  generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  run_id text CHECK (run_id IS NULL OR pg_catalog.btrim(run_id) <> ''),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'parsing', 'metadata', 'indexing', 'ready', 'failed', 'cancelled')
  ),
  parser_job_id text CHECK (parser_job_id IS NULL OR pg_catalog.btrim(parser_job_id) <> ''),
  parser_submit_started_at timestamptz,
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  source_size bigint CHECK (source_size BETWEEN 1 AND 26214400),
  metadata jsonb CHECK (metadata IS NULL OR pg_catalog.jsonb_typeof(metadata) = 'object'),
  total_pages integer CHECK (total_pages BETWEEN 1 AND 2000),
  completed_pages integer NOT NULL DEFAULT 0 CHECK (completed_pages >= 0),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'source_invalid', 'parser_submission_unknown', 'parser_failed', 'parser_timeout',
    'parse_result_invalid', 'metadata_failed', 'indexing_failed', 'workflow_interrupted'
  )),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, file_path)
);

CREATE INDEX document_processing_jobs_user_created_idx
  ON public.document_processing_jobs(user_id, created_at);
CREATE INDEX document_processing_jobs_dispatch_idx
  ON public.document_processing_jobs(status, run_id, created_at)
  WHERE status = 'queued';

CREATE TABLE public.document_processing_pages (
  job_id uuid NOT NULL REFERENCES public.document_processing_jobs(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 2000),
  markdown text NOT NULL,
  indexed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, page_number)
);

CREATE TABLE public.document_job_maintenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id text,
  lease_until timestamptz
);
INSERT INTO public.document_job_maintenance(singleton) VALUES (true);

ALTER TABLE public.document_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_processing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_job_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.document_processing_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.document_processing_pages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.document_job_maintenance FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_processing_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_processing_pages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_job_maintenance TO service_role;
GRANT SELECT (
  id, user_id, document_id, file_name, status, total_pages, completed_pages,
  error_code, created_at, updated_at
) ON public.document_processing_jobs TO authenticated;
CREATE POLICY document_processing_jobs_owner_status
ON public.document_processing_jobs FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE FUNCTION public.reserve_document_job(p_user_id uuid, p_file_name text, p_file_path text)
RETURNS SETOF public.document_processing_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $reserve$
DECLARE
  saved public.document_processing_jobs%ROWTYPE;
  new_job_id uuid := pg_catalog.gen_random_uuid();
  new_document_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_user_id IS NULL OR p_file_name IS NULL OR p_file_path IS NULL
    OR pg_catalog.char_length(p_file_name) NOT BETWEEN 1 AND 255
    OR p_file_name <> pg_catalog.btrim(p_file_name)
    OR p_file_name ~ U&'[\0001-\001F\007F-\009F]'
    OR p_file_name !~* '[.]pdf$'
    OR p_file_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]pdf$'
    OR pg_catalog.split_part(p_file_path, '/', 1) <> p_user_id::text
  THEN RAISE EXCEPTION 'Invalid document reservation'; END IF;

  -- Every reservation acquires title then path locks in the same order.
  -- Keep the existing one-file-at-a-time user flow and bound provider concurrency.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-owner:' || p_user_id::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-title:' || p_user_id::text || '/' || p_file_name, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'document-path:' || p_user_id::text || '/' || p_file_path, 0));

  SELECT job.* INTO saved FROM public.document_processing_jobs AS job
  WHERE job.user_id = p_user_id AND job.file_path = p_file_path FOR UPDATE;
  IF FOUND THEN
    IF saved.file_name <> p_file_name THEN
      RAISE EXCEPTION 'Document reservation conflicts with existing document';
    END IF;
    RETURN NEXT saved;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.document_processing_jobs AS active
    WHERE active.user_id = p_user_id AND active.status IN ('queued','parsing','metadata','indexing'))
  THEN RAISE EXCEPTION 'Another document is processing' USING ERRCODE = '55000'; END IF;

  IF EXISTS (SELECT 1 FROM public.user_documents AS doc
    WHERE doc.user_id = p_user_id AND (doc.file_path = p_file_path OR doc.title = p_file_name))
  THEN RAISE EXCEPTION 'Document reservation conflicts with existing document'; END IF;

  -- Reserve zero while page count is unknown; the legacy document column is NOT NULL.
  -- The job keeps NULL until staging validates the real physical page count.
  INSERT INTO public.user_documents (
    id, user_id, title, file_path, processing_status, processing_job_id, total_pages
  ) VALUES (
    new_document_id, p_user_id, p_file_name, p_file_path, 'processing', new_job_id::text, 0
  );
  RETURN QUERY INSERT INTO public.document_processing_jobs (
    id, user_id, document_id, file_name, file_path
  ) VALUES (new_job_id, p_user_id, new_document_id, p_file_name, p_file_path)
  RETURNING *;
END;
$reserve$;

CREATE FUNCTION public.claim_document_job(p_job_id uuid, p_generation integer, p_run_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $claim$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR pg_catalog.btrim(p_run_id) = '' THEN RETURN false; END IF;
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation
    OR job.status NOT IN ('queued','parsing','metadata','indexing')
    OR (job.run_id IS NOT NULL AND job.run_id <> p_run_id) THEN RETURN false; END IF;
  UPDATE public.document_processing_jobs AS j SET run_id = p_run_id, updated_at = pg_catalog.now()
  WHERE j.id = job.id;
  RETURN true;
END;
$claim$;

CREATE FUNCTION public.begin_document_parser_submission(p_job_id uuid, p_generation integer, p_run_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $begin_parser$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL OR job.status NOT IN ('queued','parsing')
    OR job.parser_job_id IS NOT NULL OR job.parser_submit_started_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.document_processing_jobs AS j
  SET parser_submit_started_at = pg_catalog.now(), status = 'parsing', updated_at = pg_catalog.now()
  WHERE j.id = job.id;
  RETURN true;
END;
$begin_parser$;

CREATE FUNCTION public.checkpoint_document_job(
  p_job_id uuid, p_generation integer, p_run_id text, p_patch jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $checkpoint$
DECLARE
  job public.document_processing_jobs%ROWTYPE;
  next_status text;
  next_metadata jsonb;
  next_total integer;
BEGIN
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL OR job.status NOT IN ('queued','parsing','metadata','indexing') THEN RETURN false; END IF;
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid document checkpoint';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS key(name)
    WHERE key.name NOT IN ('status','parser_job_id','source_sha256','source_size','metadata','total_pages'))
  THEN RAISE EXCEPTION 'Invalid document checkpoint'; END IF;

  next_status := job.status;
  next_metadata := job.metadata;
  next_total := job.total_pages;
  IF p_patch ? 'status' THEN
    IF pg_catalog.jsonb_typeof(p_patch->'status') <> 'string'
      OR p_patch->>'status' NOT IN ('parsing','metadata','indexing') THEN
      RAISE EXCEPTION 'Invalid document checkpoint stage';
    END IF;
    next_status := p_patch->>'status';
    IF pg_catalog.array_position(ARRAY['queued','parsing','metadata','indexing'], next_status)
      < pg_catalog.array_position(ARRAY['queued','parsing','metadata','indexing'], job.status)
    THEN RAISE EXCEPTION 'Document checkpoint cannot move backwards'; END IF;
  END IF;
  IF p_patch ? 'parser_job_id' THEN
    IF pg_catalog.jsonb_typeof(p_patch->'parser_job_id') <> 'string'
      OR pg_catalog.btrim(p_patch->>'parser_job_id') = ''
      OR pg_catalog.char_length(p_patch->>'parser_job_id') > 1024
      OR job.parser_submit_started_at IS NULL
      OR (job.parser_job_id IS NOT NULL AND job.parser_job_id <> p_patch->>'parser_job_id')
    THEN RAISE EXCEPTION 'Invalid parser checkpoint'; END IF;
  END IF;
  IF p_patch ? 'source_sha256' THEN
    IF pg_catalog.jsonb_typeof(p_patch->'source_sha256') <> 'string'
      OR p_patch->>'source_sha256' !~ '^[0-9a-f]{64}$'
      OR (job.source_sha256 IS NOT NULL AND job.source_sha256 <> p_patch->>'source_sha256')
    THEN RAISE EXCEPTION 'Invalid source checkpoint'; END IF;
  END IF;
  IF p_patch ? 'source_size' THEN
    IF pg_catalog.jsonb_typeof(p_patch->'source_size') <> 'number'
      OR p_patch->>'source_size' !~ '^[0-9]{1,8}$' THEN
      RAISE EXCEPTION 'Invalid source checkpoint';
    END IF;
    IF (p_patch->>'source_size')::bigint NOT BETWEEN 1 AND 26214400
      OR (job.source_size IS NOT NULL AND job.source_size <> (p_patch->>'source_size')::bigint)
    THEN RAISE EXCEPTION 'Invalid source checkpoint'; END IF;
  END IF;
  IF p_patch ? 'metadata' THEN
    next_metadata := p_patch->'metadata';
    IF pg_catalog.jsonb_typeof(next_metadata) <> 'object' THEN
      RAISE EXCEPTION 'Invalid document metadata';
    END IF;
    IF NOT (next_metadata ?& ARRAY['descriptiveTitle','shortDescription','mainTopics','keyEntities','primaryLanguage'])
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(next_metadata) AS key(name)
        WHERE key.name NOT IN ('descriptiveTitle','shortDescription','mainTopics','keyEntities','primaryLanguage'))
      OR pg_catalog.jsonb_typeof(next_metadata->'descriptiveTitle') <> 'string'
      OR pg_catalog.jsonb_typeof(next_metadata->'shortDescription') <> 'string'
      OR pg_catalog.jsonb_typeof(next_metadata->'primaryLanguage') <> 'string'
      OR pg_catalog.jsonb_typeof(next_metadata->'mainTopics') <> 'array'
      OR pg_catalog.jsonb_typeof(next_metadata->'keyEntities') <> 'array'
    THEN RAISE EXCEPTION 'Invalid document metadata'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(next_metadata->'mainTopics') AS item(value)
      WHERE pg_catalog.jsonb_typeof(item.value) <> 'string')
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(next_metadata->'keyEntities') AS item(value)
      WHERE pg_catalog.jsonb_typeof(item.value) <> 'string')
      OR (job.metadata IS NOT NULL AND job.metadata <> next_metadata)
    THEN RAISE EXCEPTION 'Invalid document metadata'; END IF;
  END IF;
  IF p_patch ? 'total_pages' THEN
    IF pg_catalog.jsonb_typeof(p_patch->'total_pages') <> 'number'
      OR p_patch->>'total_pages' !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Invalid document page count';
    END IF;
    next_total := (p_patch->>'total_pages')::integer;
    IF next_total NOT BETWEEN 1 AND 2000
      OR (job.total_pages IS NOT NULL AND job.total_pages <> next_total)
      OR (SELECT count(*) FROM public.document_processing_pages AS page WHERE page.job_id = job.id) <> next_total
      OR (SELECT min(page.page_number) FROM public.document_processing_pages AS page WHERE page.job_id = job.id) IS DISTINCT FROM 1
      OR (SELECT max(page.page_number) FROM public.document_processing_pages AS page WHERE page.job_id = job.id) IS DISTINCT FROM next_total
    THEN RAISE EXCEPTION 'Invalid document page count'; END IF;
  END IF;
  IF next_status = 'indexing' AND (next_metadata IS NULL OR next_total IS NULL) THEN
    RAISE EXCEPTION 'Document indexing requires metadata and pages';
  END IF;

  UPDATE public.document_processing_jobs AS j SET
    status = next_status,
    parser_job_id = CASE WHEN p_patch ? 'parser_job_id' THEN p_patch->>'parser_job_id' ELSE j.parser_job_id END,
    source_sha256 = CASE WHEN p_patch ? 'source_sha256' THEN p_patch->>'source_sha256' ELSE j.source_sha256 END,
    source_size = CASE WHEN p_patch ? 'source_size' THEN (p_patch->>'source_size')::bigint ELSE j.source_size END,
    metadata = next_metadata, total_pages = next_total, updated_at = pg_catalog.now()
  WHERE j.id = job.id;
  UPDATE public.user_documents AS doc SET
    total_pages = COALESCE(next_total, doc.total_pages),
    ai_title = CASE WHEN next_metadata IS NOT NULL THEN next_metadata->>'descriptiveTitle' ELSE doc.ai_title END,
    ai_description = CASE WHEN next_metadata IS NOT NULL THEN next_metadata->>'shortDescription' ELSE doc.ai_description END,
    ai_maintopics = CASE WHEN next_metadata IS NOT NULL THEN ARRAY(
      SELECT pg_catalog.jsonb_array_elements_text(next_metadata->'mainTopics')) ELSE doc.ai_maintopics END,
    ai_keyentities = CASE WHEN next_metadata IS NOT NULL THEN ARRAY(
      SELECT pg_catalog.jsonb_array_elements_text(next_metadata->'keyEntities')) ELSE doc.ai_keyentities END,
    updated_at = pg_catalog.now()
  WHERE doc.id = job.document_id AND doc.user_id = job.user_id AND doc.processing_job_id = job.id::text;
  RETURN true;
END;
$checkpoint$;

CREATE FUNCTION public.store_document_job_pages(
  p_job_id uuid, p_generation integer, p_run_id text, p_pages jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $store_pages$
DECLARE
  job public.document_processing_jobs%ROWTYPE;
  item jsonb;
BEGIN
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL OR job.status NOT IN ('queued','parsing','metadata','indexing') THEN RETURN false; END IF;
  IF p_pages IS NULL OR pg_catalog.jsonb_typeof(p_pages) <> 'array' THEN
    RAISE EXCEPTION 'Invalid document pages';
  END IF;
  IF pg_catalog.jsonb_array_length(p_pages) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Invalid document pages';
  END IF;
  FOR item IN SELECT element.value FROM pg_catalog.jsonb_array_elements(p_pages) AS element(value) LOOP
    IF pg_catalog.jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'Invalid document page'; END IF;
    IF NOT (item ?& ARRAY['page_number','markdown'])
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(item) AS key(name) WHERE key.name NOT IN ('page_number','markdown'))
      OR pg_catalog.jsonb_typeof(item->'page_number') <> 'number'
      OR item->>'page_number' !~ '^[0-9]{1,4}$'
      OR pg_catalog.jsonb_typeof(item->'markdown') <> 'string'
    THEN RAISE EXCEPTION 'Invalid document page'; END IF;
    IF (item->>'page_number')::integer NOT BETWEEN 1 AND 2000
      OR (job.total_pages IS NOT NULL AND (item->>'page_number')::integer > job.total_pages)
    THEN RAISE EXCEPTION 'Invalid document page'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_pages) AS element(value)
    GROUP BY (element.value->>'page_number')::integer HAVING count(*) > 1)
  THEN RAISE EXCEPTION 'Duplicate document page'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_pages) AS element(value)
    JOIN public.document_processing_pages AS saved
      ON saved.job_id = job.id AND saved.page_number = (element.value->>'page_number')::integer
    WHERE saved.markdown <> CASE WHEN element.value->>'markdown' ~ '[^[:space:]]'
      THEN element.value->>'markdown' ELSE '' END
  ) THEN RAISE EXCEPTION 'Document page checkpoint differs'; END IF;
  INSERT INTO public.document_processing_pages(job_id, page_number, markdown)
  SELECT job.id, (element.value->>'page_number')::integer,
    CASE WHEN element.value->>'markdown' ~ '[^[:space:]]' THEN element.value->>'markdown' ELSE '' END
  FROM pg_catalog.jsonb_array_elements(p_pages) AS element(value)
  ON CONFLICT (job_id, page_number) DO NOTHING;
  RETURN true;
END;
$store_pages$;

CREATE FUNCTION public.commit_document_job_page(
  p_job_id uuid, p_generation integer, p_run_id text, p_page_number integer, p_embedding text
)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $commit_page$
DECLARE
  job public.document_processing_jobs%ROWTYPE;
  page public.document_processing_pages%ROWTYPE;
  indexed_count integer;
  page_embedding extensions.vector(1024);
BEGIN
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL OR job.status <> 'indexing' OR job.metadata IS NULL OR job.total_pages IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT p.* INTO page FROM public.document_processing_pages AS p
  WHERE p.job_id = job.id AND p.page_number = p_page_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document page checkpoint is missing'; END IF;
  IF page.indexed THEN
    SELECT count(*)::integer INTO indexed_count FROM public.document_processing_pages AS p
    WHERE p.job_id = job.id AND p.indexed;
    RETURN indexed_count;
  END IF;
  IF page.markdown = '' THEN
    IF p_embedding IS NOT NULL THEN RAISE EXCEPTION 'Blank page must not have an embedding'; END IF;
    IF EXISTS (SELECT 1 FROM public.user_documents_vec AS vec
      WHERE vec.document_id = job.document_id AND vec.page_number = p_page_number)
    THEN RAISE EXCEPTION 'Document vector checkpoint differs'; END IF;
  ELSE
    IF p_embedding IS NULL THEN RAISE EXCEPTION 'Document page embedding is missing'; END IF;
    BEGIN
      page_embedding := p_embedding::extensions.vector(1024);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid document page embedding'; END;
    INSERT INTO public.user_documents_vec(document_id, page_number, text_content, embedding)
    VALUES (job.document_id, p_page_number, page.markdown, page_embedding)
    ON CONFLICT (document_id, page_number) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM public.user_documents_vec AS vec
      WHERE vec.document_id = job.document_id AND vec.page_number = p_page_number
        AND vec.text_content = page.markdown AND vec.embedding IS NOT NULL)
    THEN RAISE EXCEPTION 'Document vector checkpoint differs'; END IF;
  END IF;
  UPDATE public.document_processing_pages AS p SET indexed = true
  WHERE p.job_id = job.id AND p.page_number = p_page_number;
  SELECT count(*)::integer INTO indexed_count FROM public.document_processing_pages AS p
  WHERE p.job_id = job.id AND p.indexed;
  UPDATE public.document_processing_jobs AS j
  SET completed_pages = indexed_count, updated_at = pg_catalog.now() WHERE j.id = job.id;
  RETURN indexed_count;
END;
$commit_page$;

CREATE FUNCTION public.complete_document_job(p_job_id uuid, p_generation integer, p_run_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $complete$
DECLARE
  job public.document_processing_jobs%ROWTYPE;
  nonblank_pages integer[];
BEGIN
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL THEN RETURN false; END IF;
  IF job.status = 'ready' THEN RETURN true; END IF;
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
  DELETE FROM public.document_processing_pages AS page WHERE page.job_id = job.id;
  RETURN true;
END;
$complete$;

CREATE FUNCTION public.fail_document_job(
  p_job_id uuid, p_generation integer, p_run_id text, p_error_code text
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $fail$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  SELECT j.* INTO job FROM public.document_processing_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.generation IS DISTINCT FROM p_generation OR job.run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL OR job.status NOT IN ('queued','parsing','metadata','indexing') THEN RETURN false; END IF;
  IF p_error_code IS NULL OR p_error_code NOT IN (
    'source_invalid','parser_submission_unknown','parser_failed','parser_timeout',
    'parse_result_invalid','metadata_failed','indexing_failed','workflow_interrupted'
  ) THEN RAISE EXCEPTION 'Invalid document failure code'; END IF;
  UPDATE public.document_processing_jobs AS j
  SET status = 'failed', error_code = p_error_code, updated_at = pg_catalog.now() WHERE j.id = job.id;
  UPDATE public.user_documents AS doc
  SET processing_status = 'failed', processing_error = 'Document processing could not be completed.', updated_at = pg_catalog.now()
  WHERE doc.id = job.document_id AND doc.user_id = job.user_id
    AND doc.processing_job_id = job.id::text AND doc.processing_status = 'processing';
  RETURN true;
END;
$fail$;

CREATE FUNCTION public.control_document_job(p_job_id uuid, p_user_id uuid, p_action text)
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

CREATE FUNCTION public.claim_document_job_maintenance(p_run_id text, p_previous_run_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $maintenance$
DECLARE current_run text; current_lease timestamptz;
BEGIN
  IF p_run_id IS NULL OR pg_catalog.btrim(p_run_id) = '' THEN RAISE EXCEPTION 'Invalid maintenance run'; END IF;
  SELECT lease.run_id, lease.lease_until INTO current_run, current_lease
  FROM public.document_job_maintenance AS lease WHERE lease.singleton = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document maintenance state is unavailable'; END IF;
  IF current_run = p_run_id OR current_lease IS NULL OR current_lease <= pg_catalog.now()
    OR (p_previous_run_id IS NOT NULL AND current_run = p_previous_run_id) THEN
    UPDATE public.document_job_maintenance AS lease
    SET run_id = p_run_id, lease_until = pg_catalog.now() + interval '2 hours' WHERE lease.singleton = true;
    RETURN true;
  END IF;
  RETURN false;
END;
$maintenance$;

REVOKE EXECUTE ON FUNCTION public.reserve_document_job(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_document_job(uuid,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_document_parser_submission(uuid,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.checkpoint_document_job(uuid,integer,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.store_document_job_pages(uuid,integer,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.commit_document_job_page(uuid,integer,text,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_document_job(uuid,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_document_job(uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.control_document_job(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_document_job_maintenance(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_document_job(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_document_job(uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_document_parser_submission(uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_document_job(uuid,integer,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_document_job_pages(uuid,integer,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_document_job_page(uuid,integer,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_document_job(uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_document_job(uuid,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.control_document_job(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_document_job_maintenance(text,text) TO service_role;

COMMIT;
