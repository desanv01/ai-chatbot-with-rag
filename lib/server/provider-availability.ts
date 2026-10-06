import { CHAT_MODEL_OPTIONS } from '@/lib/model-config';

/** Configuration presence only; this does not verify credentials or provider health. */
export function getProviderAvailability() {
  const providers = {
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    google: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim())
  };
  const googleFreeOnly =
    (process.env.GOOGLE_FREE_TIER_ONLY ?? '').trim().toLowerCase() === 'true';
  const models = CHAT_MODEL_OPTIONS.filter(
    (model) =>
      providers[model.provider] &&
      !(googleFreeOnly && model.provider === 'google' && model.tier === 'pro')
  );

  return {
    providers,
    googleFreeOnly,
    models,
    defaultModel: models[0]?.value ?? null,
    webSearch: Boolean(process.env.EXA_API_KEY?.trim()) && providers.google
  };
}
