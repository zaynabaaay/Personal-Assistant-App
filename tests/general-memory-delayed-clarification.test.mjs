import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  effectiveMemoryStatus,
  MemoryProcessor,
  reconcileMemoryAnalysis,
} from '../src/services/memory/index.ts';

const START = Date.parse('2026-08-25T13:22:31.685Z');
const conversationId = 'linen-iphone-sequence';

const transcript = [
  ['user', 'I’m not sure how I feel about linen lampshades. Maybe they’re growing on me.'],
  ['assistant', 'That makes sense — they may be growing on you.'],
  ['user', 'What causes thunder?'],
  ['assistant', 'Lightning rapidly heats and expands the air.'],
  ['user', 'Is glass technically a solid?'],
  ['assistant', 'Yes — it is an amorphous solid.'],
  ['user', 'Why do cats knead blankets?'],
  ['assistant', 'It is usually a comfort behavior.'],
  ['user', 'What’s the difference between fog and mist?'],
  ['assistant', 'Fog is denser and reduces visibility more.'],
  ['user', 'Actually, I definitely love them now.'],
  ['assistant', 'Nice — love is a much easier place to land.'],
].map(([role, content], position) => ({
  content, id: `linen-message-${position}`,
  occurredAt: new Date(START + position * 10_000).toISOString(), position, role,
}));

function contextAt(position) {
  const message = transcript[position];
  return {
    conversationId,
    message: { ...message, conversationId },
    nearbyMessages: transcript.filter((candidate) =>
      candidate.position >= Math.max(position - 3, 0) && candidate.position <= position),
  };
}

test('exact delayed linen clarification survives unrelated turns and becomes explicit truth', async () => {
  const userPositions = [0, 2, 4, 6, 8, 10];
  let claimIndex = 0;
  let memories = [];
  let finalAnalyzerInput;

  const analyzer = {
    analyze: async (input) => {
      const content = input.context.message.content;
      if (content.startsWith('I’m not sure how I feel about linen lampshades')) {
        return { candidates: [{
          action: 'ambiguous', confidence: 0.58,
          content: 'May be warming to linen lampshades but remains unsure.',
          layer: 'durable', memoryType: 'preference', provenance: 'inferred',
          scope: 'general', subjectKey: 'linen-lampshade-preference', topic: 'home decor',
        }], version: 1 };
      }
      if (content === 'Actually, I definitely love them now.') {
        finalAnalyzerInput = input;
        const linen = input.existingMemories.find((memory) =>
          memory.subjectKey === 'linen-lampshade-preference');
        assert.ok(linen, 'ambiguous linen referent must reach the final analyzer call');
        return { candidates: [{
          action: 'supersede', confidence: 0.99, content: 'Loves linen lampshades.',
          existingMemoryId: linen.id, layer: 'durable', memoryType: 'preference',
          provenance: 'explicit_statement', scope: 'general',
          subjectKey: 'linen-lampshades-final-wording', topic: 'home decor',
        }], version: 1 };
      }
      return { candidates: [{ action: 'history_only', confidence: 0 }], version: 1 };
    },
  };

  const repository = {
    claimNextMessage: async () => {
      if (claimIndex >= userPositions.length) return { status: 'complete' };
      const position = userPositions[claimIndex];
      claimIndex += 1;
      return { claimToken: `linen-claim-${position}`, context: contextAt(position), status: 'claimed' };
    },
    commitAnalysis: async ({ analysis, messageId }) => {
      const position = transcript.find((message) => message.id === messageId).position;
      memories = reconcileMemoryAnalysis(memories, analysis, contextAt(position), {
        createId: (candidateIndex) => `linen-memory-${position}-${candidateIndex}`,
        now: () => new Date(transcript[position].occurredAt),
      });
    },
    failMessage: async () => undefined,
    getAnalysisMemories: async () => [...memories]
      .sort((left, right) => {
        const leftOpen = left.status === 'ambiguous' ? 1 : 0;
        const rightOpen = right.status === 'ambiguous' ? 1 : 0;
        return rightOpen - leftOpen || right.updatedAt.localeCompare(left.updatedAt);
      })
      .slice(0, 12),
    getProjectIdentities: async () => [],
    search: async () => memories.filter((memory) => memory.status === 'current'),
  };

  const processor = new MemoryProcessor(analyzer, repository);
  const result = await processor.process(conversationId);
  assert.deepEqual(result, { processedMessageCount: 6, status: 'processed' });

  assert.ok(finalAnalyzerInput);
  assert.deepEqual(finalAnalyzerInput.context.nearbyMessages.map((message) => message.position),
    [7, 8, 9, 10]);
  assert.equal(finalAnalyzerInput.context.nearbyMessages.some((message) =>
    /linen lampshades/.test(message.content)), false);
  assert.ok(finalAnalyzerInput.existingMemories.some((memory) =>
    memory.subjectKey === 'linen-lampshade-preference' && memory.status === 'ambiguous'));

  const ambiguous = memories.find((memory) => memory.id === 'linen-memory-0-0');
  const explicit = memories.find((memory) => memory.id === 'linen-memory-10-0');
  assert.equal(ambiguous.status, 'superseded');
  assert.ok(ambiguous.staleAfter);
  assert.equal(ambiguous.supersededByMemoryId, explicit.id);
  assert.equal(explicit.status, 'current');
  assert.equal(explicit.subjectKey, 'linen-lampshade-preference');
  assert.equal(explicit.content, 'Loves linen lampshades.');
  assert.equal(explicit.provenance, 'explicit_statement');
  assert.equal(explicit.supersedesMemoryId, ambiguous.id);
});

