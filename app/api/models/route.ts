import { NextResponse } from 'next/server';
import {
  CHAT_MODEL_OPTIONS,
  DEFAULT_CHAT_MODEL,
  type ChatModelOption
} from '@/lib/model-config';

export const dynamic = 'force-dynamic';

function envTrue(v: string | undefined) {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * This endpoint returns which models should be visible in the UI.
 * It only checks "presence" of keys and flags, never exposes secrets.
 */
export async function GET() {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGoogle = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

  const googleFreeOnly = envTrue(process.env.GOOGLE_FREE_TIER_ONLY);

  const models: ChatModelOption[] = CHAT_MODEL_OPTIONS.filter((model) => {
    const providerEnabled =
      model.provider === 'openai'
        ? hasOpenAI
        : model.provider === 'anthropic'
          ? hasAnthropic
          : hasGoogle;

    return (
      providerEnabled &&
      !(googleFreeOnly && model.provider === 'google' && model.tier === 'pro')
    );
  });

  // Choose the first configured model, else the shared stable fallback.
  const defaultModel = models[0]?.value ?? DEFAULT_CHAT_MODEL;

  return NextResponse.json({
    defaultModel,
    googleFreeOnly,
    providers: {
      openai: hasOpenAI,
      anthropic: hasAnthropic,
      google: hasGoogle
    },
    models
  });
}
