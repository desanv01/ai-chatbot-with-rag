-- Reconcile the live schema with the application contract.
-- Apply after database/setup.sql in the Supabase SQL editor or migration runner.
-- This migration is intentionally explicit: it fails rather than inventing
-- Stripe values if an existing subscriptions table has incompatible data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- The application reads role and Stripe customer identity from public.users.
ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS role text;

UPDATE public.users
SET role = 'user'
WHERE role IS NULL;

ALTER TABLE IF EXISTS public.users
  ALTER COLUMN role SET DEFAULT 'user',
  ALTER COLUMN role SET NOT NULL;

ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- The dashboard and /api/user-data routes expect one subscription row per user.
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid NOT NULL DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NULL,
  status text NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_price_id text NOT NULL,
  stripe_current_period_end timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_key'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
  ON public.subscriptions (user_id);

ALTER TABLE IF EXISTS public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Keep subscription writes behind the service role/webhook path.
DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription"
ON public.subscriptions
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

REVOKE UPDATE ON public.users FROM authenticated;
GRANT UPDATE (full_name, email) ON public.users TO authenticated;

-- Make all application-owned rows enforce both read and write ownership.
DROP POLICY IF EXISTS "Users can insert own data" ON public.users;
CREATE POLICY "Users can insert own data"
ON public.users
FOR INSERT TO authenticated
WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own data" ON public.users;
CREATE POLICY "Users can update own data"
ON public.users
FOR UPDATE TO authenticated
USING (id = (SELECT auth.uid()))
WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can view own data" ON public.users;
CREATE POLICY "Users can view own data"
ON public.users
FOR SELECT TO authenticated
USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can view own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can view own chat sessions"
ON public.chat_sessions
FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can view messages from their sessions" ON public.message_parts;
CREATE POLICY "Users can view messages from their sessions"
ON public.message_parts
FOR ALL TO authenticated
USING (
  chat_session_id IN (
    SELECT chat_sessions.id
    FROM public.chat_sessions
    WHERE chat_sessions.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  chat_session_id IN (
    SELECT chat_sessions.id
    FROM public.chat_sessions
    WHERE chat_sessions.user_id = (SELECT auth.uid())
  )
);

ALTER TABLE IF EXISTS public.user_documents
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP;

DROP POLICY IF EXISTS "Users can only access their own documents" ON public.user_documents;
CREATE POLICY "Users can only access their own documents"
ON public.user_documents
FOR ALL TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can only access their own document vectors" ON public.user_documents_vec;
CREATE POLICY "Users can only access their own document vectors"
ON public.user_documents_vec
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_documents
    WHERE user_documents.id = user_documents_vec.document_id
      AND user_documents.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_documents
    WHERE user_documents.id = user_documents_vec.document_id
      AND user_documents.user_id = (SELECT auth.uid())
  )
);

-- Return document identity and Storage path with vector matches so callers do
-- not need to reconstruct paths from display titles.
DROP FUNCTION IF EXISTS public.match_documents(
  extensions.vector,
  integer,
  uuid,
  uuid[],
  double precision
);

CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding extensions.vector(1024),
  match_count int,
  filter_user_id uuid,
  file_ids uuid[],
  similarity_threshold float DEFAULT 0.30
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  text_content text,
  title text,
  file_path text,
  doc_timestamp timestamp with time zone,
  ai_title text,
  ai_description text,
  ai_maintopics text[],
  ai_keyentities text[],
  page_number integer,
  total_pages integer,
  similarity float
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    vec.id,
    doc.id AS document_id,
    vec.text_content,
    doc.title,
    doc.file_path,
    doc.created_at AS doc_timestamp,
    doc.ai_title,
    doc.ai_description,
    doc.ai_maintopics,
    doc.ai_keyentities,
    vec.page_number,
    doc.total_pages,
    1 - (vec.embedding <=> query_embedding) AS similarity
  FROM public.user_documents_vec vec
  INNER JOIN public.user_documents doc ON vec.document_id = doc.id
  WHERE doc.user_id = filter_user_id
    AND doc.user_id = (SELECT auth.uid())
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

-- Storage policies must be rerunnable and must constrain both old and new
-- object names to the authenticated user's first path segment.
DROP POLICY IF EXISTS "User can select own files" ON storage.objects;
CREATE POLICY "User can select own files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'userfiles'::text AND
  (auth.uid())::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "User can insert own files" ON storage.objects;
CREATE POLICY "User can insert own files"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'userfiles'::text AND
  (auth.uid())::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "User can update own files" ON storage.objects;
CREATE POLICY "User can update own files"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'userfiles'::text AND
  (auth.uid())::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'userfiles'::text AND
  (auth.uid())::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "User can delete own files" ON storage.objects;
CREATE POLICY "User can delete own files"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'userfiles'::text AND
  (auth.uid())::text = (storage.foldername(name))[1]
);

COMMIT;
