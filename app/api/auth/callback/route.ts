import { type EmailOtpType } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSafeRedirectPath } from '@/lib/auth-redirect';
import { createServerSupabaseClient } from '@/lib/server/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash_searchParam = searchParams.get('token_hash');
  const code = searchParams.get('code');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = getSafeRedirectPath(searchParams.get('next'), '/');
  let redirectTo = new URL(next, request.url);

  const token_hash = code ?? token_hash_searchParam;

  if (token_hash && type) {
    const supabase = await createServerSupabaseClient();

    const { data } = await supabase.auth.verifyOtp({
      type,
      token_hash
    });

    if (data) {
      redirectTo.searchParams.set('message', 'You can now sign in.');
    } else {
      // Instead of redirecting to error page, go to root with error message
      redirectTo = new URL('/', request.url);
      redirectTo.searchParams.set(
        'error',
        'Authentication failed. Please try again.'
      );
    }
  } else {
    // No valid token or type, go to root with error message
    redirectTo = new URL('/', request.url);
    redirectTo.searchParams.set(
      'error',
      'Invalid authentication attempt. Please try again.'
    );
  }

  return NextResponse.redirect(redirectTo);
}
