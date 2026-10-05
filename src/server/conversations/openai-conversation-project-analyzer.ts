import type {
  ConversationProjectCandidate,
  ConversationWithMessages,
} from '../../domain/conversations';
import type { Project } from '../../domain/projects';
import type {
  ConversationProjectAnalyzer,
  ProjectConversationReconciliation,
  ProjectSegmentMatch,
} from '../../services/conversations/conversation-project-analyzer';

type OpenAIResponse = {
  error?: { message?: unknown };
  output?: { content?: { text?: unknown; type?: unknown }[]; type?: unknown }[];
};

type AnalyzerOptions = {
  apiKey: string;
  fetchImplementation?: typeof fetch;
  model?: string;
};

const DEFAULT_MODEL = 'gpt-5.4-mini';
const MAX_ANALYZER_INPUT_CHARACTERS = 120_000;
const CLASSIFICATIONS = [
  'new', 'already_known', 'clear_update', 'confirmed_decision',
  'unresolved_question', 'brainstorming', 'ambiguous',
] as const;
const TARGETS = ['knowledge', 'decision', 'task'] as const;
const KNOWLEDGE_KINDS = ['fact', 'requirement', 'constraint', 'note', 'question'] as const;

const MATCH_SCHEMA = {
  additionalProperties: false,
  properties: {
    matches: {
      items: {
        additionalProperties: false,
        properties: {
          confidence: { enum: ['high', 'medium', 'low'], type: 'string' },
          projectId: { type: 'string' },
          relevantMessageIds: { items: { type: 'string' }, type: 'array' },
        },
        required: ['confidence', 'projectId', 'relevantMessageIds'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['matches'],
  type: 'object',
} as const;

const RECONCILIATION_SCHEMA = {
  additionalProperties: false,
  properties: {
    candidates: {
      items: {
        additionalProperties: false,
        properties: {
          classification: { enum: CLASSIFICATIONS, type: 'string' },
          content: { type: 'string' },
          evidenceMessageIds: { items: { type: 'string' }, type: 'array' },
          existingEntityId: { type: ['string', 'null'] },
          knowledgeKind: { enum: [...KNOWLEDGE_KINDS, null] },
          rationale: { type: ['string', 'null'] },
          subjectKey: { type: ['string', 'null'] },
          target: { enum: TARGETS, type: 'string' },
          title: { type: ['string', 'null'] },
          usefulPending: { type: 'boolean' },
        },
        required: [
          'classification', 'content', 'evidenceMessageIds', 'existingEntityId', 'knowledgeKind',
          'rationale', 'subjectKey', 'target', 'title', 'usefulPending',
        ],
        type: 'object',
      },
      type: 'array',
    },
    summary: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['candidates', 'summary', 'title'],
  type: 'object',
} as const;

function outputText(response: OpenAIResponse) {
  return (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
    .trim();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseMatches(value: unknown): ProjectSegmentMatch[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { matches?: unknown }).matches)) {
    throw new Error('Project matching returned an invalid result.');
  }
  const matches = (value as { matches: unknown[] }).matches;
  if (matches.length > 20) throw new Error('Project matching returned too many results.');
  return matches.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Project matching returned an invalid item.');
    const item = raw as Record<string, unknown>;
    if (
      !['high', 'medium', 'low'].includes(item.confidence as string) ||
      typeof item.projectId !== 'string' || item.projectId.length > 300 ||
      !isStringArray(item.relevantMessageIds) || item.relevantMessageIds.length > 50 ||
      item.relevantMessageIds.some((id) => id.length > 300)
    ) throw new Error('Project matching returned an invalid item.');
    return item as ProjectSegmentMatch;
  });
}

function parseCandidate(raw: unknown): ConversationProjectCandidate {
  if (!raw || typeof raw !== 'object') throw new Error('Project reconciliation returned an invalid candidate.');
  const item = raw as Record<string, unknown>;
  const nullableString = (value: unknown) => value === null || typeof value === 'string';
  if (
    !CLASSIFICATIONS.includes(item.classification as typeof CLASSIFICATIONS[number]) ||
    typeof item.content !== 'string' || item.content.length > 2_000 ||
    !isStringArray(item.evidenceMessageIds) || item.evidenceMessageIds.length > 20 ||
    item.evidenceMessageIds.some((id) => id.length > 300) ||
    !nullableString(item.existingEntityId) || !nullableString(item.rationale) ||
    !nullableString(item.subjectKey) || !nullableString(item.title) ||
    (typeof item.existingEntityId === 'string' && item.existingEntityId.length > 300) ||
    (typeof item.rationale === 'string' && item.rationale.length > 1_000) ||
    (typeof item.subjectKey === 'string' && item.subjectKey.length > 100) ||
    (typeof item.title === 'string' && item.title.length > 300) ||
    typeof item.usefulPending !== 'boolean' ||
    !TARGETS.includes(item.target as typeof TARGETS[number]) ||
    !(item.knowledgeKind === null ||
      KNOWLEDGE_KINDS.includes(item.knowledgeKind as typeof KNOWLEDGE_KINDS[number]))
  ) throw new Error('Project reconciliation returned an invalid candidate.');
  return item as ConversationProjectCandidate;
}

function parseReconciliation(value: unknown): ProjectConversationReconciliation {
  if (!value || typeof value !== 'object') throw new Error('Project reconciliation returned an invalid result.');
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.candidates) || result.candidates.length > 30 ||
    typeof result.summary !== 'string' || typeof result.title !== 'string'
  ) throw new Error('Project reconciliation returned an invalid result.');
  return {
    candidates: result.candidates.map(parseCandidate),
    summary: result.summary,
    title: result.title,
  };
}

