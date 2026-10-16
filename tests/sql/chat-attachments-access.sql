CREATE FUNCTION pg_temp.expect_error(command text, expected_state text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE failed boolean := false;
BEGIN
  BEGIN EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> expected_state THEN RAISE; END IF;
    failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Expected rejection: %', expected_state; END IF;
END $$;

INSERT INTO auth.users(id,email,raw_user_meta_data)
VALUES ('fa110000-0000-4000-8000-000000000001','attachment-offline@example.invalid','{"full_name":"Offline attachment fixture"}');
INSERT INTO public.chat_sessions(id,user_id)
VALUES ('fa220000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000001');
INSERT INTO public.chat_attachment_objects(object_path,user_id,chat_session_id,filename,media_type,byte_size,sha256)
VALUES ('fa110000-0000-4000-8000-000000000001/fa220000-0000-4000-8000-000000000001/'||repeat('a',64)||'.pdf','fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001','fixture.pdf','application/pdf',20,repeat('a',64));
DO $$ BEGIN
  ASSERT (SELECT NOT public AND file_size_limit=3145728 AND allowed_mime_types=ARRAY['application/pdf']::text[] FROM storage.buckets WHERE id='chat-attachments');
  ASSERT NOT has_table_privilege('authenticated','public.chat_attachment_objects','SELECT');
  ASSERT NOT has_table_privilege('anon','public.chat_attachment_objects','SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.chat_attachment_cleanup_jobs','SELECT');
  ASSERT has_table_privilege('service_role','public.chat_attachment_objects','INSERT');
  ASSERT NOT has_function_privilege('authenticated','public.queue_chat_attachment_cleanup()','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.queue_chat_attachment_cleanup()','EXECUTE');
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_attachment_objects'::regclass);
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_attachment_cleanup_jobs'::regclass);
END $$;
SELECT pg_temp.expect_error($q$INSERT INTO public.chat_attachment_objects(object_path,user_id,chat_session_id,filename,media_type,byte_size,sha256) VALUES ('wrong','fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001','bad.pdf','application/pdf',20,repeat('b',64))$q$,'23514');
INSERT INTO storage.buckets(id,name,public) VALUES ('attachment-local-control','attachment-local-control',false);
INSERT INTO storage.objects(bucket_id,name) VALUES ('attachment-local-control','control'),('chat-attachments','fa110000-0000-4000-8000-000000000001/fa220000-0000-4000-8000-000000000001/'||repeat('a',64)||'.pdf');
CREATE POLICY offline_attachment_allow_all ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
SELECT set_config('request.jwt.claim.sub','fa110000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"sub":"fa110000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  ASSERT (SELECT count(*)=0 FROM storage.objects WHERE bucket_id='chat-attachments');
  ASSERT (SELECT count(*)=1 FROM storage.objects WHERE bucket_id='attachment-local-control');
END $$;
SELECT pg_temp.expect_error('SELECT * FROM public.chat_attachment_objects','42501');
SELECT pg_temp.expect_error('SELECT * FROM public.chat_attachment_cleanup_jobs','42501');
SELECT pg_temp.expect_error($q$INSERT INTO storage.objects(bucket_id,name) VALUES ('chat-attachments','client-write')$q$,'42501');
DELETE FROM public.chat_sessions WHERE id='fa220000-0000-4000-8000-000000000001';
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT count(*)=0 FROM public.chat_attachment_objects);
  ASSERT (SELECT count(*)=1 FROM public.chat_attachment_cleanup_jobs);
  ASSERT (SELECT attempts=0 AND last_error IS NULL FROM public.chat_attachment_cleanup_jobs LIMIT 1);
END $$;
SELECT 'PASS private attachment schema, grants, restrictive Storage access and cascade cleanup outbox' AS result;
