import type { ActiveConversation } from '../../domain/conversations';

const MAX_TITLE_WORDS = 6;
const LEADING_REQUEST = /^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+|please\s+|(?:i\s+)?(?:want|need)\s+to\s+|help\s+me\s+(?:with|to\s+)?|let(?:'|’)s\s+|tell\s+me\s+(?:about\s+)?|remember\s+(?:that\s+)?)/i;
const TRAILING_FILLER = /\b(?:for\s+me|please|today|right\s+now)\s*$/i;
const TITLE_WORD = /[\p{L}\p{N}][\p{L}\p{N}'’&-]*/gu;
const LOWERCASE_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

function titleCase(words: string[]) {
  return words.map((word, index) => {
    const lower = word.toLocaleLowerCase();
    if (index > 0 && LOWERCASE_WORDS.has(lower)) return lower;
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  }).join(' ');
}

function wordsFrom(value: string) {
  return value.match(TITLE_WORD) ?? [];
}

function cleanTopic(value: string) {
  return value
    .replace(LEADING_REQUEST, '')
    .replace(LEADING_REQUEST, '')
    .replace(/^(?:give|show)\s+me\s+/i, '')
    .replace(TRAILING_FILLER, '')
    .replace(/^(?:that|about|some|my|our)\s+/i, '')
    .replace(/\b(?:what\s+do\s+you\s+think|do\s+you\s+agree)\b.*$/i, '')
    .trim();
}

function readableCandidate(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (/^(?:(?:hi|hello|hey)(?:\s+tina)?|thanks|thank\s+you|yes|no)[.!? ]*$/i.test(normalized)) {
    return null;
  }
  const preference = normalized.match(/\b(?:i\s+)?(?:really\s+)?(?:prefer|like|love)\s+(.+)/i);
  const topic = cleanTopic(preference?.[1] ?? normalized);
  let words = wordsFrom(topic).slice(0, preference ? MAX_TITLE_WORDS - 1 : MAX_TITLE_WORDS);

  if (words.length === 0) return null;
  if (words.length === 1 && !preference) words = [...words, 'Chat'];
  if (preference && !words.some((word) => /^preference$/i.test(word))) {
    words.push('Preference');
  }

  return titleCase(words);
}

export function generateReadableConversationTitle(
  conversation: Pick<ActiveConversation, 'messages'>,
) {
  const userMessages = conversation.messages.filter((message) => message.role === 'user');
  for (const message of userMessages) {
    const title = readableCandidate(message.content);
    if (title) return title;
  }
  return 'Saved Chat';
}

export function normalizeGeneratedConversationTitle(
  value: string,
  conversation: Pick<ActiveConversation, 'messages'>,
) {
  const words = wordsFrom(value.trim());
  const looksGeneric = /^(?:conversation|chat)(?:\s*[—-]|$)/i.test(value.trim());
  const containsTimestamp = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/.test(value);
  if (words.length < 2 || looksGeneric || containsTimestamp) {
    return generateReadableConversationTitle(conversation);
  }
  return titleCase(words.slice(0, MAX_TITLE_WORDS));
}