export class OpenAIConversationProjectAnalyzer implements ConversationProjectAnalyzer {
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly model: string;

  constructor(options: AnalyzerOptions) {
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async matchProjectSegments(
    conversation: ConversationWithMessages,
    projects: readonly Project[],
  ) {
    const result = await this.requestStructured(
      [
        'Identify only transcript messages that meaningfully concern an existing Project.',
        'A conversation can concern multiple Projects and can switch away and back again.',
        'Return one consolidated match per Project with every relevant message ID.',
        'Exclude food, reading, cleaning, general life questions, and other unrelated content.',
        'Use high confidence only when the Project name is explicit or details unmistakably match exactly one Project.',
        'A unique, explicit acronym or shorthand can identify a Project (for example AQAL for AQAL Collective). If that shorthand could identify more than one listed Project, treat it as ambiguous.',
        'Use medium or low confidence when ambiguous. Never invent or propose a new Project.',
      ].join('\n'),
      {
        projects: projects.map((project) => ({
          description: project.description ?? null,
          goal: project.goal ?? null,
          id: project.id,
          name: project.name,
          status: project.status,
          type: project.type,
        })),
        transcript: conversation.messages.map((message) => ({
          content: message.content,
          id: message.id,
          role: message.role,
        })),
      },
      'conversation_project_matches',
      MATCH_SCHEMA,
    );
    return parseMatches(result);
  }

  async reconcileProjectSegment(input: Parameters<ConversationProjectAnalyzer['reconcileProjectSegment']>[0]) {
    const relevant = new Set(input.relevantMessageIds);
    const result = await this.requestStructured(
      [
        `Analyze only the supplied messages for the existing Project named "${input.project.name}".`,
        'Write one concise work-session title and summary containing only this Project’s discussion, progress, confirmed context, unresolved questions, and useful next considerations.',
        'Do not copy the transcript and do not mention unrelated topics.',
        'Compare every candidate with current Project state before classifying it.',
        'Use already_known for existing truth or work even when paraphrased. Do not duplicate it.',
        'Use clear_update only for an explicit, unambiguous replacement of an identified current knowledge item.',
        'Use confirmed_decision only when the user clearly decided or accepted it. Maybe, perhaps, considering, alternatives, and what-if language are brainstorming.',
        'Use unresolved_question only for a genuinely open, Project-useful question.',
        'Mark usefulPending true only for a potentially important but unconfirmed change worth revisiting later.',
        'When updating or revisiting an existing entity, provide its exact existingEntityId. Do not guess IDs.',
        'Every candidate must cite the exact source message IDs that support it. Evidence must come from the supplied Project messages and include the user’s own words.',
        'Give each candidate a short stable subjectKey for its logical topic (for example material-direction or launch-date), independent of wording and conversation ID.',
        'Do not create a Project. Be conservative: ambiguity stays uncommitted.',
      ].join('\n'),
      {
        currentProjectState: {
          decisions: input.snapshot.decisions.map((value) => ({
            id: value.id, statement: value.statement, status: value.status,
          })),
          knowledge: input.snapshot.knowledgeItems.map((value) => ({
            content: value.content, id: value.id, kind: value.kind, status: value.status,
            title: value.title ?? null,
          })),
          project: input.project,
          recentWorkSessions: input.snapshot.recentWorkSessions.map((value) => ({
            id: value.id, summary: value.summary ?? null, title: value.title ?? null,
          })),
          tasks: input.snapshot.tasks.map((value) => ({
            id: value.id, status: value.status, title: value.title,
          })),
        },
        projectMessages: input.conversation.messages
          .filter((message) => relevant.has(message.id))
          .map((message) => ({ content: message.content, id: message.id, role: message.role })),
      },
      'conversation_project_reconciliation',
      RECONCILIATION_SCHEMA,
    );
    return parseReconciliation(result);
  }

  private async requestStructured(
    instructions: string,
    input: unknown,
    name: string,
    schema: unknown,
  ) {
    const serializedInput = JSON.stringify(input);
    if (serializedInput.length > MAX_ANALYZER_INPUT_CHARACTERS) {
      throw new Error('Conversation Project analyzer input exceeds its safe limit.');
    }
    const response = await this.fetchImplementation('https://api.openai.com/v1/responses', {
      body: JSON.stringify({
        input: [{ content: serializedInput, role: 'user' }],
        instructions,
        max_output_tokens: 4_000,
        model: this.model,
        reasoning: { effort: 'none' },
        store: false,
        text: {
          format: { name, schema, strict: true, type: 'json_schema' },
          verbosity: 'low',
        },
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await response.json().catch(() => ({}))) as OpenAIResponse;
    if (!response.ok) {
      throw new Error(typeof body.error?.message === 'string'
        ? body.error.message
        : 'Conversation Project analysis failed.');
    }
    const text = outputText(body);
    if (!text) throw new Error('Conversation Project analysis returned no result.');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Conversation Project analysis returned invalid JSON.');
    }
  }
}
