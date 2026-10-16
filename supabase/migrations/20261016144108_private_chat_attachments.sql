BEGIN;

-- Never change an existing bucket's configuration or existing stored objects.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'chat-attachments',
  'chat-attachments',
  false,
  3145728,
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO NOTHING;

DO $bucket_configuration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.id = 'chat-attachments'
      AND (
        bucket.name IS DISTINCT FROM 'chat-attachments'
        OR bucket.public IS DISTINCT FROM false
        OR bucket.file_size_limit IS DISTINCT FROM 3145728
        OR bucket.allowed_mime_types IS DISTINCT FROM ARRAY['application/pdf']::text[]
      )
  ) THEN
    RAISE EXCEPTION 'Existing chat-attachments bucket has incompatible configuration';
  END IF;
END;
$bucket_configuration$;

CREATE TABLE public.chat_attachment_objects (
  object_path text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  chat_session_id uuid NOT NULL REFERENCES public.chat_sessions (id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (
    pg_catalog.char_length(filename) BETWEEN 1 AND 255
    AND filename = pg_catalog.btrim(filename)
    AND filename !~ U&'[\0001-\001F\007F-\009F]'
  ),
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 5 AND 3145728),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chat_attachment_objects_canonical_path CHECK (
    object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}[.]pdf$'
  ),
  CONSTRAINT chat_attachment_objects_path_matches_metadata CHECK (
    object_path = user_id::text || '/' || chat_session_id::text || '/' || sha256 || '.pdf'
  )
);

CREATE INDEX chat_attachment_objects_chat_session_id_idx
  ON public.chat_attachment_objects (chat_session_id);
CREATE INDEX chat_attachment_objects_user_id_idx
  ON public.chat_attachment_objects (user_id);

CREATE TABLE public.chat_attachment_cleanup_jobs (
  object_path text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT (pg_catalog.now() + interval '10 minutes'),
  last_error text,
  completed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  CONSTRAINT chat_attachment_cleanup_jobs_canonical_path CHECK (
    object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}[.]pdf$'
  )
);

ALTER TABLE public.chat_attachment_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_attachment_cleanup_jobs ENABLE ROW LEVEL SECURITY;

CREATE INDEX chat_attachment_cleanup_jobs_due_idx
  ON public.chat_attachment_cleanup_jobs (next_attempt_at, queued_at)
  WHERE completed_at IS NULL AND attempts < 10;

-- Completed cleanup rows remain permanent tombstones. Never reuse deleted paths:
-- a delayed storage deletion from an earlier lease must not delete a new upload.

CREATE TABLE public.chat_attachment_maintenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id text,
  lease_until timestamptz
);

INSERT INTO public.chat_attachment_maintenance (singleton) VALUES (true);
ALTER TABLE public.chat_attachment_maintenance ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.chat_attachment_objects FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.chat_attachment_cleanup_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_attachment_objects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_attachment_cleanup_jobs TO service_role;
REVOKE ALL ON TABLE public.chat_attachment_maintenance FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_attachment_maintenance TO service_role;

CREATE FUNCTION public.reserve_chat_attachment(
  p_user_id uuid,
  p_chat_id uuid,
  p_sha256 text,
  p_filename text,
  p_byte_size bigint
)
RETURNS SETOF public.chat_attachment_objects
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $reserve_attachment$
DECLARE
  attachment_path text;
BEGIN
  IF p_user_id IS NULL OR p_chat_id IS NULL
    OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_filename IS NULL OR pg_catalog.char_length(p_filename) NOT BETWEEN 1 AND 255
    OR p_filename <> pg_catalog.btrim(p_filename)
    OR p_filename ~ U&'[\0001-\001F\007F-\009F]'
    OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 5 AND 3145728
  THEN
    RAISE EXCEPTION 'Invalid attachment metadata';
  END IF;

  attachment_path := p_user_id::text || '/' || p_chat_id::text || '/' || p_sha256 || '.pdf';
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(attachment_path, 0));

  PERFORM 1
  FROM public.chat_sessions AS chat
  WHERE chat.id = p_chat_id AND chat.user_id = p_user_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment access denied';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.chat_attachment_cleanup_jobs AS job
    WHERE job.object_path = attachment_path
  ) THEN
    RAISE EXCEPTION 'Attachment path is retired';
  END IF;

  INSERT INTO public.chat_attachment_objects (
    object_path, user_id, chat_session_id, filename, media_type, byte_size, sha256
  )
  VALUES (
    attachment_path, p_user_id, p_chat_id, p_filename, 'application/pdf', p_byte_size, p_sha256
  )
  ON CONFLICT (object_path) DO NOTHING;

  RETURN QUERY
  SELECT attachment.* FROM public.chat_attachment_objects AS attachment
  WHERE attachment.object_path = attachment_path;
END;
$reserve_attachment$;

