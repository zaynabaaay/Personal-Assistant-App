import type { ActiveConversation } from '../../domain/conversations';

const MAX_CONTEXT_CHARACTERS = 2_400;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_TITLE_WORDS = 5;
const TITLE_WORD = /[\p{L}\p{N}][\p{L}\p{N}'’&-]*/gu;
const LOWERCASE_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const MEANINGLESS_MESSAGE = /^(?:(?:hi|hello|hey)(?:\s+tina)?|thanks|thank\s+you|yes|no|okay|ok|sure|great|sounds good|that sounds good)[.!? ]*$/i;
const REJECTION_ONLY = /^(?:no[, ]|not\s+|i\s+(?:do\s+not|don't|did\s+not|didn't)\b)/i;
const TRUNCATED_ENDING = /\b(?:a|an|and|about|at|do|did|for|from|i|in|my|of|on|or|our|the|to|with)$/i;
const QUESTION_START = /^(?:what|how|do|does|did|can|could|would|should|where|when|why|who|is|are|was|were)\b/i;

type TitleCandidate = {
  phrase: string;
  score: number;
  sourceIndex: number;
};

function titleCase(words: string[]) {
  return words.map((word, index) => {
    const lower = word.toLocaleLowerCase();
    if (index > 0 && LOWERCASE_WORDS.has(lower)) return lower;
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  }).join(' ');
}

function wordsFrom(value: string): string[] {
  return [...(value.match(TITLE_WORD) ?? [])];
}

function normalizeContent(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function meaningfulUserContent(value: string) {
  const normalized = normalizeContent(value);
  return normalized.length >= 2 && !MEANINGLESS_MESSAGE.test(normalized) &&
    !REJECTION_ONLY.test(normalized);
}

export function selectTitleUserMessages(
  conversation: Pick<ActiveConversation, 'messages'>,
) {
  const meaningful = conversation.messages
    .filter((message) => message.role === 'user' && meaningfulUserContent(message.content))
    .map((message) => normalizeContent(message.content));
  const selected = meaningful.length <= MAX_CONTEXT_MESSAGES
    ? meaningful
    : [...meaningful.slice(0, 2), ...meaningful.slice(-(MAX_CONTEXT_MESSAGES - 2))];

  let remaining = MAX_CONTEXT_CHARACTERS;
  return selected.flatMap((content) => {
    if (remaining <= 0) return [];
    const bounded = content.slice(0, Math.min(remaining, 400)).trim();
    remaining -= bounded.length;
    return bounded ? [bounded] : [];
  });
}

function cleanPhrase(value: string) {
  return value
    .replace(/[?!.,;:]+$/g, '')
    .replace(/^(?:that|about|some|my|our|the|a|an)\s+/i, '')
    .replace(/\s+(?:would|could|should)\s+(?:be|look|work|feel|sound)\b.*$/i, '')
    .replace(/\s+(?:because|although)\b.*$/i, '')
    .replace(/\b(?:what\s+do\s+you\s+think|do\s+you\s+agree)\b.*$/i, '')
    .trim();
}

function formatPhrase(value: string, category?: 'Chat' | 'Decision' | 'Plan' | 'Preference' | 'Preferences') {
  const cleaned = cleanPhrase(value);
  let words = wordsFrom(cleaned);
  while (/^(?:i|me|my|the|a|an|that|this)$/i.test(words[0] ?? '')) words.shift();
  while (/^(?:please|today|now)$/i.test(words[words.length - 1] ?? '')) words.pop();
  if (category && !words.some((word) => word.toLocaleLowerCase() === category.toLocaleLowerCase())) {
    words.push(category);
  }
  if (words.length === 1 && !category) words.push('Chat');
  if (words.length < 2 || words.length > MAX_TITLE_WORDS) return null;

  const title = titleCase(words);
  return isPoorConversationTitle(title) ? null : title;
}

function decisionCategory(value: string): 'Decision' | undefined {
  return /\b(?:corner|layout|placement|option)\b/i.test(value) ? 'Decision' : undefined;
}

function questionCandidate(content: string, sourceIndex: number): TitleCandidate | null {
  let match = content.match(/^what\s+(?:colour|color)\s+(.+?)\s+do\s+i\s+(?:want|like|prefer|have|choose)\b/i);
  if (match) return { phrase: formatPhrase(`${match[1]} Colour`) ?? '', score: 84, sourceIndex };

  match = content.match(/^what\s+did\s+i\s+decide(?:\s+(?:for|about|on))?\s+(?:the\s+)?(.+?)[?!.]*$/i);
  if (match?.[1] && !TRUNCATED_ENDING.test(match[1])) {
    return { phrase: formatPhrase(match[1], decisionCategory(match[1])) ?? '', score: 78, sourceIndex };
  }

  match = content.match(/^what\s+did\s+i\s+say\s+about\s+(?:the\s+|my\s+)?(.+?)[?!.]*$/i);
  if (match) return { phrase: formatPhrase(match[1], 'Chat') ?? '', score: 52, sourceIndex };

  match = content.match(/^how\s+do\s+i\s+like\s+(?:the\s+|my\s+)?(.+?)[?!.]*$/i);
  if (match) return { phrase: formatPhrase(match[1], 'Preferences') ?? '', score: 82, sourceIndex };

  match = content.match(/^do\s+i\s+(?:keep|leave|have|want|like|prefer|use|put)\s+(?:the\s+|my\s+)?(.+?)[?!.]*$/i);
  if (match) return { phrase: formatPhrase(match[1]) ?? '', score: 83, sourceIndex };

  match = content.match(/^what\s+kind\s+of\s+(.+?)\s+do\s+i\s+(?:want|like|prefer|have|choose)\b/i);
  if (match) return { phrase: formatPhrase(match[1], 'Preferences') ?? '', score: 65, sourceIndex };

  match = content.match(/^(?:what|how)\b.*?\babout\s+(?:the\s+|my\s+)?(.+?)[?!.]*$/i);
  if (match) return { phrase: formatPhrase(match[1], 'Chat') ?? '', score: 42, sourceIndex };
  return null;
}

function statementCandidate(content: string, sourceIndex: number): TitleCandidate | null {
  let match = content.match(/^i\s+(?:have\s+)?(?:decided|chose|choose)\s+(?:on\s+|for\s+|that\s+|to\s+)?(.+)/i);
  if (match) return {
    phrase: formatPhrase(match[1], decisionCategory(match[1])) ?? '',
    score: 104,
    sourceIndex,
  };

  match = content.match(/^i\s+think\s+(.+?)(?:\s+(?:would|could|should)\b|[?!.]*$)/i);
  if (match) return { phrase: formatPhrase(match[1]) ?? '', score: 100, sourceIndex };

  match = content.match(/^i\s+(?:really\s+)?(?:prefer|like|love|want)\s+(.+)/i);
  if (match) {
    const phrase = formatPhrase(match[1]);
    const fallback = phrase ?? formatPhrase(match[1], 'Preference');
    return { phrase: fallback ?? '', score: 98, sourceIndex };
  }

  match = content.match(/^i\s+(?:keep|leave|have|use|put)\s+(?:the\s+|my\s+)?(.+)/i);
  if (match) return { phrase: formatPhrase(match[1]) ?? '', score: 92, sourceIndex };

  match = content.match(/^(?:let(?:'|’)s|we\s+(?:will|should|can))\s+(?:use|choose|make|put|keep)\s+(.+)/i);
  if (match) return { phrase: formatPhrase(match[1]) ?? '', score: 96, sourceIndex };
  return null;
}

function requestCandidate(content: string, sourceIndex: number): TitleCandidate | null {
  let match = content.match(/^(?:please\s+)?help\s+me\s+plan\s+(?:the\s+|my\s+)?(.+)/i);
  if (match) return { phrase: formatPhrase(match[1], 'Plan') ?? '', score: 80, sourceIndex };

  match = content.match(/^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+)?(?:give|show)\s+me\s+(.+)/i);
  if (match) return { phrase: formatPhrase(match[1]) ?? '', score: 76, sourceIndex };
  return null;
}

function broadPreferenceConversation(contents: string[]) {
  if (contents.some((content) => /\beveryday preferences?\b/i.test(content))) return true;
  return contents.filter((content) =>
    /^i\s+(?:really\s+)?(?:prefer|like|love|want)\b/i.test(content)
  ).length >= 3;
}

export function isPoorConversationTitle(value: string) {
  const title = normalizeContent(value);
  const words = wordsFrom(title);
  return !title || words.length < 2 || words.length > 6 || title.includes('?') ||
    /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/.test(title) ||
    /^(?:conversation|saved chat|chat|untitled)(?:\s*[—-]|$)/i.test(title) ||
    QUESTION_START.test(title) || /\b(?:do|does|did|can|could|would|should)\s+i\b/i.test(title) ||
    TRUNCATED_ENDING.test(title);
}

export function generateReadableConversationTitle(
  conversation: Pick<ActiveConversation, 'messages'>,
) {
  const contents = selectTitleUserMessages(conversation);
  if (contents.length === 0) return 'Saved Chat';
  if (broadPreferenceConversation(contents)) return 'Everyday Preferences';

  const candidates = contents.flatMap((content, sourceIndex) => {
    const statement = statementCandidate(content, sourceIndex);
    const question = questionCandidate(content, sourceIndex);
    const request = requestCandidate(content, sourceIndex);
    return [statement, question, request].filter((candidate): candidate is TitleCandidate =>
      Boolean(candidate?.phrase)
    );
  }).sort((left, right) => right.score - left.score || right.sourceIndex - left.sourceIndex);

  if (candidates[0]) return candidates[0].phrase;

  const fallbackTopic = contents.map((content) => content
    .replace(/^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+|please\s+|help\s+me\s+(?:with|to\s+)?|tell\s+me\s+(?:about\s+)?|remember\s+(?:that\s+)?)/i, '')
    .replace(/^(?:what|how|do|does|did|why|where|when)\b.*?\b(?:about|for|on)\s+/i, '')
  ).map((content) => formatPhrase(content, 'Chat')).find(Boolean);
  return fallbackTopic ?? 'Saved Chat';
}

export function normalizeGeneratedConversationTitle(
  value: string,
  conversation: Pick<ActiveConversation, 'messages'>,
) {
  if (isPoorConversationTitle(value)) return generateReadableConversationTitle(conversation);
  const words = wordsFrom(value.trim());
  if (words.length > MAX_TITLE_WORDS) return generateReadableConversationTitle(conversation);
  return titleCase(words);
}
