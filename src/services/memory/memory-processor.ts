import type {
  GeneralMemory,
  MemoryAnalysis,
  MemoryCandidate,
  MemoryMessageContext,
  MemoryProjectIdentity,
} from '../../domain/memory';

import type { MemoryAnalyzer } from './memory-analyzer';
import type { MemoryRepository } from './memory-repository';

const MAX_MESSAGES_PER_REQUEST = 8;
const MAX_CANDIDATES_PER_MESSAGE = 6;
const MAX_RELEVANT_MEMORIES = 12;
const MAX_CONTENT_LENGTH = 600;
const MAX_CONTEXT_LENGTH = 300;
const MAX_SUBJECT_LENGTH = 160;
const MEMORY_TYPES = new Set([
  'background', 'commitment', 'constraint', 'goal', 'preference', 'state',
]);
const PROVENANCE = new Set(['explicit_decision', 'explicit_statement', 'inferred']);
const LAYERS = new Set(['durable', 'current_state']);
const ACTIONS = new Set([
  'ambiguous', 'coexist', 'exception', 'history_only', 'promote', 'repeat', 'supersede',
]);
const NON_RETRYABLE_ERROR_PREFIX = '[nonretryable] ';
const DETERMINISTIC_COMMIT_FAILURES = [
  'A contextual exception requires context.',
  'A memory candidate is invalid.',
  'Memory cannot supersede higher-authority evidence.',
  'Only active memory can be repeated.',
  'The memory validity range is invalid.',
  'The referenced memory has a different logical identity.',
  'The referenced memory was not found.',
];

export class MemoryProcessingInProgressError extends Error {
  constructor() {
    super('Memory processing is already in progress.');
    this.name = 'MemoryProcessingInProgressError';
  }
}

