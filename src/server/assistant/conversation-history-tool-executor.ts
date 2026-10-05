import type {
  AssistantConversationHistoryMatch,
  AssistantConversationHistoryToolCall,
  AssistantConversationHistoryToolOutput,
} from '../../contracts/assistant';
import {
  createServerConversationHistorySearchRepository,
  type ConversationHistorySearchRepository,
} from '../conversations/conversation-history-search-repository';
import type { AssistantServerToolContext } from './server-tool-executor';

const MAXIMUM_CONVERSATIONS = 4;
const MAXIMUM_EVIDENCE_MESSAGES = 16;
const MAXIMUM_EXCERPT_CHARACTERS = 600;
const MAXIMUM_EXPANDED_TERMS = 64;

const STOP_WORDS = new Set([
  'a', 'about', 'again', 'and', 'before', 'came', 'did', 'do', 'for', 'gave',
  'give', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'our', 'said', 'say',
  'that', 'the', 'this', 'to', 'told', 'up', 'was', 'we', 'were', 'what', 'when',
  'with', 'you', 'your',
]);

const RELATED_TERMS: readonly { expansions: readonly string[]; triggers: readonly string[] }[] = [
  {
    expansions: ['workout', 'gym', 'exercise', 'fitness', 'training', 'routine', 'schedule', 'plan'],
    triggers: ['workout', 'gym', 'exercise', 'fitness', 'training'],
  },
  {
    expansions: [
      'recipe', 'meal', 'dish', 'food', 'dinner', 'lunch', 'breakfast', 'cook',
      'cooking', 'ingredient', 'ingredients', 'inventory', 'pantry', 'grocery',
      'groceries', 'produce', 'dairy', 'grain', 'protein', 'canned', 'frozen',
      'vegetable', 'fruit', 'spice', 'rice', 'egg', 'oil', 'cheese', 'tomato',
      'garlic', 'onion', 'bean', 'chickpea', 'lentil', 'cauliflower', 'broccoli',
      'spinach', 'banana', 'milk', 'cream', 'bread', 'potato', 'tuna',
    ],
    triggers: [
      'recipe', 'meal', 'dish', 'food', 'cook', 'cooking', 'ingredient',
      'ingredients', 'inventory', 'pantry', 'grocery', 'groceries',
    ],
  },
  {
    expansions: ['grant', 'funding', 'application', 'proposal', 'award'],
    triggers: ['grant', 'funding', 'proposal'],
  },
  {
    expansions: ['identity', 'brand', 'branding', 'aesthetic', 'style', 'visual', 'look', 'direction'],
    triggers: ['identity', 'brand', 'branding', 'aesthetic'],
  },
  {
    expansions: ['manufacturer', 'supplier', 'factory', 'production', 'vendor', 'sourcing'],
    triggers: ['manufacturer', 'supplier', 'factory', 'vendor', 'sourcing'],
  },
  {
    expansions: ['comic', 'character', 'story', 'illustration', 'graphic', 'novel'],
    triggers: ['comic', 'character', 'illustration'],
  },
  {
    expansions: ['website', 'site', 'web', 'homepage'],
    triggers: ['website', 'site', 'homepage'],
  },
];

function normalizedTokens(value: string) {
  return value.normalize('NFKD').toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((token) => token.length > 1);
}

export function expandConversationHistorySearchQuery(value: string) {
  const originalTokens = normalizedTokens(value);
  const meaningfulTokens = originalTokens.filter((token) => !STOP_WORDS.has(token));
  const terms = new Set((meaningfulTokens.length > 0 ? meaningfulTokens : originalTokens).slice(0, 14));

  for (const group of RELATED_TERMS) {
    if (group.triggers.some((trigger) => terms.has(trigger))) {
      for (const expansion of group.expansions) terms.add(expansion);
    }
  }

  return [...terms].slice(0, MAXIMUM_EXPANDED_TERMS).join(' OR ');
}

type RepositoryFactory = (
  context: AssistantServerToolContext,
) => ConversationHistorySearchRepository;

export function createAssistantConversationHistoryToolExecutor(
  repositoryFactory: RepositoryFactory = createServerConversationHistorySearchRepository,
) {
  return async (
    call: AssistantConversationHistoryToolCall,
    context: AssistantServerToolContext,
  ): Promise<AssistantConversationHistoryToolOutput> => {
    try {
      const expandedQuery = expandConversationHistorySearchQuery(call.arguments.query);
      if (!expandedQuery) {
        return {
          callId: call.callId,
          execution: 'server',
          name: call.name,
          result: { matches: [], status: 'success', truncated: false },
        };
      }

      const repository = repositoryFactory(context);
      const rows = await repository.search(expandedQuery, MAXIMUM_CONVERSATIONS);
      const candidateConversations = [...new Map(rows.map((row) => [
        row.conversationId,
        { completedAt: row.completedAt, relevance: row.relevance },
      ])).entries()].slice(0, MAXIMUM_CONVERSATIONS);

      if (candidateConversations.length === 0) {
        return {
          callId: call.callId,
          execution: 'server',
          name: call.name,
          result: { matches: [], status: 'success', truncated: false },
        };
      }

      const evidenceRows = await repository.searchEvidence(
        candidateConversations.map(([conversationId]) => conversationId),
        expandedQuery,
        call.arguments.preferredRole,
        call.arguments.recencyBias === 'recent',
        MAXIMUM_EVIDENCE_MESSAGES,
      );
      const matchesByConversation = new Map<string, AssistantConversationHistoryMatch>();
      const candidatesById = new Map(candidateConversations);

      for (const row of evidenceRows.slice(0, MAXIMUM_EVIDENCE_MESSAGES)) {
        const candidate = candidatesById.get(row.conversationId);
        if (!candidate) continue;
        let match = matchesByConversation.get(row.conversationId);
        if (!match) {
          match = {
            completedAt: candidate.completedAt,
            conversationId: row.conversationId,
            messages: [],
            relevance: candidate.relevance,
          };
          matchesByConversation.set(row.conversationId, match);
        }
        match.messages.push({
          content: row.content.length <= MAXIMUM_EXCERPT_CHARACTERS
            ? row.content
            : `${row.content.slice(0, MAXIMUM_EXCERPT_CHARACTERS - 1)}…`,
          occurredAt: row.occurredAt,
          role: row.role,
        });
      }

      return {
        callId: call.callId,
        execution: 'server',
        name: call.name,
        result: {
          matches: [...matchesByConversation.values()],
          status: 'success',
          truncated: rows.some((row) => row.truncated) ||
            evidenceRows.some((row) => row.truncated) ||
            evidenceRows.length > MAXIMUM_EVIDENCE_MESSAGES,
        },
      };
    } catch {
      return {
        callId: call.callId,
        execution: 'server',
        name: call.name,
        result: {
          message: 'Prior conversation search is temporarily unavailable.',
          status: 'error',
        },
      };
    }
  };
}

export const executeAssistantConversationHistoryTool =
  createAssistantConversationHistoryToolExecutor();
