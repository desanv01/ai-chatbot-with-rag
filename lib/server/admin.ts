import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { type Database } from '@/types/database';

/**
 * ⚠️ ADMIN CLIENT - DANGER ZONE ⚠️
 *
 * This client uses the service role key which bypasses Row Level Security (RLS).
 * It has FULL ACCESS to your database without any security restrictions.
 *
 * SECURITY RULES:
 * - NEVER expose this client to the browser/client-side
 * - ONLY use in server-side components/functions
 * - NEVER prefix the service role key with NEXT_PUBLIC_
 * - Keep all admin operations strictly server-side
 *
 * Proper usage:
 * - Server Components
 * - API Routes
 * - Server Actions
 * - Background jobs
 * - Database migrations
 *
 * @returns Supabase Admin Client with service role privileges
 */
export const createAdminClient = (options?: { requestTimeoutMs?: number }) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // ⚠️ Never expose this!

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      'Missing Supabase environment variables for server-side operations'
    );
  }

  const requestTimeoutMs = options?.requestTimeoutMs;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 60_000)
  ) {
    throw new Error('Invalid server request timeout');
  }
  return createSupabaseClient<Database>(
    supabaseUrl,
    supabaseServiceKey,
    requestTimeoutMs === undefined
      ? undefined
      : {
          global: {
            fetch: (input, init) => {
              const timeout = AbortSignal.timeout(requestTimeoutMs);
              const signal = init?.signal
                ? AbortSignal.any([init.signal, timeout])
                : timeout;
              return fetch(input, { ...init, signal });
            }
          }
        }
  );
};
