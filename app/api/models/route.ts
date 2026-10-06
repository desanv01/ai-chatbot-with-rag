import { NextResponse } from 'next/server';
import { getProviderAvailability } from '@/lib/server/provider-availability';

export const dynamic = 'force-dynamic';

/** Returns configured models without calling providers or exposing secrets. */
export async function GET() {
  const { defaultModel, googleFreeOnly, providers, models, webSearch } =
    getProviderAvailability();

  return NextResponse.json({
    defaultModel,
    googleFreeOnly,
    providers,
    models,
    webSearchConfigured: webSearch
  });
}
