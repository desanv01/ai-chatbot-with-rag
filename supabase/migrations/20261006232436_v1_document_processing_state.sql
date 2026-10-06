-- Additive processing state. Duplicate legacy paths must fail for manual review.
BEGIN;

ALTER TABLE public.user_documents
  ADD COLUMN processing_status text NOT NULL DEFAULT 'processing',
  ADD COLUMN processing_job_id text,
  ADD COLUMN processing_error text,
  ADD CONSTRAINT user_documents_processing_status_check
    CHECK (processing_status IN ('processing', 'ready', 'failed'));

UPDATE public.user_documents AS doc
SET processing_status = CASE WHEN
  doc.total_pages > 0
  AND (SELECT count(*) FROM public.user_documents_vec AS vec WHERE vec.document_id = doc.id) = doc.total_pages
  AND (SELECT count(DISTINCT vec.page_number) FROM public.user_documents_vec AS vec WHERE vec.document_id = doc.id) = doc.total_pages
  AND (SELECT min(vec.page_number) FROM public.user_documents_vec AS vec WHERE vec.document_id = doc.id) = 1
  AND (SELECT max(vec.page_number) FROM public.user_documents_vec AS vec WHERE vec.document_id = doc.id) = doc.total_pages
  AND NOT EXISTS (
    SELECT 1 FROM public.user_documents_vec AS vec
    WHERE vec.document_id = doc.id
      AND (vec.embedding IS NULL OR vec.text_content IS NULL OR vec.text_content !~ '[^[:space:]]')
  ) THEN 'ready' ELSE 'failed' END;

UPDATE public.user_documents
SET processing_error = 'Legacy document requires review. Review and back up the existing document before deliberately deleting it and uploading it again.'
WHERE processing_status = 'failed';

CREATE UNIQUE INDEX user_documents_user_file_path_unique
  ON public.user_documents (user_id, file_path);
CREATE UNIQUE INDEX user_documents_user_processing_job_unique
  ON public.user_documents (user_id, processing_job_id)
  WHERE processing_job_id IS NOT NULL;

-- Keep existing SELECT/DELETE and RLS. Clients may write only prior columns.
REVOKE INSERT, UPDATE ON TABLE public.user_documents FROM PUBLIC, anon, authenticated;
REVOKE INSERT (processing_status, processing_job_id, processing_error),
  UPDATE (processing_status, processing_job_id, processing_error)
  ON public.user_documents FROM PUBLIC, anon, authenticated;
GRANT INSERT (id, user_id, title, total_pages, ai_description, ai_keyentities,
  ai_maintopics, ai_title, file_path, created_at, updated_at),
  UPDATE (id, user_id, title, total_pages, ai_description, ai_keyentities,
  ai_maintopics, ai_title, file_path, created_at, updated_at)
  ON public.user_documents TO authenticated;
GRANT INSERT, UPDATE ON public.user_documents TO service_role;

-- Ready vectors must not be changed directly by clients after finalization.
-- Keep SELECT and parent document DELETE/FK cascade behavior unchanged.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_documents_vec
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT (id, document_id, text_content, page_number, embedding),
  UPDATE (id, document_id, text_content, page_number, embedding)
  ON public.user_documents_vec FROM PUBLIC, anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_documents_vec TO service_role;

CREATE OR REPLACE FUNCTION public.complete_document_processing(
  p_document_id uuid,
  p_user_id uuid,
  p_job_id text,
  p_expected_page_numbers integer[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  document_record public.user_documents%ROWTYPE;
  expected_pages integer[];
  actual_pages integer[];
BEGIN
  SELECT doc.* INTO document_record
  FROM public.user_documents AS doc
  WHERE doc.id = p_document_id
    AND doc.user_id = p_user_id
    AND doc.processing_job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR document_record.processing_status NOT IN ('processing', 'ready') THEN
    RAISE EXCEPTION 'Document processing cannot be finalized';
  END IF;

  IF p_expected_page_numbers IS NULL
    OR cardinality(p_expected_page_numbers) = 0
    OR document_record.total_pages IS NULL
    OR document_record.total_pages <= 0 THEN
    RAISE EXCEPTION 'Invalid expected document pages';
  END IF;

  SELECT array_agg(page_number ORDER BY page_number) INTO expected_pages
  FROM unnest(p_expected_page_numbers) AS pages(page_number);

  IF EXISTS (
    SELECT 1 FROM unnest(p_expected_page_numbers) AS pages(page_number)
    WHERE page_number IS NULL OR page_number <= 0 OR page_number > document_record.total_pages
  ) OR (SELECT count(DISTINCT page_number) FROM unnest(p_expected_page_numbers) AS pages(page_number))
    <> cardinality(p_expected_page_numbers) THEN
    RAISE EXCEPTION 'Invalid expected document pages';
  END IF;

  SELECT array_agg(vec.page_number ORDER BY vec.page_number) INTO actual_pages
  FROM public.user_documents_vec AS vec
  WHERE vec.document_id = p_document_id;

  IF actual_pages IS DISTINCT FROM expected_pages OR EXISTS (
    SELECT 1 FROM public.user_documents_vec AS vec
    WHERE vec.document_id = p_document_id
      AND (vec.embedding IS NULL OR vec.text_content IS NULL OR vec.text_content !~ '[^[:space:]]')
  ) THEN
    RAISE EXCEPTION 'Document vectors are incomplete';
  END IF;

  UPDATE public.user_documents AS doc
  SET processing_status = 'ready', processing_error = NULL
  WHERE doc.id = p_document_id AND doc.user_id = p_user_id AND doc.processing_job_id = p_job_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_document_processing(uuid, uuid, text, integer[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_processing(uuid, uuid, text, integer[])
  TO service_role;

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
    AND 1 - (vec.embedding <=> query_embedding) > similarity_threshold
  ORDER BY vec.embedding <=> query_embedding ASC
  LIMIT LEAST(match_count, 200);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_documents(
  extensions.vector,
  integer,
  uuid,
  uuid[],
  double precision
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.match_documents(
  extensions.vector,
  integer,
  uuid,
  uuid[],
  double precision
) TO authenticated, service_role;

COMMIT;
