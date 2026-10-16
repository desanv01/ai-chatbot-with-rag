DO $$ BEGIN
  ASSERT NOT has_function_privilege('authenticated','public.reserve_chat_attachment(uuid,uuid,text,text,bigint)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.claim_chat_attachment_cleanup(integer,uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','public.finish_chat_attachment_cleanup(text,uuid,boolean)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','public.claim_chat_attachment_maintenance(text,text)','EXECUTE');
  ASSERT NOT has_table_privilege('authenticated','public.chat_attachment_maintenance','SELECT');
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_attachment_maintenance'::regclass);
  ASSERT (SELECT next_attempt_at >= queued_at + interval '10 minutes' FROM public.chat_attachment_cleanup_jobs LIMIT 1);
END $$;
INSERT INTO public.chat_sessions(id,user_id)
VALUES ('fa220000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000001');
SET LOCAL ROLE service_role;
DO $$ BEGIN
  ASSERT (SELECT filename='reserved.pdf' FROM public.reserve_chat_attachment('fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001',repeat('b',64),'reserved.pdf',50));
  ASSERT (SELECT filename='reserved.pdf' FROM public.reserve_chat_attachment('fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001',repeat('b',64),'renamed.pdf',50));
END $$;
SELECT pg_temp.expect_error($q$SELECT * FROM public.reserve_chat_attachment('fa110000-0000-4000-8000-000000000099','fa220000-0000-4000-8000-000000000001',repeat('c',64),'foreign.pdf',50)$q$,'P0001');
SELECT pg_temp.expect_error($q$SELECT * FROM public.reserve_chat_attachment('fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001',repeat('c',64),' bad.pdf',50)$q$,'P0001');
SELECT pg_temp.expect_error($q$SELECT * FROM public.reserve_chat_attachment('fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001',repeat('c',64),'small.pdf',4)$q$,'P0001');
DO $$ BEGIN
  ASSERT public.claim_chat_attachment_maintenance('run-A',NULL);
  ASSERT public.claim_chat_attachment_maintenance('run-A',NULL);
  ASSERT NOT public.claim_chat_attachment_maintenance('run-B',NULL);
  ASSERT public.claim_chat_attachment_maintenance('run-child','run-A');
  ASSERT NOT public.claim_chat_attachment_maintenance('run-A',NULL);
END $$;
RESET ROLE;
UPDATE public.chat_attachment_maintenance SET lease_until=now()-interval '1 second';
SET LOCAL ROLE service_role;
DO $$ BEGIN ASSERT public.claim_chat_attachment_maintenance('run-recovered',NULL); END $$;
DELETE FROM public.chat_sessions WHERE id='fa220000-0000-4000-8000-000000000001';
-- Both deleted paths are now due; claims must be exclusive and token-bound.
UPDATE public.chat_attachment_cleanup_jobs SET next_attempt_at=now()-interval '1 second';
DO $$ BEGIN
  ASSERT (SELECT count(*)=2 FROM public.claim_chat_attachment_cleanup(5,'fa330000-0000-4000-8000-000000000001'));
  ASSERT (SELECT count(*)=0 FROM public.claim_chat_attachment_cleanup(5,'fa330000-0000-4000-8000-000000000002'));
  ASSERT NOT public.finish_chat_attachment_cleanup('fa110000-0000-4000-8000-000000000001/fa220000-0000-4000-8000-000000000001/'||repeat('b',64)||'.pdf','fa330000-0000-4000-8000-000000000002',true);
  ASSERT public.finish_chat_attachment_cleanup('fa110000-0000-4000-8000-000000000001/fa220000-0000-4000-8000-000000000001/'||repeat('b',64)||'.pdf','fa330000-0000-4000-8000-000000000001',false);
  ASSERT (SELECT attempts=1 AND lease_token IS NULL AND next_attempt_at>now() AND last_error='Attachment storage cleanup failed' FROM public.chat_attachment_cleanup_jobs WHERE object_path LIKE '%/'||repeat('b',64)||'.pdf');
END $$;
UPDATE public.chat_attachment_cleanup_jobs SET next_attempt_at=now()-interval '1 second' WHERE object_path LIKE '%/'||repeat('b',64)||'.pdf';
DO $$ BEGIN
  ASSERT (SELECT count(*)=1 FROM public.claim_chat_attachment_cleanup(5,'fa330000-0000-4000-8000-000000000002'));
  ASSERT public.finish_chat_attachment_cleanup('fa110000-0000-4000-8000-000000000001/fa220000-0000-4000-8000-000000000001/'||repeat('b',64)||'.pdf','fa330000-0000-4000-8000-000000000002',true);
  ASSERT NOT public.finish_chat_attachment_cleanup('fa110000-0000-4000-8000-000000000001/fa220000-0000-4000-8000-000000000001/'||repeat('b',64)||'.pdf','fa330000-0000-4000-8000-000000000001',true);
  ASSERT (SELECT count(*)=0 FROM public.claim_chat_attachment_cleanup(5,'fa330000-0000-4000-8000-000000000003'));
END $$;
INSERT INTO public.chat_sessions(id,user_id)
VALUES ('fa220000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000001');
SELECT pg_temp.expect_error($q$SELECT * FROM public.reserve_chat_attachment('fa110000-0000-4000-8000-000000000001','fa220000-0000-4000-8000-000000000001',repeat('b',64),'retired.pdf',50)$q$,'P0001');
-- Expired leases can be reclaimed; terminal attempt count is bounded.
UPDATE public.chat_attachment_cleanup_jobs SET lease_expires_at=now()-interval '1 second' WHERE completed_at IS NULL;
DO $$ BEGIN ASSERT (SELECT count(*)=1 FROM public.claim_chat_attachment_cleanup(5,'fa330000-0000-4000-8000-000000000003')); END $$;
UPDATE public.chat_attachment_cleanup_jobs SET attempts=10,lease_expires_at=now()-interval '1 second' WHERE completed_at IS NULL;
DO $$ BEGIN ASSERT (SELECT count(*)=0 FROM public.claim_chat_attachment_cleanup(5,'fa330000-0000-4000-8000-000000000004')); END $$;
RESET ROLE;
SELECT 'PASS reservation, role denial, queue lease/retry/tombstone and maintenance handoff RPCs' AS result;
