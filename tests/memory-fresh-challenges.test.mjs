import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { reconcileMemoryAnalysis } from '../src/services/memory/index.ts';

const AT = '2026-08-21T18:00:00.000Z';
function apply(memories, content, candidate, suffix) {
  return reconcileMemoryAnalysis(memories, { candidates: [candidate], version: 1 }, {
    conversationId: `fresh-${suffix}`,
    message: { content, conversationId: `fresh-${suffix}`, id: `fresh-message-${suffix}`, occurredAt: AT, position: 0, role: 'user' },
    nearbyMessages: [],
  }, { createId: () => `fresh-memory-${suffix}`, now: () => new Date(AT) });
}

const base = {
  confidence: 0.94,
  layer: 'durable',
  memoryType: 'preference',
  provenance: 'explicit_statement',
};

test('fresh challenge set covers unrelated durable, temporary, correction, exception, coexistence, and ambiguity cases', () => {
  let memories = apply([], 'Please keep notification sounds off whenever possible.', {
    ...base, action: 'promote', content: 'The user prefers notification sounds off.',
    subjectKey: 'notifications:sound', topic: 'device preferences',
  }, 'durable');
  memories = apply(memories, "I'm borrowing the blue hatchback through Monday.", {
    ...base, action: 'promote', content: 'The user is borrowing a blue hatchback through Monday.',
    layer: 'current_state', memoryType: 'state', subjectKey: 'transport:current-vehicle',
    validUntil: '2026-08-25T23:59:59.000Z',
  }, 'temporary');
  const vehicle = memories.find((memory) => memory.subjectKey === 'transport:current-vehicle');
  memories = apply(memories, 'The loan ended early; I am taking the train now.', {
    ...base, action: 'supersede', content: 'The user is currently taking the train.',
    existingMemoryId: vehicle.id, layer: 'current_state', memoryType: 'state',
    subjectKey: 'transport:current-vehicle',
  }, 'correction');
  memories = apply(memories, 'Print this contract just this once, though I normally stay digital.', {
    ...base, action: 'exception', content: 'The user wants this contract printed once.',
    context: 'this contract only', layer: 'current_state', memoryType: 'state',
    subjectKey: 'documents:print-exception',
  }, 'exception');
  memories = apply(memories, 'Jazz helps me with deep work.', {
    ...base, action: 'promote', content: 'The user likes jazz during deep work.',
    context: 'deep work', subjectKey: 'audio:work-context',
  }, 'coexist-a');
  memories = apply(memories, 'For invoices I need complete silence.', {
    ...base, action: 'coexist', content: 'The user prefers silence while handling invoices.',
    context: 'invoicing', subjectKey: 'audio:work-context',
  }, 'coexist-b');
  memories = apply(memories, 'I might be warming up to scented candles, but I am not sure.', {
    ...base, action: 'ambiguous', confidence: 0.55,
    content: 'The user may be warming to scented candles.', provenance: 'inferred',
    subjectKey: 'home:scented-candles',
  }, 'ambiguous');

  assert.equal(memories.find((memory) => memory.subjectKey === 'notifications:sound').status, 'current');
  assert.equal(memories.find((memory) => memory.id === vehicle.id).status, 'superseded');
  assert.equal(memories.find((memory) => memory.id === 'fresh-memory-correction').status, 'current');
  assert.equal(memories.find((memory) => memory.id === 'fresh-memory-exception').context, 'this contract only');
  assert.equal(memories.filter((memory) => memory.subjectKey === 'audio:work-context').length, 2);
  assert.equal(memories.find((memory) => memory.id === 'fresh-memory-ambiguous').status, 'ambiguous');
});

test('fresh History-only and retrieval/fallback challenge wording is represented in model policy', async () => {
  const analyzer = await readFile(new URL('../src/server/memory/openai-memory-analyzer.ts', import.meta.url), 'utf8');
  const provider = await readFile(new URL('../src/server/assistant/openai-assistant-provider.ts', import.meta.url), 'utf8');
  assert.match(analyzer, /factual questions, jokes, filler, random curiosity/);
  assert.match(analyzer, /weak undeveloped brainstorming/);
  assert.match(provider, /Use search_general_memory when remembered personal context could materially affect the answer/);
  assert.match(provider, /History as supporting evidence or fallback when structured memory is insufficient/);

  const historyOnly = apply([], 'Do octopuses dream in color?', {
    action: 'history_only', confidence: 0,
  }, 'history-only');
  assert.deepEqual(historyOnly, []);
});
