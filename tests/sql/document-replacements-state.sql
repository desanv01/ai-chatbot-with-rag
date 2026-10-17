CREATE FUNCTION pg_temp.expect_error(statement text, expected text) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE actual text; BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE; END;
  ASSERT actual IS NOT DISTINCT FROM expected, format('Expected %s received %s: %s',expected,actual,statement);
END $$;
INSERT INTO auth.users(id) VALUES ('fc110000-0000-4000-8000-000000000001'),('fc110000-0000-4000-8000-000000000002');
INSERT INTO public.user_documents(id,user_id,title,total_pages,file_path,processing_status,processing_job_id)
VALUES ('fc220000-0000-4000-8000-000000000001','fc110000-0000-4000-8000-000000000001','original.pdf',1,
 'fc110000-0000-4000-8000-000000000001/fc330000-0000-4000-8000-000000000001.pdf','ready','legacy-original');
INSERT INTO public.user_documents_vec(document_id,page_number,text_content,embedding)
VALUES ('fc220000-0000-4000-8000-000000000001',1,'Original retained text',('['||array_to_string(array_fill(0.1::real,ARRAY[1024]),',')||']')::extensions.vector(1024));
INSERT INTO storage.buckets(id,name,public) VALUES('userfiles','userfiles',false) ON CONFLICT(id) DO NOTHING;
INSERT INTO storage.objects(bucket_id,name) VALUES
 ('userfiles','fc110000-0000-4000-8000-000000000001/fc330000-0000-4000-8000-000000000001.pdf'),
 ('userfiles','fc110000-0000-4000-8000-000000000001/unversioned-control.pdf');
CREATE TEMP TABLE replacement_receipts (first_job uuid,first_document uuid,second_job uuid,second_document uuid,series_id uuid);
GRANT ALL ON replacement_receipts TO service_role,authenticated;
SET LOCAL ROLE service_role;
DO $$ DECLARE
 owner_id uuid:='fc110000-0000-4000-8000-000000000001';
 old_id uuid:='fc220000-0000-4000-8000-000000000001';
 first_job public.document_processing_jobs%ROWTYPE;
 second_job public.document_processing_jobs%ROWTYPE;
  cancelled_job public.document_processing_jobs%ROWTYPE;
 again public.document_processing_jobs%ROWTYPE;
 sid uuid;
 metadata jsonb:='{"descriptiveTitle":"Replacement","shortDescription":"Synthetic","mainTopics":[],"keyEntities":[],"primaryLanguage":"English"}';
 vec text:='['||array_to_string(array_fill(0.1::real,ARRAY[1024]),',')||']';