test('concrete uncertainty stays non-authoritative and ages through existing temporal status', async () => {
  const occurredAt = '2026-08-25T13:22:31.685Z';
  let committed;
  let complete = false;
  const processor = new MemoryProcessor({ analyze: async () => ({ candidates: [{
    action: 'ambiguous', confidence: 0.58,
    content: 'May be warming to linen lampshades but remains unsure.',
    layer: 'durable', memoryType: 'preference', provenance: 'inferred',
    scope: 'general', subjectKey: 'linen-lampshade-preference', topic: 'home decor',
  }], version: 1 }) }, {
    claimNextMessage: async () => complete ? { status: 'complete' } : {
      claimToken: 'linen-uncertain-claim', context: {
        conversationId, message: {
          content: transcript[0].content, conversationId, id: 'linen-uncertain',
          occurredAt, position: 0, role: 'user',
        }, nearbyMessages: [],
      }, status: 'claimed',
    },
    commitAnalysis: async ({ analysis }) => { committed = analysis; complete = true; },
    failMessage: async () => undefined,
    getAnalysisMemories: async () => [], getProjectIdentities: async () => [], search: async () => [],
  });
  await processor.process(conversationId);
  const candidate = committed.candidates[0];
  assert.equal(candidate.action, 'ambiguous');
  assert.equal(candidate.provenance, 'inferred');
  assert.equal(candidate.content.includes('remains unsure'), true);
  assert.equal(candidate.staleAfter, '2026-11-23T13:22:31.685Z');

  const memory = reconcileMemoryAnalysis([], committed, contextAt(0), {
    createId: () => 'linen-open-referent', now: () => new Date(occurredAt),
  })[0];
  assert.equal(memory.status, 'ambiguous');
  assert.equal(effectiveMemoryStatus(memory, new Date('2026-09-01T00:00:00Z')), 'ambiguous');
  assert.equal(effectiveMemoryStatus(memory, new Date('2026-12-01T00:00:00Z')), 'stale');
});

test('analyzer policy distinguishes concrete unresolved preference from weak brainstorming', async () => {
  const analyzer = await readFile(new URL(
    '../src/server/memory/openai-memory-analyzer.ts', import.meta.url,
  ), 'utf8');
  assert.match(analyzer, /specific reusable subject/);
  assert.match(analyzer, /linen lampshades/);
  assert.match(analyzer, /Maybe I should learn pottery someday.*History-only/);
  assert.match(analyzer, /If several supplied memories are plausible, do not attach the pronoun arbitrarily/);
});
