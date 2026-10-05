import type {
  MemoryAnalysis,
  MemoryCandidate,
} from '../../domain/memory';
import type { MemoryAnalyzer } from '../../services/memory/memory-analyzer';

type OpenAIResponse = {
  error?: { message?: unknown };
  output?: { content?: { text?: unknown; type?: unknown }[]; type?: unknown }[];
};

type Options = {
  apiKey: string;
  fetchImplementation?: typeof fetch;
  model?: string;
};

const DEFAULT_MODEL = 'gpt-5.4-mini';
const MAX_INPUT_CHARACTERS = 32_000;
const ACTIONS = [
  'ambiguous', 'coexist', 'exception', 'history_only', 'promote', 'repeat', 'supersede',
] as const;
const LAYERS = ['durable', 'current_state'] as const;
const MEMORY_TYPES = ['background', 'commitment', 'constraint', 'goal', 'preference', 'state'] as const;
const PROVENANCE = ['explicit_decision', 'explicit_statement', 'inferred'] as const;
const SCOPES = ['general', 'project'] as const;

const MEMORY_SCHEMA = {
  additionalProperties: false,
  properties: {
    candidates: {
      items: {
        additionalProperties: false,
        properties: {
          action: { enum: ACTIONS, type: 'string' },
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          content: { type: ['string', 'null'] },
          context: { type: ['string', 'null'] },
          existingMemoryId: { type: ['string', 'null'] },
          layer: { enum: [...LAYERS, null] },
          memoryType: { enum: [...MEMORY_TYPES, null] },
          provenance: { enum: [...PROVENANCE, null] },
          scope: { enum: SCOPES },
          staleAfter: { type: ['string', 'null'] },
          subjectKey: { type: ['string', 'null'] },
          topic: { type: ['string', 'null'] },
          validFrom: { type: ['string', 'null'] },
          validUntil: { type: ['string', 'null'] },
        },
        required: [
          'action', 'confidence', 'content', 'context', 'existingMemoryId', 'layer',
          'memoryType', 'provenance', 'scope', 'staleAfter', 'subjectKey', 'topic', 'validFrom',
          'validUntil',
        ],
        type: 'object',
      },
      type: 'array',
    },
    version: { const: 1, type: 'integer' },
  },
  required: ['candidates', 'version'],
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

function nullableString(value: unknown) {
  return value === null || typeof value === 'string';
}

function parseCandidate(value: unknown): MemoryCandidate {
  if (!value || typeof value !== 'object') throw new Error('Memory analysis returned an invalid candidate.');
  const row = value as Record<string, unknown>;
  if (!ACTIONS.includes(row.action as typeof ACTIONS[number]) ||
    typeof row.confidence !== 'number' || row.confidence < 0 || row.confidence > 1 ||
    !nullableString(row.content) || !nullableString(row.context) ||
    !nullableString(row.existingMemoryId) || !nullableString(row.staleAfter) ||
    !nullableString(row.subjectKey) || !nullableString(row.topic) ||
    !nullableString(row.validFrom) || !nullableString(row.validUntil) ||
    !(row.layer === null || LAYERS.includes(row.layer as typeof LAYERS[number])) ||
    !(row.memoryType === null || MEMORY_TYPES.includes(row.memoryType as typeof MEMORY_TYPES[number])) ||
    !(row.provenance === null || PROVENANCE.includes(row.provenance as typeof PROVENANCE[number])) ||
    !SCOPES.includes(row.scope as typeof SCOPES[number])) {
    throw new Error('Memory analysis returned an invalid candidate.');
  }
  return Object.fromEntries(Object.entries(row).filter(([, item]) => item !== null)) as MemoryCandidate;
}

function parseAnalysis(value: unknown): MemoryAnalysis {
  if (!value || typeof value !== 'object') throw new Error('Memory analysis returned an invalid result.');
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.candidates) || row.candidates.length > 6) {
    throw new Error('Memory analysis returned an invalid result.');
  }
  return { candidates: row.candidates.map(parseCandidate), version: 1 };
}

function bounded(value: string | undefined, maximum: number) {
  return value?.slice(0, maximum) ?? null;
}

export function createMemoryAnalyzerInput(input: Parameters<MemoryAnalyzer['analyze']>[0]) {
  const currentPosition = input.context.message.position;
  const payload = {
    existingMemories: input.existingMemories.slice(0, 12).map((memory) => ({
      confidence: memory.confidence,
      content: bounded(memory.content, 400),
      context: bounded(memory.context, 160),
      id: bounded(memory.id, 240),
      layer: memory.layer,
      memoryType: memory.memoryType,
      provenance: memory.provenance,
      staleAfter: memory.staleAfter ?? null,
      status: memory.status,
      subjectKey: bounded(memory.subjectKey, 120),
      topic: bounded(memory.topic, 100),
      updatedAt: memory.updatedAt,
      validUntil: memory.validUntil ?? null,
    })),
    localEvidence: {
      currentUserMessage: {
        ...input.context.message,
        content: input.context.message.content.slice(0, 4_000),
      },
      nearbyMessages: [...input.context.nearbyMessages]
        .sort((left, right) =>
          Math.abs(left.position - currentPosition) - Math.abs(right.position - currentPosition) ||
          right.position - left.position)
        .slice(0, 7)
        .map((message) => ({ ...message, content: message.content.slice(0, 800) })),
    },
    projectIdentities: input.projectIdentities.slice(0, 8).map((project) => ({
      description: bounded(project.description, 180),
      goal: bounded(project.goal, 180),
      id: bounded(project.id, 240),
      name: bounded(project.name, 120),
      status: bounded(project.status, 40),
    })),
  };
  let serialized = JSON.stringify(payload);
  while (serialized.length > MAX_INPUT_CHARACTERS && payload.localEvidence.nearbyMessages.length) {
    payload.localEvidence.nearbyMessages.pop();
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > MAX_INPUT_CHARACTERS && payload.existingMemories.length > 1) {
    payload.existingMemories.pop();
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > MAX_INPUT_CHARACTERS && payload.projectIdentities.length > 1) {
    payload.projectIdentities.pop();
    serialized = JSON.stringify(payload);
  }
  if (serialized.length > MAX_INPUT_CHARACTERS) {
    throw new Error('Memory analyzer input is too large after deterministic bounding.');
  }
  return serialized;
}