BEGIN
 SELECT * INTO first_job FROM public.reserve_document_replacement(owner_id,old_id,'original.pdf',owner_id::text||'/fc330000-0000-4000-8000-000000000002.pdf');
 SELECT series_id INTO sid FROM public.document_series_members WHERE document_id=old_id;
 ASSERT first_job.document_id<>old_id AND first_job.file_name='original.pdf';
 ASSERT (SELECT title='original.pdf' AND processing_status='ready' AND processing_job_id='legacy-original' FROM public.user_documents WHERE id=old_id);
 ASSERT (SELECT title<>'original.pdf' AND title LIKE '%[v2-%].pdf' FROM public.user_documents WHERE id=first_job.document_id);
 ASSERT (SELECT active_document_id=old_id FROM public.document_series WHERE id=sid);
 SELECT * INTO again FROM public.reserve_document_replacement(owner_id,old_id,'original.pdf',first_job.file_path);
 ASSERT again.id=first_job.id;
 PERFORM pg_temp.expect_error(format('SELECT * FROM public.reserve_document_replacement(%L,%L,%L,%L)','fc110000-0000-4000-8000-000000000002',old_id,'original.pdf','fc110000-0000-4000-8000-000000000002/fc330000-0000-4000-8000-000000000003.pdf'),'P0001');
 ASSERT public.claim_document_job(first_job.id,1,'replace-A');
 ASSERT public.fail_document_job(first_job.id,1,'replace-A','metadata_failed');
 ASSERT (SELECT active_document_id=old_id FROM public.document_series WHERE id=sid);
 ASSERT (SELECT count(*)=1 FROM public.user_documents_vec WHERE document_id=old_id);
 SELECT * INTO again FROM public.control_document_job(first_job.id,owner_id,'resume');
 ASSERT public.claim_document_job(first_job.id,2,'replace-B');
 ASSERT public.store_document_job_pages(first_job.id,2,'replace-B','[{"page_number":1,"markdown":"Replacement version two"}]');
 ASSERT public.checkpoint_document_job(first_job.id,2,'replace-B',jsonb_build_object('metadata',metadata,'total_pages',1,'status','indexing'));
 ASSERT public.commit_document_job_page(first_job.id,2,'replace-B',1,vec)=1;
 ASSERT public.complete_document_job(first_job.id,2,'replace-B');
 ASSERT (SELECT active_document_id=first_job.document_id FROM public.document_series WHERE id=sid);
 ASSERT (SELECT promoted_at IS NOT NULL FROM public.document_replacement_candidates WHERE job_id=first_job.id);
 ASSERT (SELECT title='original.pdf' AND file_path=owner_id::text||'/fc330000-0000-4000-8000-000000000001.pdf' FROM public.user_documents WHERE id=old_id);
 ASSERT (SELECT text_content='Original retained text' FROM public.user_documents_vec WHERE document_id=old_id);
 PERFORM pg_temp.expect_error(format('SELECT * FROM public.reserve_document_replacement(%L,%L,%L,%L)',owner_id,old_id,'original.pdf',owner_id::text||'/fc330000-0000-4000-8000-000000000003.pdf'),'P0001');
  SELECT * INTO cancelled_job FROM public.reserve_document_replacement(owner_id,first_job.document_id,'original.pdf',owner_id::text||'/fc330000-0000-4000-8000-000000000005.pdf');
  PERFORM public.control_document_job(cancelled_job.id,owner_id,'cancel');
 SELECT * INTO second_job FROM public.reserve_document_replacement(owner_id,first_job.document_id,'original.pdf',owner_id::text||'/fc330000-0000-4000-8000-000000000004.pdf');
  ASSERT (SELECT version=4 FROM public.document_series_members WHERE document_id=second_job.document_id);
 ASSERT public.claim_document_job(second_job.id,1,'replace-C');
 ASSERT public.store_document_job_pages(second_job.id,1,'replace-C','[{"page_number":1,"markdown":"Replacement version three"}]');
 ASSERT public.checkpoint_document_job(second_job.id,1,'replace-C',jsonb_build_object('metadata',metadata,'total_pages',1,'status','indexing'));
 ASSERT public.commit_document_job_page(second_job.id,1,'replace-C',1,vec)=1;
 ASSERT public.complete_document_job(second_job.id,1,'replace-C');
 ASSERT (SELECT active_document_id=second_job.document_id FROM public.document_series WHERE id=sid);
  PERFORM pg_temp.expect_error(format('SELECT * FROM public.control_document_job(%L,%L,%L)',cancelled_job.id,owner_id,'resume'),'P0001');
 ASSERT public.complete_document_job(first_job.id,2,'replace-B');
 ASSERT public.promote_document_replacement(first_job.id);
 ASSERT (SELECT active_document_id=second_job.document_id FROM public.document_series WHERE id=sid),'historical replay rewound active version';
 ASSERT (SELECT count(*)=3 FROM public.user_documents_vec WHERE document_id IN(old_id,first_job.document_id,second_job.document_id));
 INSERT INTO replacement_receipts VALUES(first_job.id,first_job.document_id,second_job.id,second_job.document_id,sid);
 PERFORM pg_temp.expect_error(format('DELETE FROM public.user_documents WHERE id=%L',old_id),'23503');
