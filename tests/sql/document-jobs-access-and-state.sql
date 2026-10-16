CREATE FUNCTION pg_temp.expect_error(statement text, expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual text;
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual = RETURNED_SQLSTATE;
  END;
  ASSERT actual IS NOT DISTINCT FROM expected, format('Expected %s, received %s: %s', expected, actual, statement);
END $$;
INSERT INTO auth.users(id) VALUES
 ('fb110000-0000-4000-8000-000000000001'),
 ('fb110000-0000-4000-8000-000000000002');
DO $$ BEGIN
  ASSERT NOT has_table_privilege('anon','public.document_processing_jobs','SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.document_processing_jobs','SELECT');
  ASSERT has_column_privilege('authenticated','public.document_processing_jobs','status','SELECT');
  ASSERT NOT has_column_privilege('authenticated','public.document_processing_jobs','parser_job_id','SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.document_processing_pages','SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.document_job_maintenance','UPDATE');
  ASSERT NOT has_function_privilege('authenticated','public.reserve_document_job(uuid,text,text)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.claim_document_job(uuid,integer,text)','EXECUTE');
  ASSERT (SELECT count(*)=3 FROM pg_class WHERE oid IN (
    'public.document_processing_jobs'::regclass,'public.document_processing_pages'::regclass,
    'public.document_job_maintenance'::regclass) AND relrowsecurity);
END $$;
SET LOCAL ROLE service_role;
DO $$
DECLARE job public.document_processing_jobs%ROWTYPE; again public.document_processing_jobs%ROWTYPE;
  owner_id uuid := 'fb110000-0000-4000-8000-000000000001';
  source text := 'fb110000-0000-4000-8000-000000000001/fb220000-0000-4000-8000-000000000001.pdf';
  vec text := '[' || array_to_string(array_fill(0.1::real, ARRAY[1024]), ',') || ']';
  meta jsonb := '{"descriptiveTitle":"Test","shortDescription":"Synthetic","mainTopics":["Test"],"keyEntities":[],"primaryLanguage":"English"}';
BEGIN
  SELECT * INTO job FROM public.reserve_document_job(owner_id,'checkpoint.pdf',source);
  ASSERT job.status='queued' AND job.total_pages IS NULL AND job.generation=1;
  ASSERT (SELECT total_pages=0 AND processing_status='processing' FROM public.user_documents WHERE id=job.document_id);
  SELECT * INTO again FROM public.reserve_document_job(owner_id,'checkpoint.pdf',source);
  ASSERT again.id=job.id;
  PERFORM pg_temp.expect_error(format('SELECT * FROM public.reserve_document_job(%L,%L,%L)',owner_id,'second.pdf',replace(source,'000000000001.pdf','000000000002.pdf')),'55000');
  ASSERT public.claim_document_job(job.id,1,'run-A');
  ASSERT public.claim_document_job(job.id,1,'run-A');
  ASSERT NOT public.claim_document_job(job.id,1,'run-other');
  ASSERT NOT public.claim_document_job(job.id,2,'run-A');
  ASSERT public.checkpoint_document_job(job.id,1,'run-A',jsonb_build_object('source_sha256',repeat('a',64),'source_size',100));
  PERFORM pg_temp.expect_error(format('SELECT public.checkpoint_document_job(%L,1,%L,%L)',job.id,'run-A',jsonb_build_object('source_sha256',repeat('b',64))),'P0001');
  ASSERT public.begin_document_parser_submission(job.id,1,'run-A');
  ASSERT NOT public.begin_document_parser_submission(job.id,1,'run-A');
  ASSERT public.checkpoint_document_job(job.id,1,'run-A','{"parser_job_id":"saved-parser","status":"parsing"}');
  ASSERT public.store_document_job_pages(job.id,1,'run-A','[{"page_number":1,"markdown":"First"},{"page_number":2,"markdown":"  "},{"page_number":3,"markdown":"Third"}]');
  ASSERT (SELECT markdown='' FROM public.document_processing_pages WHERE job_id=job.id AND page_number=2);
  PERFORM pg_temp.expect_error(format('SELECT public.store_document_job_pages(%L,1,%L,%L)',job.id,'run-A','[{"page_number":1,"markdown":"Changed"}]'),'P0001');
  PERFORM pg_temp.expect_error(format('SELECT public.checkpoint_document_job(%L,1,%L,%L)',job.id,'run-A','{"total_pages":4}'),'P0001');
  ASSERT public.commit_document_job_page(job.id,1,'run-A',1,vec) IS NULL;
  ASSERT public.checkpoint_document_job(job.id,1,'run-A',jsonb_build_object('total_pages',3,'status','metadata'));
  ASSERT public.checkpoint_document_job(job.id,1,'run-A',jsonb_build_object('metadata',meta,'status','indexing'));
  PERFORM pg_temp.expect_error(format('SELECT public.checkpoint_document_job(%L,1,%L,%L)',job.id,'run-A','{"status":"parsing"}'),'P0001');
  PERFORM pg_temp.expect_error(format('SELECT public.commit_document_job_page(%L,1,%L,1,%L)',job.id,'run-A','[0.1,0.2]'),'P0001');
  ASSERT public.commit_document_job_page(job.id,1,'run-A',1,vec)=1;
  ASSERT public.commit_document_job_page(job.id,1,'run-A',1,vec)=1;
  ASSERT NOT public.complete_document_job(job.id,1,'run-A');
  ASSERT public.fail_document_job(job.id,1,'run-A','indexing_failed');
  SELECT * INTO again FROM public.control_document_job(job.id,owner_id,'resume');
  ASSERT again.generation=2 AND again.run_id IS NULL AND again.completed_pages=1 AND again.parser_job_id='saved-parser';
  ASSERT public.claim_document_job(job.id,2,'run-B');
  ASSERT NOT public.checkpoint_document_job(job.id,1,'run-A','{"status":"indexing"}');
  ASSERT public.commit_document_job_page(job.id,1,'run-A',3,vec) IS NULL;
  ASSERT NOT public.fail_document_job(job.id,1,'run-A','workflow_interrupted');
  ASSERT NOT public.begin_document_parser_submission(job.id,2,'run-B');
  ASSERT public.checkpoint_document_job(job.id,2,'run-B',jsonb_build_object('metadata',meta,'status','indexing'));
  ASSERT public.commit_document_job_page(job.id,2,'run-B',1,vec)=1;
  PERFORM pg_temp.expect_error(format('SELECT public.commit_document_job_page(%L,2,%L,2,%L)',job.id,'run-B',vec),'P0001');
  ASSERT public.commit_document_job_page(job.id,2,'run-B',2,NULL)=2;
  ASSERT public.commit_document_job_page(job.id,2,'run-B',3,vec)=3;
  ASSERT (SELECT count(*)=2 FROM public.user_documents_vec WHERE document_id=job.document_id);
  ASSERT public.complete_document_job(job.id,2,'run-B');
  ASSERT public.complete_document_job(job.id,2,'run-B');
  ASSERT NOT public.fail_document_job(job.id,2,'run-B','workflow_interrupted');
  ASSERT (SELECT count(*)=0 FROM public.document_processing_pages WHERE job_id=job.id);
  ASSERT (SELECT processing_status='ready' AND total_pages=3 FROM public.user_documents WHERE id=job.document_id);
  -- A started parser submission without its receipt must never be automatically repeated.
  SELECT * INTO job FROM public.reserve_document_job(owner_id,'unknown.pdf',replace(source,'000000000001.pdf','000000000003.pdf'));
  ASSERT public.claim_document_job(job.id,1,'uncertain-run');
  ASSERT public.begin_document_parser_submission(job.id,1,'uncertain-run');
  SELECT * INTO again FROM public.control_document_job(job.id,owner_id,'cancel');
  ASSERT again.status='cancelled' AND again.error_code='parser_submission_unknown';
  ASSERT NOT public.checkpoint_document_job(job.id,1,'uncertain-run','{"parser_job_id":"late"}');
  PERFORM pg_temp.expect_error(format('SELECT * FROM public.control_document_job(%L,%L,%L)',job.id,owner_id,'resume'),'P0001');
  PERFORM pg_temp.expect_error(format('SELECT * FROM public.control_document_job(%L,%L,%L)',job.id,'fb110000-0000-4000-8000-000000000002','cancel'),'P0001');
  -- Cancellation before submission safely resumes with a new generation.
  SELECT * INTO job FROM public.reserve_document_job(owner_id,'before.pdf',replace(source,'000000000001.pdf','000000000004.pdf'));
  SELECT * INTO again FROM public.control_document_job(job.id,owner_id,'cancel');
  ASSERT again.generation=2 AND again.error_code IS NULL;
  SELECT * INTO again FROM public.control_document_job(job.id,owner_id,'resume');
  ASSERT again.generation=3 AND again.status='queued';
  ASSERT public.claim_document_job_maintenance('maintenance-A',NULL);
  ASSERT NOT public.claim_document_job_maintenance('maintenance-B',NULL);
  ASSERT public.claim_document_job_maintenance('maintenance-child','maintenance-A');
  ASSERT NOT public.claim_document_job_maintenance('maintenance-A',NULL);
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','fb110000-0000-4000-8000-000000000002',true);
DO $$ BEGIN ASSERT (SELECT count(*)=0 FROM public.document_processing_jobs WHERE user_id='fb110000-0000-4000-8000-000000000001'); END $$;
SELECT pg_temp.expect_error('SELECT parser_job_id FROM public.document_processing_jobs','42501');
SELECT pg_temp.expect_error('SELECT * FROM public.document_processing_pages','42501');
SELECT pg_temp.expect_error('UPDATE public.document_processing_jobs SET status=''ready''','42501');
SELECT pg_temp.expect_error('SELECT public.claim_document_job_maintenance(''client'',NULL)','42501');
SELECT set_config('request.jwt.claim.sub','fb110000-0000-4000-8000-000000000001',true);
DO $$ BEGIN ASSERT (SELECT count(*)=3 FROM public.document_processing_jobs); END $$;
RESET ROLE;
SELECT 'PASS durable jobs: grants/RLS, one active owner, at-most-once parser marker, page checkpoints, generation/run fences, resume/cancel, blank pages, idempotent completion and maintenance handoff' AS result;