export class OpenAIMemoryAnalyzer implements MemoryAnalyzer {
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly model: string;

  constructor(options: Options) {
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async analyze(input: Parameters<MemoryAnalyzer['analyze']>[0]) {
    const serialized = createMemoryAnalyzerInput(input);

    const response = await this.fetchImplementation('https://api.openai.com/v1/responses', {
      body: JSON.stringify({
        input: [{ content: serialized, role: 'user' }],
        instructions: [
          'Extract general personal memory only from the current user message, using nearby messages solely to resolve references and context.',
          'Bounded recent unresolved memories may resolve delayed pronouns or changed wording; they are context, never fresh evidence. When the current user message uses it, them, that, those, or a similar reference and expresses a clear preference or state, resolve it against one supplied ambiguous memory only when the subject and conversational meaning fit unambiguously. Then promote or supersede that referenced memory with the exact existingMemoryId and explicit provenance. If several supplied memories are plausible, do not attach the pronoun arbitrarily.',
          'Project identities describe existing Project scope. Mark clearly Project-specific statements scope project and history_only. General personal facts remain scope general. Do not create Project truth or write Project data. Do not extract assistant suggestions as user facts. Do not invent identity, intent, or permanence.',
          'Promote only information likely to matter again: stable or recurring preferences, long-term goals, durable constraints/background, meaningful commitments, or useful changing current state.',
          'A concrete unresolved personal statement may be ambiguous structured memory when it names a specific reusable subject, expresses a real but unresolved preference or state, and would plausibly help with later clarification. For example, “I’m not sure how I feel about linen lampshades. Maybe they’re growing on me.” is an ambiguous durable preference about linen lampshades, not an authoritative claim that the user likes them. Use inferred provenance, appropriately limited confidence, self-contained uncertain content, and a contextual staleAfter review boundary so it cannot remain an active open referent forever.',
          'Return history_only for factual questions, jokes, filler, random curiosity, and weak undeveloped brainstorming without a concrete reusable personal referent. “Maybe I should learn pottery someday” is normally History-only. Do not broadly promote casual uncertainty.',
          'Use durable for stable information. Use current_state for facts or plans expected to change. Give every current_state memory a supported validUntil or staleAfter review boundary; when no precise date exists, choose a conservative contextual review horizon. One-time exceptions need a near review boundary.',
          'Use explicit_statement for facts/preferences directly stated by the user, explicit_decision for a clear decision or commitment, and inferred only for a genuinely useful interpretation. Inference must have confidence at most 0.65.',
          'Compare against existing memories. Use repeat for the same meaning, supersede when the user clearly changes or explicitly resolves an existing general memory, exception for a situation-specific departure, coexist for compatible contextual detail, and ambiguous when a concrete personal preference or state is unresolved. A single clear correction or clarification may supersede every incompatible active row for that subject/context.',
          'Provenance authority is inferred < explicit_statement < explicit_decision. Inference cannot supersede explicit evidence and repetition never changes that. A directly stated correction or repetition may supersede or upgrade an inferred memory.',
          'Newest does not automatically win. A one-time request is not a global preference reversal. Different contexts may coexist.',
          'For repeat and supersede, provide the exact existingMemoryId. Never guess an ID.',
          'Use a compact stable subjectKey representing the logical subject, not the wording or conversation ID. Keep content concise and self-contained.',
          'Return at most six candidates. Use one history_only candidate when nothing deserves structured memory.',
        ].join('\n'),
        max_output_tokens: 1_800,
        model: this.model,
        reasoning: { effort: 'none' },
        store: false,
        text: {
          format: { name: 'general_memory_analysis', schema: MEMORY_SCHEMA, strict: true, type: 'json_schema' },
          verbosity: 'low',
        },
      }),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json().catch(() => ({})) as OpenAIResponse;
    if (!response.ok) {
      throw new Error(typeof body.error?.message === 'string' ? body.error.message : 'Memory analysis failed.');
    }
    const text = outputText(body);
    if (!text) throw new Error('Memory analysis returned no result.');
    try {
      return parseAnalysis(JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Memory analysis returned invalid JSON.');
      throw error;
    }
  }
}