END $$;
RESET ROLE;
DO $$ BEGIN
 ASSERT NOT has_function_privilege('authenticated','public.reserve_document_replacement(uuid,uuid,text,text)','EXECUTE');
 ASSERT NOT has_function_privilege('authenticated','public.promote_document_replacement(uuid)','EXECUTE');
 ASSERT NOT has_table_privilege('anon','public.document_series','SELECT');
 ASSERT NOT has_table_privilege('authenticated','public.document_series','UPDATE');
 ASSERT (SELECT count(*)=3 FROM pg_class WHERE oid IN('public.document_series'::regclass,'public.document_series_members'::regclass,'public.document_replacement_candidates'::regclass) AND relrowsecurity);
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','fc110000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 ASSERT (SELECT count(*)=0 FROM public.document_series);
 ASSERT (SELECT count(*)=0 FROM public.document_series_members);
 ASSERT (SELECT count(*)=0 FROM public.document_replacement_candidates);
END $$;
SELECT set_config('request.jwt.claim.sub','fc110000-0000-4000-8000-000000000001',true);
DO $$ DECLARE rows integer; old_id uuid:='fc220000-0000-4000-8000-000000000001'; vec extensions.vector(1024):=('['||array_to_string(array_fill(0.1::real,ARRAY[1024]),',')||']')::extensions.vector(1024); BEGIN
 ASSERT (SELECT count(*)=1 FROM public.document_series);
 ASSERT (SELECT count(*)=4 FROM public.document_series_members);
 SELECT count(*) INTO rows FROM public.match_documents(vec,10,'fc110000-0000-4000-8000-000000000001',ARRAY[old_id,(SELECT first_document FROM replacement_receipts),(SELECT second_document FROM replacement_receipts)],0.3);
 ASSERT rows=1,'retrieval included superseded versions';
 ASSERT (SELECT text_content='Replacement version three' FROM public.match_documents(vec,10,'fc110000-0000-4000-8000-000000000001',ARRAY[old_id,(SELECT first_document FROM replacement_receipts),(SELECT second_document FROM replacement_receipts)],0.3));
 ASSERT (SELECT title='original.pdf' FROM public.user_documents WHERE id=old_id),'old citation identity lost';
END $$;
-- The isolated SQL fixture emulates the Storage API's transaction flag. This
-- never touches a linked Storage service or removes any physical object bytes.
SET LOCAL storage.allow_delete_query = 'true';
DO $$ DECLARE changed integer; BEGIN
 UPDATE public.user_documents SET title='rewritten.pdf',file_path='fc110000-0000-4000-8000-000000000001/changed.pdf' WHERE id='fc220000-0000-4000-8000-000000000001';
 GET DIAGNOSTICS changed=ROW_COUNT; ASSERT changed=0,'client changed historical citation identity';
 DELETE FROM storage.objects WHERE bucket_id='userfiles' AND name='fc110000-0000-4000-8000-000000000001/fc330000-0000-4000-8000-000000000001.pdf';
 GET DIAGNOSTICS changed=ROW_COUNT; ASSERT changed=0,'direct Storage delete removed historical version';
 UPDATE storage.objects SET metadata='{"size":1}' WHERE bucket_id='userfiles' AND name='fc110000-0000-4000-8000-000000000001/fc330000-0000-4000-8000-000000000001.pdf';
 GET DIAGNOSTICS changed=ROW_COUNT; ASSERT changed=0,'direct Storage update modified historical source';
 DELETE FROM storage.objects WHERE bucket_id='userfiles' AND name='fc110000-0000-4000-8000-000000000001/unversioned-control.pdf';
 GET DIAGNOSTICS changed=ROW_COUNT; ASSERT changed=1,'unversioned Storage deletion changed';
END $$;
RESET ROLE;
SELECT 'PASS immutable replacement: original identity/vectors retained, failed candidate safety, atomic current-version promotion, historical replay, active-only retrieval, deletion restriction and owner RLS' result;
