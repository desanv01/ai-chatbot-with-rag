-- Preserve Auth-admin execution for signup before removing unnecessary client grants.
-- Limit this change to the trigger function ACL; retain its body, trigger and other grants.
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
