import type {
  GeneralMemory,
  MemoryAnalysis,
  MemoryMessageContext,
  MemorySourceReference,
} from '../../domain/memory';

type ReconcileOptions = {
  createId?: (candidateIndex: number) => string;
  now?: () => Date;
};

function normalized(value: string | undefined) {
  return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? '';
}

const PROVENANCE_RANK: Record<GeneralMemory['provenance'], number> = {
  explicit_decision: 3,
  explicit_statement: 2,
  inferred: 1,
};

function isExplicit(provenance: GeneralMemory['provenance']) {
  return PROVENANCE_RANK[provenance] >= PROVENANCE_RANK.explicit_statement;
}

function sameSubject(
  memory: GeneralMemory,
  subjectKey: string,
  context: string | undefined,
) {
  return normalized(memory.subjectKey) === normalized(subjectKey) &&
    normalized(memory.context) === normalized(context);
}

function reviewBoundary(occurredAt: string, action: string) {
  const value = new Date(occurredAt);
  value.setUTCDate(value.getUTCDate() + (action === 'exception' ? 7 : 90));
  return value.toISOString();
}

export function effectiveMemoryStatus(
  memory: GeneralMemory,
  at = new Date(),
): GeneralMemory['status'] {
  if (!['current', 'ambiguous'].includes(memory.status)) return memory.status;
  const timestamp = at.getTime();
  if (memory.validFrom && Date.parse(memory.validFrom) > timestamp) return 'stale';
  if (memory.validUntil && Date.parse(memory.validUntil) < timestamp) return 'expired';
  if (memory.staleAfter && Date.parse(memory.staleAfter) < timestamp) return 'stale';
  return memory.status;
}

function withEvidence(
  memory: GeneralMemory,
  source: MemorySourceReference,
  confidence: number,
  provenance: GeneralMemory['provenance'],
  now: string,
) {
  const alreadyLinked = memory.sourceReferences.some((reference) =>
    reference.conversationId === source.conversationId && reference.messageId === source.messageId);
  return {
    ...memory,
    confidence: PROVENANCE_RANK[provenance] >= PROVENANCE_RANK[memory.provenance]
      ? Math.max(memory.confidence, confidence)
      : memory.confidence,
    evidenceCount: Math.min(memory.evidenceCount + (alreadyLinked ? 0 : 1), 10_000),
    lastConfirmedAt: source.occurredAt > memory.lastConfirmedAt
      ? source.occurredAt
      : memory.lastConfirmedAt,
    provenance: PROVENANCE_RANK[provenance] > PROVENANCE_RANK[memory.provenance]
      ? provenance
      : memory.provenance,
    sourceReferences: alreadyLinked
      ? memory.sourceReferences
      : [...memory.sourceReferences, source].slice(-20),
    status: memory.status === 'ambiguous' && isExplicit(provenance)
      ? 'current' as const
      : memory.status,
    updatedAt: now,
  };
}

export function reconcileMemoryAnalysis(
  current: readonly GeneralMemory[],
  analysis: MemoryAnalysis,
  context: MemoryMessageContext,
  options: ReconcileOptions = {},
) {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const createId = options.createId ?? ((index: number) => `${context.message.id}:memory:${index}`);
  const memories = current.map((memory) => ({
    ...memory,
    sourceReferences: [...memory.sourceReferences],
  }));
  const source: MemorySourceReference = {
    conversationId: context.conversationId,
    messageId: context.message.id,
    occurredAt: context.message.occurredAt,
    role: 'user',
  };

  analysis.candidates.forEach((candidate, index) => {
    if (candidate.action === 'history_only' || !candidate.content || !candidate.layer ||
      !candidate.memoryType || !candidate.provenance || !candidate.subjectKey) return;
    const existingIndex = candidate.existingMemoryId
      ? memories.findIndex((memory) => memory.id === candidate.existingMemoryId)
      : -1;
    if (candidate.action === 'repeat' && existingIndex >= 0) {
      memories[existingIndex] = withEvidence(
        memories[existingIndex], source, candidate.confidence, candidate.provenance, now,
      );
      return;
    }

    const duplicateIndex = memories.findIndex((memory) =>
      ['current', 'ambiguous'].includes(memory.status) &&
      sameSubject(memory, candidate.subjectKey!, candidate.context) &&
      normalized(memory.content) === normalized(candidate.content) &&
      normalized(memory.context) === normalized(candidate.context));
    if (duplicateIndex >= 0 && candidate.action !== 'supersede') {
      memories[duplicateIndex] = withEvidence(
        memories[duplicateIndex], source, candidate.confidence, candidate.provenance, now,
      );
      return;
    }

    const incompatibleIndexes = memories.flatMap((memory, memoryIndex) =>
      ['current', 'ambiguous', 'stale'].includes(memory.status) &&
      sameSubject(memory, candidate.subjectKey!, candidate.context) &&
      normalized(memory.content) !== normalized(candidate.content)
        ? [memoryIndex]
        : []);
    if (candidate.action === 'supersede') {
      if (incompatibleIndexes.some((memoryIndex) =>
        PROVENANCE_RANK[memories[memoryIndex].provenance] >
          PROVENANCE_RANK[candidate.provenance!])) {
        throw new Error('Memory cannot supersede higher-authority user evidence.');
      }
    } else if (!['ambiguous', 'coexist', 'exception'].includes(candidate.action) &&
      incompatibleIndexes.length > 0) {
      throw new Error('Conflicting active memory requires explicit reconciliation.');
    }

    if (candidate.validFrom && candidate.validUntil &&
      Date.parse(candidate.validUntil) < Date.parse(candidate.validFrom)) {
      throw new Error('Memory validity range is invalid.');
    }

    if (candidate.action === 'supersede' && duplicateIndex >= 0) {
      memories[duplicateIndex] = withEvidence(
        memories[duplicateIndex], source, candidate.confidence, candidate.provenance, now,
      );
      for (const memoryIndex of incompatibleIndexes) {
        memories[memoryIndex] = {
          ...memories[memoryIndex],
          status: 'superseded',
          supersededByMemoryId: memories[duplicateIndex].id,
          updatedAt: now,
        };
      }
      return;
    }

    const id = createId(index);
    const memory: GeneralMemory = {
      confidence: candidate.confidence,
      content: candidate.content,
      ...(candidate.context ? { context: candidate.context } : {}),
      createdAt: context.message.occurredAt,
      evidenceCount: 1,
      id,
      lastConfirmedAt: context.message.occurredAt,
      layer: candidate.layer,
      memoryType: candidate.memoryType,
      provenance: candidate.provenance,
      sourceReferences: [source],
      ...(candidate.staleAfter ? { staleAfter: candidate.staleAfter } :
        candidate.layer === 'current_state' || candidate.action === 'ambiguous'
          ? { staleAfter: reviewBoundary(context.message.occurredAt, candidate.action) }
          : {}),
      status: candidate.action === 'ambiguous' ? 'ambiguous' : 'current',
      subjectKey: candidate.subjectKey,
      ...(candidate.action === 'supersede' && existingIndex >= 0
        ? { supersedesMemoryId: memories[existingIndex].id }
        : {}),
      ...(candidate.topic ? { topic: candidate.topic } : {}),
      updatedAt: now,
      ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
      ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
    };
    memories.push(memory);
    if (candidate.action === 'supersede') {
      for (const memoryIndex of incompatibleIndexes) {
        memories[memoryIndex] = {
          ...memories[memoryIndex],
          status: 'superseded',
          supersededByMemoryId: id,
          updatedAt: now,
        };
      }
    }
  });

  return memories;
}
