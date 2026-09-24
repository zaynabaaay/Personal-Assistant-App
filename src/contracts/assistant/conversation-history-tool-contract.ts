import type {
  AssistantToolCall,
  AssistantToolContract,
  AssistantToolOutput,
} from './tool-contract';

export const ASSISTANT_CONVERSATION_HISTORY_TOOL_NAMES = [
  'search_completed_conversations',
] as const;

export type AssistantConversationHistoryToolName =
  (typeof ASSISTANT_CONVERSATION_HISTORY_TOOL_NAMES)[number];

export type SearchCompletedConversationsArguments = {
  preferredRole: 'assistant' | 'both' | 'user';
  query: string;
  recencyBias: 'neutral' | 'recent';
};

export type AssistantConversationHistoryEvidenceMessage = {
  content: string;
  occurredAt: string;
  role: 'user' | 'assistant';
};

export type AssistantConversationHistoryMatch = {
  completedAt: string;
  conversationId: string;
  messages: AssistantConversationHistoryEvidenceMessage[];
  relevance: number;
};

export type AssistantConversationHistoryToolResult =
  | {
      matches: AssistantConversationHistoryMatch[];
      status: 'success';
      truncated: boolean;
    }
  | { message: string; status: 'error' };

export type AssistantConversationHistoryToolCall = AssistantToolCall<
  AssistantConversationHistoryToolName,
  'server',
  SearchCompletedConversationsArguments
>;

export type AssistantConversationHistoryToolOutput = AssistantToolOutput<
  AssistantConversationHistoryToolName,
  'server',
  AssistantConversationHistoryToolResult
>;

const MAX_QUERY_CHARACTERS = 500;
const MAX_MATCHES = 4;
const MAX_MESSAGES_PER_MATCH = 16;
const MAX_EVIDENCE_MESSAGES = 16;
const MAX_EXCERPT_CHARACTERS = 600;
const MAX_RESULT_CHARACTERS = 18_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isEvidenceMessage(value: unknown): value is AssistantConversationHistoryEvidenceMessage {
  return isObject(value) &&
    hasOnlyKeys(value, ['content', 'occurredAt', 'role']) &&
    isBoundedString(value.content, MAX_EXCERPT_CHARACTERS) &&
    isBoundedString(value.occurredAt, 100) &&
    (value.role === 'user' || value.role === 'assistant');
}

function isMatch(value: unknown): value is AssistantConversationHistoryMatch {
  return isObject(value) &&
    hasOnlyKeys(value, ['completedAt', 'conversationId', 'messages', 'relevance']) &&
    isBoundedString(value.completedAt, 100) &&
    isBoundedString(value.conversationId, 200) &&
    typeof value.relevance === 'number' && Number.isFinite(value.relevance) &&
    Array.isArray(value.messages) && value.messages.length > 0 &&
    value.messages.length <= MAX_MESSAGES_PER_MATCH &&
    value.messages.every(isEvidenceMessage);
}

function isArguments(value: unknown): value is SearchCompletedConversationsArguments {
  return isObject(value) &&
    hasOnlyKeys(value, ['preferredRole', 'query', 'recencyBias']) &&
    isBoundedString(value.query, MAX_QUERY_CHARACTERS) &&
    (value.preferredRole === 'assistant' || value.preferredRole === 'both' ||
      value.preferredRole === 'user') &&
    (value.recencyBias === 'neutral' || value.recencyBias === 'recent');
}

function isResult(value: unknown): value is AssistantConversationHistoryToolResult {
  if (!isObject(value)) return false;

  if (value.status === 'error') {
    return hasOnlyKeys(value, ['message', 'status']) &&
      isBoundedString(value.message, 200);
  }

  if (value.status !== 'success' ||
      !hasOnlyKeys(value, ['matches', 'status', 'truncated']) ||
      !Array.isArray(value.matches) || value.matches.length > MAX_MATCHES ||
      !value.matches.every(isMatch) || typeof value.truncated !== 'boolean') {
    return false;
  }

  if (value.matches.reduce((total, match) => total + match.messages.length, 0) >
      MAX_EVIDENCE_MESSAGES) return false;

  try {
    return JSON.stringify(value).length <= MAX_RESULT_CHARACTERS;
  } catch {
    return false;
  }
}

export const ASSISTANT_CONVERSATION_HISTORY_TOOL_CONTRACTS: readonly AssistantToolContract<
  AssistantConversationHistoryToolName,
  'server',
  SearchCompletedConversationsArguments,
  AssistantConversationHistoryToolResult
>[] = [{
  execution: 'server',
  isArguments,
  isResult,
  name: 'search_completed_conversations',
  openAI: {
    description: 'Search the authenticated user’s completed conversations, then automatically retrieve bounded answer-bearing evidence from across the best matching conversations. Use when the user asks what they or Tina previously said, suggested, discussed, decided, named, planned, had, or came up with, including paraphrases and statements such as “we talked about this before.” For a direct personal-recall question, call this automatically after general memory returns no useful result; do not wait for another user cue. Set preferredRole to user for what the user said or had, assistant for what Tina suggested or gave, and both for a joint discussion. Use recent recency bias only when the wording implies likely current or temporary state. Do not use this fallback for ordinary factual or non-personal questions, current present-context questions, current authoritative Project state, or casual sharing. Results are read-only historical evidence, not current Project truth. Answer only from returned evidence; never invent missing details.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_QUERY_CHARACTERS,
          description: 'A concise semantic description of the prior topic to recall, preserving distinctive names and concepts.',
        },
        preferredRole: {
          type: 'string',
          enum: ['user', 'assistant', 'both'],
          description: 'Whose prior words are the requested evidence: the user, Tina, or both participants.',
        },
        recencyBias: {
          type: 'string',
          enum: ['neutral', 'recent'],
          description: 'Use recent only when the request implies changing or temporary state; otherwise use neutral relevance-first ranking.',
        },
      },
      required: ['preferredRole', 'query', 'recencyBias'],
      additionalProperties: false,
    },
    strict: true,
    type: 'function',
  },
}];
