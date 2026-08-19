import 'server-only';
import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/server/server';

// React Cache: https://react.dev/reference/react/cache
//This memoizes/dedupes the request
// if it is called multiple times in the same request.
export const getSession = cache(async () => {
  const supabase = await createServerSupabaseClient();
  try {
    const { data } = await supabase.auth.getClaims();
    const user = data?.claims;
    return user;
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
});

//This memoizes/dedupes the request
// if it is called multiple times in the same request.
export const getUserInfo = cache(async () => {
  const supabase = await createServerSupabaseClient();
  try {
    const { data, error } = await supabase
      .from('users')
      .select('full_name, email, id')
      .maybeSingle(); // MaybeSingle returns null if no data is found. single() returns an error if no data is found.

    if (error) {
      console.error('Supabase Error:', error);
      return null;
    }

    if (!data) return null;

    // The database permits a missing display name or email. Keep the UI
    // components' string contract stable by normalizing nullable values here.
    return {
      ...data,
      full_name: data.full_name ?? '',
      email: data.email ?? ''
    };
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
});
