


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
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


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "match_count" integer, "filter_user_id" "uuid", "file_ids" "uuid"[], "similarity_threshold" double precision DEFAULT 0.30) RETURNS TABLE("id" "uuid", "text_content" "text", "title" "text", "doc_timestamp" timestamp with time zone, "ai_title" "text", "ai_description" "text", "ai_maintopics" "text"[], "ai_keyentities" "text"[], "page_number" integer, "total_pages" integer, "similarity" double precision)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    vec.id,
    vec.text_content,
    doc.title,
    doc.created_at as doc_timestamp,
    doc.ai_title,
    doc.ai_description,
    doc.ai_maintopics,
    doc.ai_keyentities,
    vec.page_number,
    doc.total_pages,
    1 - (vec.embedding <=> query_embedding) as similarity
  FROM
    user_documents_vec vec
  INNER JOIN
    user_documents doc ON vec.document_id = doc.id
  WHERE
    doc.user_id = filter_user_id
    AND doc.id = ANY(file_ids)
    AND 1 - (vec.embedding <=> query_embedding) > similarity_threshold
  ORDER BY
    vec.embedding <=> query_embedding ASC
  LIMIT LEAST(match_count, 200);
END;
$$;


ALTER FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "match_count" integer, "filter_user_id" "uuid", "file_ids" "uuid"[], "similarity_threshold" double precision) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."chat_sessions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "chat_title" "text"
);


ALTER TABLE "public"."chat_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_parts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chat_session_id" "uuid" NOT NULL,
    "message_id" "text" NOT NULL,
    "role" "text" NOT NULL,
    "type" "text" NOT NULL,
    "order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "text_text" "text",
    "text_state" "text" DEFAULT 'done'::"text",
    "reasoning_text" "text",
    "reasoning_state" "text" DEFAULT 'done'::"text",
    "file_mediatype" "text",
    "file_filename" "text",
    "file_url" "text",
    "source_url_id" "text",
    "source_url_url" "text",
    "source_url_title" "text",
    "source_document_id" "text",
    "source_document_mediatype" "text",
    "source_document_title" "text",
    "source_document_filename" "text",
    "tool_searchuserdocument_toolcallid" "uuid",
    "tool_searchuserdocument_state" "text",
    "tool_searchuserdocument_input" "jsonb",
    "tool_searchuserdocument_output" "jsonb",
    "tool_searchuserdocument_errortext" "text",
    "tool_searchuserdocument_providerexecuted" boolean,
    "tool_searchuserdocument_approval" "jsonb",
    "tool_websitesearchtool_toolcallid" "uuid",
    "tool_websitesearchtool_state" "text",
    "tool_websitesearchtool_input" "jsonb",
    "tool_websitesearchtool_output" "jsonb",
    "tool_websitesearchtool_errortext" "text",
    "tool_websitesearchtool_providerexecuted" boolean,
    "tool_websitesearchtool_approval" "jsonb",
    "providermetadata" "jsonb",
    CONSTRAINT "message_parts_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."message_parts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "stripe_current_period_end" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."subscriptions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."subscriptions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."subscriptions_id_seq" OWNED BY "public"."subscriptions"."id";



CREATE TABLE IF NOT EXISTS "public"."user_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "total_pages" integer NOT NULL,
    "ai_description" "text",
    "ai_keyentities" "text"[],
    "ai_maintopics" "text"[],
    "ai_title" "text",
    "file_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."user_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_documents_vec" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "text_content" "text" NOT NULL,
    "page_number" integer NOT NULL,
    "embedding" "extensions"."vector"(1024)
);


ALTER TABLE "public"."user_documents_vec" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "email" "text",
    "role" "text" DEFAULT 'user'::"text" NOT NULL,
    CONSTRAINT "users_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


ALTER TABLE ONLY "public"."subscriptions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."subscriptions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_parts"
    ADD CONSTRAINT "message_parts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_documents"
    ADD CONSTRAINT "user_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_documents"
    ADD CONSTRAINT "user_documents_user_title_unique" UNIQUE ("user_id", "title");



