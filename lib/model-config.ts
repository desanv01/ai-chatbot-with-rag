export const DEFAULT_CHAT_MODEL = 'gpt-5' as const;

export const CHAT_MODEL_VALUES = [
  'gpt-5',
  'gpt-5-mini',
  'o3',
  'claude-4-sonnet',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-preview-09-2025'
] as const;

export type ChatModelValue = (typeof CHAT_MODEL_VALUES)[number];

export type ChatModelProvider = 'openai' | 'anthropic' | 'google';
export type ChatModelTier = 'free' | 'pro';

export type ChatModelOption = {
  value: ChatModelValue;
  label: string;
  provider: ChatModelProvider;
  tier: ChatModelTier;
};

export const CHAT_MODEL_OPTIONS: readonly ChatModelOption[] = [
  { value: 'gpt-5', label: 'GPT-5', provider: 'openai', tier: 'pro' },
  {
    value: 'gpt-5-mini',
    label: 'GPT-5 Mini',
    provider: 'openai',
    tier: 'free'
  },
  { value: 'o3', label: 'OpenAI O3', provider: 'openai', tier: 'pro' },
  {
    value: 'claude-4-sonnet',
    label: 'Claude 4.5 Sonnet',
    provider: 'anthropic',
    tier: 'pro'
  },
  {
    value: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (Preview)',
    provider: 'google',
    tier: 'free'
  },
  {
    value: 'gemini-2.5-flash-preview-09-2025',
    label: 'Gemini 2.5 Flash (Preview)',
    provider: 'google',
    tier: 'free'
  },
  {
    value: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro (Preview)',
    provider: 'google',
    tier: 'pro'
  }
];

const GOOGLE_MODEL_ALIASES: Record<string, ChatModelValue> = {
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
  'gemini-2.5-flash-preview-09-2025': 'gemini-2.5-flash-preview-09-2025',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-2.5-flash': 'gemini-2.5-flash-preview-09-2025',
  'gemini 3 flash': 'gemini-3-flash-preview',
  'gemini 3 pro': 'gemini-3-pro-preview',
  'gemini 2.5 flash': 'gemini-2.5-flash-preview-09-2025'
};

const GOOGLE_MODEL_VALUES = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-preview-09-2025'
] as const satisfies readonly ChatModelValue[];

const GOOGLE_FREE_MODEL_VALUES = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash-preview-09-2025'
] as const satisfies readonly ChatModelValue[];

export function normalizeGoogleModelId(value: unknown): string {
  if (typeof value !== 'string') return '';

  const raw = value.trim();
  return GOOGLE_MODEL_ALIASES[raw.toLowerCase()] ?? raw;
}

export function isChatModelValue(value: unknown): value is ChatModelValue {
  return (
    typeof value === 'string' &&
    (CHAT_MODEL_VALUES as readonly string[]).includes(value)
  );
}

export function sanitizeChatModel(value: unknown): ChatModelValue {
  const normalized = normalizeGoogleModelId(value);
  return isChatModelValue(normalized) ? normalized : DEFAULT_CHAT_MODEL;
}

export function isGoogleChatModel(
  value: string
): value is (typeof GOOGLE_MODEL_VALUES)[number] {
  return (GOOGLE_MODEL_VALUES as readonly string[]).includes(value);
}

export function isGoogleFreeChatModel(
  value: string
): value is (typeof GOOGLE_FREE_MODEL_VALUES)[number] {
  return (GOOGLE_FREE_MODEL_VALUES as readonly string[]).includes(value);
}
