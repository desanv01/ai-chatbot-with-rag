-- Reconcile the recovered application contract with the live Supabase schema.
--
-- This migration intentionally preserves the live subscriptions.id bigint type.
-- It is safe to run against the current empty project and fails rather than
-- inventing Stripe identifiers if existing subscription rows are incomplete.

BEGIN;

-- The remote snapshot already contains these extensions, but keeping these
-- guards makes the migration explicit and safe on a fresh local database.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- User profile contract
-- ---------------------------------------------------------------------------

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role text;

UPDATE public.users
SET role = 'user'
WHERE role IS NULL;

ALTER TABLE public.users
  ALTER COLUMN role SET DEFAULT 'user',
  ALTER COLUMN role SET NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_role_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_role_check
      CHECK (role = ANY (ARRAY['user'::text, 'admin'::text]));
  END IF;
END;
$$;

-- Users may edit profile fields, but not role or Stripe identity.
REVOKE UPDATE ON TABLE public.users FROM authenticated;
GRANT UPDATE (full_name, email) ON TABLE public.users TO authenticated;

-- ---------------------------------------------------------------------------
-- Existing subscriptions table
-- ---------------------------------------------------------------------------

-- Do not recreate this table: the live project uses bigint for id.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone
    DEFAULT CURRENT_TIMESTAMP;

UPDATE public.subscriptions
SET updated_at = CURRENT_TIMESTAMP
WHERE updated_at IS NULL;

DO $$
DECLARE
  incomplete_rows bigint;
BEGIN
  SELECT count(*)
  INTO incomplete_rows
  FROM public.subscriptions
  WHERE stripe_subscription_id IS NULL
     OR stripe_price_id IS NULL;

  IF incomplete_rows > 0 THEN
    RAISE EXCEPTION
      'Cannot reconcile subscriptions: % existing row(s) have no Stripe subscription or price identifier. Backfill them explicitly before retrying.',
      incomplete_rows;
  END IF;

  ALTER TABLE public.subscriptions
    ALTER COLUMN stripe_subscription_id SET NOT NULL,
    ALTER COLUMN stripe_price_id SET NOT NULL,
    ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN updated_at SET NOT NULL;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_id_unique
  ON public.subscriptions (user_id);

-- The live snapshot has a unique index, but PostgREST's relationship
-- metadata treats a foreign key as one-to-one only when a unique constraint
-- is present. Reuse the existing index instead of creating a duplicate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.subscriptions'::regclass
      AND conname = 'subscriptions_user_id_key'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_class
      WHERE relname = 'subscriptions_user_id_unique'
        AND relnamespace = 'public'::regnamespace
    ) THEN
      ALTER TABLE public.subscriptions
        ADD CONSTRAINT subscriptions_user_id_key
        UNIQUE USING INDEX subscriptions_user_id_unique;
    ELSE
      ALTER TABLE public.subscriptions
        ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
    END IF;
  END IF;
END;
$$;

-- Subscription data is readable by its owner only. Writes remain service-role
--/webhook operations.
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.subscriptions FROM anon, authenticated;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;

DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription"
ON public.subscriptions
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- Ownership policies for application tables
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can insert own data" ON public.users;
DROP POLICY IF EXISTS "Users can update own data" ON public.users;
DROP POLICY IF EXISTS "Users can view own data" ON public.users;
DROP POLICY IF EXISTS "users can read own profile" ON public.users;

CREATE POLICY "Users can insert own data"
ON public.users
FOR INSERT TO authenticated
WITH CHECK (id = (SELECT auth.uid()));

CREATE POLICY "Users can update own data"
ON public.users
FOR UPDATE TO authenticated
USING (id = (SELECT auth.uid()))
WITH CHECK (id = (SELECT auth.uid()));

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
    SELECT cs.id
    FROM public.chat_sessions AS cs
    WHERE cs.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  chat_session_id IN (
    SELECT cs.id
    FROM public.chat_sessions AS cs
    WHERE cs.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "Users can only access their own documents" ON public.user_documents;
CREATE POLICY "Users can only access their own documents"
ON public.user_documents
FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can only access their own document vectors" ON public.user_documents_vec;
CREATE POLICY "Users can only access their own document vectors"
ON public.user_documents_vec
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_documents AS doc
    WHERE doc.id = public.user_documents_vec.document_id
      AND doc.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_documents AS doc
    WHERE doc.id = public.user_documents_vec.document_id
      AND doc.user_id = (SELECT auth.uid())
  )
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_documents_vec ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Secure document similarity RPC
-- ---------------------------------------------------------------------------

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

-- Harden the trigger function's name resolution without changing its behavior.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO public.users (id, full_name, email)
  VALUES (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.email
  );
  RETURN new;
END;
$$;

-- ---------------------------------------------------------------------------
-- Storage ownership policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "User can select own files" ON storage.objects;
CREATE POLICY "User can select own files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'userfiles'::text
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "User can insert own files" ON storage.objects;
CREATE POLICY "User can insert own files"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'userfiles'::text
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "User can update own files" ON storage.objects;
CREATE POLICY "User can update own files"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'userfiles'::text
  AND (auth.uid())::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'userfiles'::text
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "User can delete own files" ON storage.objects;
CREATE POLICY "User can delete own files"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'userfiles'::text
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

COMMIT;