CREATE FUNCTION public.claim_chat_attachment_cleanup(p_limit integer, p_token uuid)
RETURNS TABLE (object_path text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $claim_cleanup$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR p_token IS NULL THEN
    RAISE EXCEPTION 'Invalid cleanup claim';
  END IF;

  RETURN QUERY
  WITH due_jobs AS (
    SELECT job.object_path
    FROM public.chat_attachment_cleanup_jobs AS job
    WHERE job.completed_at IS NULL
      AND job.next_attempt_at <= pg_catalog.now()
      AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= pg_catalog.now())
      AND job.attempts < 10
      AND NOT EXISTS (
        SELECT 1 FROM public.chat_attachment_objects AS attachment
        WHERE attachment.object_path = job.object_path
      )
    ORDER BY job.next_attempt_at, job.queued_at, job.object_path
    LIMIT p_limit
    FOR UPDATE OF job SKIP LOCKED
  )
  UPDATE public.chat_attachment_cleanup_jobs AS claimed
  SET attempts = claimed.attempts + 1,
      lease_token = p_token,
      lease_expires_at = pg_catalog.now() + interval '5 minutes'
  FROM due_jobs
  WHERE claimed.object_path = due_jobs.object_path
  RETURNING claimed.object_path;
END;
$claim_cleanup$;

CREATE FUNCTION public.finish_chat_attachment_cleanup(
  p_path text,
  p_token uuid,
  p_success boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $finish_cleanup$
BEGIN
  IF p_success IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.chat_attachment_cleanup_jobs AS job
  SET completed_at = CASE WHEN p_success THEN pg_catalog.now() ELSE NULL END,
      last_error = CASE WHEN p_success THEN NULL ELSE 'Attachment storage cleanup failed' END,
      next_attempt_at = CASE
        WHEN p_success THEN job.next_attempt_at
        ELSE pg_catalog.now() + interval '1 minute' * LEAST(
          360::numeric,
          pg_catalog.power(2::numeric, LEAST(job.attempts, 10))
        )::double precision
      END,
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE job.object_path = p_path
    AND job.lease_token = p_token
    AND job.completed_at IS NULL;

  RETURN FOUND;
END;
$finish_cleanup$;

CREATE FUNCTION public.claim_chat_attachment_maintenance(
  p_run_id text,
  p_previous_run_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $claim_maintenance$
DECLARE
  current_run_id text;
  current_lease_until timestamptz;
BEGIN
  IF p_run_id IS NULL OR pg_catalog.btrim(p_run_id) = '' THEN
    RAISE EXCEPTION 'Invalid maintenance run';
  END IF;

  SELECT maintenance.run_id, maintenance.lease_until
  INTO current_run_id, current_lease_until
  FROM public.chat_attachment_maintenance AS maintenance
  WHERE maintenance.singleton = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment maintenance state is unavailable';
  END IF;

  IF current_run_id = p_run_id
    OR current_lease_until IS NULL
    OR current_lease_until <= pg_catalog.now()
    OR (p_previous_run_id IS NOT NULL AND current_run_id = p_previous_run_id)
  THEN
    UPDATE public.chat_attachment_maintenance AS maintenance
    SET run_id = p_run_id, lease_until = pg_catalog.now() + interval '2 hours'
    WHERE maintenance.singleton = true;
    RETURN true;
  END IF;

  RETURN false;
END;
$claim_maintenance$;

REVOKE EXECUTE ON FUNCTION public.reserve_chat_attachment(uuid, uuid, text, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_chat_attachment_cleanup(integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finish_chat_attachment_cleanup(text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_chat_attachment_maintenance(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_chat_attachment(uuid, uuid, text, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_chat_attachment_cleanup(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_chat_attachment_cleanup(text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_chat_attachment_maintenance(text, text) TO service_role;

-- Cascaded metadata deletion queues storage cleanup without making remote calls.
CREATE FUNCTION public.queue_chat_attachment_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $queue_cleanup$
BEGIN
  -- Ten minutes exceeds bounded 30-second Storage requests and 300-second route
  -- execution, allowing an accepted upload to finish before deletion is eligible.
  INSERT INTO public.chat_attachment_cleanup_jobs (object_path, next_attempt_at)
  VALUES (OLD.object_path, pg_catalog.now() + interval '10 minutes')
  ON CONFLICT (object_path) DO NOTHING;

  RETURN OLD;
END;
$queue_cleanup$;

REVOKE EXECUTE ON FUNCTION public.queue_chat_attachment_cleanup() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER queue_chat_attachment_cleanup_before_delete
BEFORE DELETE ON public.chat_attachment_objects
FOR EACH ROW EXECUTE FUNCTION public.queue_chat_attachment_cleanup();

-- This restriction also applies when a pre-existing permissive policy grants access.
CREATE POLICY chat_attachments_block_client_access
ON storage.objects
AS RESTRICTIVE
FOR ALL
TO anon, authenticated
USING (bucket_id <> 'chat-attachments')
WITH CHECK (bucket_id <> 'chat-attachments');

COMMIT;