function optionalBounded(value: string | undefined, maximum: number) {
  const normalized = value?.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function optionalTimestamp(value: string | undefined) {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function defaultReviewBoundary(occurredAt: string, action: MemoryCandidate['action']) {
  const value = new Date(occurredAt);
  value.setUTCDate(value.getUTCDate() + (action === 'exception' ? 7 : 90));
  return value.toISOString();
}

function normalizedProjectText(value: string | undefined) {
  return value?.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ') ?? '';
}

function containsPhrase(text: string, phrase: string) {
  return phrase.length > 0 && (` ${text} `).includes(` ${phrase} `);
}

function matchesUnambiguousProjectIdentity(
  text: string,
  projects: readonly MemoryProjectIdentity[],
) {
  return projects.some((project) => {
    const id = normalizedProjectText(project.id);
    if (id && containsPhrase(text, id)) return true;

    const name = normalizedProjectText(project.name);
    if (!name) return false;
    const wordCount = name.split(' ').length;
    const acronym = /^[A-Z0-9]{3,}$/.test(project.name.trim());
    if (wordCount > 1 || acronym) return containsPhrase(text, name);

    // A single ordinary word is only an identity when explicitly framed as a
    // Project name. This avoids suppressing unrelated general statements.
    return containsPhrase(text, `project ${name}`) ||
      containsPhrase(text, `${name} project`);
  });
}

function hasUnambiguousProjectIdentity(
  candidate: MemoryCandidate,
  projects: readonly MemoryProjectIdentity[],
  sourceText: string | undefined,
) {
  const candidateText = normalizedProjectText([
    candidate.subjectKey, candidate.topic, candidate.content, candidate.context,
  ].filter(Boolean).join(' '));
  if (!candidateText) return false;
  if (matchesUnambiguousProjectIdentity(candidateText, projects)) return true;

  // Source-only matching is accepted only when the candidate itself explicitly
  // says it is Project truth. This preserves mixed-topic general memories.
  return containsPhrase(candidateText, 'the project') &&
    matchesUnambiguousProjectIdentity(normalizedProjectText(sourceText), projects);
}

function validateCandidate(
  raw: MemoryCandidate,
  existing: readonly GeneralMemory[],
  options: {
    projectIdentities?: readonly MemoryProjectIdentity[];
    sourceOccurredAt?: string;
    sourceText?: string;
  },
): MemoryCandidate | null {
  if (!ACTIONS.has(raw.action) || !Number.isFinite(raw.confidence)) return null;
  if (raw.action === 'history_only' || raw.scope === 'project' ||
    hasUnambiguousProjectIdentity(
      raw, options.projectIdentities ?? [], options.sourceText,
    )) {
    return { action: 'history_only', confidence: 0 } satisfies MemoryCandidate;
  }

  const existingMemory = raw.existingMemoryId
    ? existing.find((memory) => memory.id === raw.existingMemoryId)
    : undefined;
  if ((raw.action === 'repeat' || raw.action === 'supersede') && !existingMemory) {
    throw new Error('The referenced memory was not found.');
  }

  // A referenced owner-scoped memory is the canonical authority for logical
  // identity. The analyzer may describe a correction with a new label, but it
  // may not move that correction to a different subject/context identity.
  const referencedAction = !!existingMemory &&
    (raw.action === 'repeat' || raw.action === 'supersede');

  const layer = raw.layer ?? existingMemory?.layer;
  const memoryType = raw.memoryType ?? existingMemory?.memoryType;
  const provenance = raw.provenance ?? existingMemory?.provenance;
  const subjectKey = optionalBounded(
    referencedAction ? existingMemory.subjectKey : raw.subjectKey ?? existingMemory?.subjectKey,
    MAX_SUBJECT_LENGTH,
  );
  const content = optionalBounded(raw.content ?? existingMemory?.content, MAX_CONTENT_LENGTH);
  if (!layer || !LAYERS.has(layer) || !memoryType || !MEMORY_TYPES.has(memoryType) ||
    !provenance || !PROVENANCE.has(provenance) || !subjectKey || !content) return null;

  const confidence = Math.max(0, Math.min(
    provenance === 'inferred' ? 0.65 : 1,
    raw.confidence,
  ));
  if (confidence < 0.35) return null;

  const validFrom = optionalTimestamp(raw.validFrom);
  const validUntil = optionalTimestamp(raw.validUntil);
  if (validFrom && validUntil && validUntil < validFrom) return null;
  const staleAfter = optionalTimestamp(raw.staleAfter) ??
    ((layer === 'current_state' || raw.action === 'ambiguous') && options.sourceOccurredAt
      ? defaultReviewBoundary(options.sourceOccurredAt, raw.action)
      : undefined);

  return {
    action: raw.action,
    confidence,
    content,
    ...(optionalBounded(
      referencedAction ? existingMemory.context : raw.context ?? existingMemory?.context,
      MAX_CONTEXT_LENGTH,
    ) ? {
      context: optionalBounded(
        referencedAction ? existingMemory.context : raw.context ?? existingMemory?.context,
        MAX_CONTEXT_LENGTH,
      ),
    } : {}),
    ...(existingMemory ? { existingMemoryId: existingMemory.id } : {}),
    layer,
    memoryType,
    provenance,
    scope: 'general',
    ...(staleAfter ? { staleAfter } : {}),
    subjectKey,
    ...(optionalBounded(raw.topic, MAX_SUBJECT_LENGTH) ? {
      topic: optionalBounded(raw.topic, MAX_SUBJECT_LENGTH),
    } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
  } satisfies MemoryCandidate;
}

export function isDeterministicMemoryCommitFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return DETERMINISTIC_COMMIT_FAILURES.some((value) => message.includes(value));
}

export function validateMemoryAnalysis(
  analysis: MemoryAnalysis,
  existing: readonly GeneralMemory[],
  options: {
    projectIdentities?: readonly MemoryProjectIdentity[];
    sourceOccurredAt?: string;
    sourceText?: string;
  } = {},
): MemoryAnalysis {
  if (analysis.version !== 1 || !Array.isArray(analysis.candidates) ||
    analysis.candidates.length > MAX_CANDIDATES_PER_MESSAGE) {
    throw new Error('Memory analysis returned an invalid result.');
  }
  const candidates = analysis.candidates
    .map((candidate) => validateCandidate(candidate, existing, options))
    .filter((candidate): candidate is MemoryCandidate => candidate !== null);
  return { candidates, version: 1 };
}

function validateContext(context: MemoryMessageContext) {
  if (!context.conversationId || !context.message.id || !context.message.content ||
    context.message.role !== 'user' || context.message.content.length > 4_000 ||
    context.nearbyMessages.length > 7) {
    throw new Error('Memory processing received invalid conversation evidence.');
  }
}

export class MemoryProcessor {
  constructor(
    private readonly analyzer: MemoryAnalyzer,
    private readonly repository: MemoryRepository,
  ) {}

  async process(conversationId?: string) {
    let processedMessageCount = 0;

    for (let index = 0; index < MAX_MESSAGES_PER_REQUEST; index += 1) {
      const claim = await this.repository.claimNextMessage(conversationId);
      if (claim.status === 'complete') {
        return { processedMessageCount, status: 'processed' as const };
      }
      if (claim.status === 'processing') throw new MemoryProcessingInProgressError();

      const { claimToken, context } = claim;
      validateContext(context);
      try {
        const [existing, projectIdentities] = await Promise.all([
          this.repository.getAnalysisMemories(
            context.message.content,
            MAX_RELEVANT_MEMORIES,
          ),
          this.repository.getProjectIdentities(8),
        ]);
        const raw = await this.analyzer.analyze({
          context,
          existingMemories: existing,
          projectIdentities,
        });
        const analysis = validateMemoryAnalysis(raw, existing, {
          projectIdentities,
          sourceOccurredAt: context.message.occurredAt,
          sourceText: context.message.content,
        });
        await this.repository.commitAnalysis({
          analysis,
          claimToken,
          conversationId: context.conversationId,
          expectedMemories: existing.map((memory) => ({
            content: memory.content,
            ...(memory.context ? { context: memory.context } : {}),
            id: memory.id,
            provenance: memory.provenance,
            status: memory.status,
            subjectKey: memory.subjectKey,
            updatedAt: memory.updatedAt,
          })),
          messageId: context.message.id,
        });
        processedMessageCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Memory processing failed.';
        const checkpointError = isDeterministicMemoryCommitFailure(error)
          ? `${NON_RETRYABLE_ERROR_PREFIX}${message}`
          : message;
        await this.repository.failMessage({
          claimToken,
          conversationId: context.conversationId,
          error: checkpointError,
          messageId: context.message.id,
        })
          .catch(() => undefined);
        throw error;
      }
    }

    return { processedMessageCount, status: 'partial' as const };
  }
}

export const MEMORY_PROCESSING_LIMITS = {
  candidatesPerMessage: MAX_CANDIDATES_PER_MESSAGE,
  messagesPerRequest: MAX_MESSAGES_PER_REQUEST,
  relevantMemories: MAX_RELEVANT_MEMORIES,
};
