import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type ModelOption = {
  value: string;
  label: string;
  provider: 'openai' | 'anthropic' | 'google';
  tier: 'free' | 'pro';
};

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

  // If you want even stricter rules, you can also require billing flags here.
  // For now: freeOnly => hide Pro models.
  const models: ModelOption[] = [];

  // --- OpenAI ---
  if (hasOpenAI) {
    models.push(
      { value: 'gpt-5', label: 'GPT-5', provider: 'openai', tier: 'pro' },
      { value: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'openai', tier: 'free' },
      { value: 'o3', label: 'OpenAI O3', provider: 'openai', tier: 'pro' }
    );
  }

  // --- Anthropic ---
  if (hasAnthropic) {
    models.push({
      value: 'claude-4-sonnet',
      label: 'Claude 4.5 Sonnet',
      provider: 'anthropic',
      tier: 'pro'
    });
  }

  // --- Google Gemini (IMPORTANT: use *preview ids* to avoid v1beta 404) ---
  if (hasGoogle) {
    // Flash is usually the safest for free tier
    models.push({
      value: 'gemini-3-flash-preview',
      label: 'Gemini 3 Flash (Preview)',
      provider: 'google',
      tier: 'free'
    });

    // Optional: keep your 2.5 flash preview if you actually use it
    models.push({
      value: 'gemini-2.5-flash-preview-09-2025',
      label: 'Gemini 2.5 Flash (Preview)',
      provider: 'google',
      tier: 'free'
    });

    // Pro hidden when GOOGLE_FREE_TIER_ONLY=true
    if (!googleFreeOnly) {
      models.push({
        value: 'gemini-3-pro-preview',
        label: 'Gemini 3 Pro (Preview)',
        provider: 'google',
        tier: 'pro'
      });
    }
  }

  // Choose default model (first available, else gpt-5 for UI stability)
  const defaultModel = models[0]?.value ?? 'gpt-5';

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