ALTER TABLE ONLY "public"."user_documents_vec"
    ADD CONSTRAINT "user_documents_vec_document_page_unique" UNIQUE ("document_id", "page_number");



ALTER TABLE ONLY "public"."user_documents_vec"
    ADD CONSTRAINT "user_documents_vec_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE INDEX "chat_sessions_created_at_idx" ON "public"."chat_sessions" USING "btree" ("created_at");



CREATE INDEX "idx_chat_sessions_user_id" ON "public"."chat_sessions" USING "btree" ("user_id");



CREATE INDEX "idx_message_parts_chat_session_id" ON "public"."message_parts" USING "btree" ("chat_session_id");



CREATE INDEX "idx_message_parts_chat_session_message_order" ON "public"."message_parts" USING "btree" ("chat_session_id", "message_id", "order");



CREATE INDEX "idx_message_parts_created_at" ON "public"."message_parts" USING "btree" ("created_at");



CREATE INDEX "idx_message_parts_message_id" ON "public"."message_parts" USING "btree" ("message_id");



CREATE INDEX "idx_message_parts_message_order" ON "public"."message_parts" USING "btree" ("message_id", "order");



CREATE INDEX "idx_message_parts_type" ON "public"."message_parts" USING "btree" ("type");



CREATE INDEX "idx_user_documents_user_id" ON "public"."user_documents" USING "btree" ("user_id");



CREATE INDEX "idx_user_documents_vec_document_id" ON "public"."user_documents_vec" USING "btree" ("document_id");



CREATE UNIQUE INDEX "subscriptions_user_id_unique" ON "public"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "user_documents_vec_embedding_idx" ON "public"."user_documents_vec" USING "hnsw" ("embedding" "extensions"."vector_l2_ops") WITH ("m"='16', "ef_construction"='64');



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_parts"
    ADD CONSTRAINT "message_parts_chat_session_id_fkey" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_documents"
    ADD CONSTRAINT "user_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_documents_vec"
    ADD CONSTRAINT "user_documents_vec_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."user_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



CREATE POLICY "Users can insert own data" ON "public"."users" FOR INSERT WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Users can only access their own document vectors" ON "public"."user_documents_vec" USING ((EXISTS ( SELECT 1
   FROM "public"."user_documents"
  WHERE (("user_documents"."id" = "user_documents_vec"."document_id") AND ("user_documents"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Users can only access their own documents" ON "public"."user_documents" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can update own data" ON "public"."users" FOR UPDATE USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Users can view messages from their sessions" ON "public"."message_parts" USING (("chat_session_id" IN ( SELECT "chat_sessions"."id"
   FROM "public"."chat_sessions"
  WHERE ("chat_sessions"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can view own chat sessions" ON "public"."chat_sessions" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Users can view own data" ON "public"."users" FOR SELECT USING (("id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."chat_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_parts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_documents_vec" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users can read own profile" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";















































































































































































































































































































































































































































































































GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";

































GRANT ALL ON TABLE "public"."chat_sessions" TO "anon";
GRANT ALL ON TABLE "public"."chat_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."message_parts" TO "anon";
GRANT ALL ON TABLE "public"."message_parts" TO "authenticated";
GRANT ALL ON TABLE "public"."message_parts" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."subscriptions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."subscriptions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."subscriptions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_documents" TO "anon";
GRANT ALL ON TABLE "public"."user_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."user_documents" TO "service_role";



GRANT ALL ON TABLE "public"."user_documents_vec" TO "anon";
GRANT ALL ON TABLE "public"."user_documents_vec" TO "authenticated";
GRANT ALL ON TABLE "public"."user_documents_vec" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


  create policy "User can delete own files"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'userfiles'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "User can insert own files"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'userfiles'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "User can select own files"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'userfiles'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "User can update own files"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'userfiles'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



