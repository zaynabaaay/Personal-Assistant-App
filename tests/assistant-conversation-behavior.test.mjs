import assert from 'node:assert/strict';
import test from 'node:test';

import { ASSISTANT_TOOL_CONTRACTS } from '../src/contracts/assistant/tool-registry.ts';
import {
  createAssistantInstructions,
  requestOpenAIAssistant,
} from '../src/server/assistant/openai-assistant-provider.ts';

const CONTEXT = {
  currentLocalDate: 'August 21, 2026',
  currentLocalTime: '9:00:00 AM',
  dayOfWeek: 'Friday',
  timezone: 'America/Toronto',
};

function request(messages = [{ content: 'Hello.', role: 'user' }]) {
  return { context: CONTEXT, messages, sessionId: 'conversation-evaluation' };
}

const instructions = createAssistantInstructions(request());

test('evaluation: a simple casual question permits a natural short response', () => {
  assert.match(instructions, /Short replies are allowed when they fully answer the moment/);
  assert.match(instructions, /Do not make every reply comprehensive/);
  assert.match(instructions, /Respond to the user’s immediate thought, question, or request first/);
});

test('evaluation: thinking out loud is distinguished from an explicit action request', () => {
  assert.match(instructions, /“I might work on Etsy later” is conversation, not an action request/);
  assert.match(instructions, /do not turn it into a task, reminder, plan, or persisted update/);
  assert.match(instructions, /“Remind me to work on Etsy later” is an action request/);
});

test('evaluation: what-to-do questions receive one grounded recommendation, not an inventory', () => {
  assert.match(instructions, /recommend one useful thing with a brief reason/);
  assert.match(instructions, /Do not dump the full task, Project, or calendar inventory/);
});

test('evaluation: a rejected recommendation remains available as conversational context', async () => {
  const messages = [
    { content: 'What should I do next?', role: 'user' },
    { content: 'I would get the email out of the way first.', role: 'assistant' },
    { content: 'I do not want to send the email right now.', role: 'user' },
  ];
  let modelRequest;

  await requestOpenAIAssistant(request(messages), [], {
    apiKey: 'test-key',
    fetchImplementation: async (_url, init) => {
      modelRequest = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        output: [{ content: [{ text: 'Then leave the email for now.', type: 'output_text' }], type: 'message' }],
      }));
    },
    model: 'test-model',
    signal: new AbortController().signal,
  });

  assert.deepEqual(modelRequest.input, messages);
  assert.match(modelRequest.instructions, /treat that as new conversational context/);
  assert.match(modelRequest.instructions, /do not repeat or defend the rejected suggestion/);
});

test('evaluation: low capacity scales a recommendation down without patronizing', () => {
  assert.match(instructions, /If capacity is low, scale the suggestion down without sounding patronizing/);
  assert.match(instructions, /Ask about it only when needed/);
});

test('evaluation: repeated avoidance can be challenged gently', () => {
  assert.match(instructions, /repeatedly avoiding something important/);
  assert.match(instructions, /suggest a smaller first step/);
  assert.match(instructions, /Do not lecture, shame, or manufacture urgency/);
});

test('evaluation: existing Project context is synthesized rather than dumped as status fields', () => {
  assert.match(instructions, /Treat tool results as evidence, not as a response template/);
  assert.match(instructions, /instead of reading fields back or dumping every retrieved record/);
  assert.match(instructions, /Avoid headings and labels such as Status, Priority, Decision/);
});

test('evaluation: an explicitly named Project is checked without hypothetical wording', () => {
  assert.match(instructions, /explicitly names something as a Project/);
  assert.match(instructions, /check list_projects instead of asking or speculating/);
  assert.match(instructions, /Do not say “if this is a Project”/);
});

test('evaluation: ordinary conversation is not unnecessarily classified as a Project', () => {
  assert.match(instructions, /Projects are explicit workspaces, not a classification required for ordinary conversation/);
  const listProjects = ASSISTANT_TOOL_CONTRACTS.find(({ name }) => name === 'list_projects');
  assert.match(listProjects.openAI.description, /Do not use to classify ordinary conversation as Project-related/);
});

test('evaluation: tool-backed answers remain grounded while tool mechanics stay invisible', () => {
  assert.match(instructions, /Treat current Project tool results as authoritative/);
  assert.match(instructions, /Do not narrate tool selection or retrieval/);
  assert.match(instructions, /Never invent calendar events or availability/);
});

test('evaluation: a suggestive uploaded filename is not evidence of file contents', () => {
  assert.match(instructions, /filename.*is not evidence of the file contents/i);
  assert.match(instructions, /Never claim to have read, inspected, summarized, or understood an uploaded asset/i);
  const projectContext = ASSISTANT_TOOL_CONTRACTS.find(({ name }) => name === 'get_project_context');
  assert.match(projectContext.openAI.description, /filenames.*are not evidence of file contents/i);
  assert.match(projectContext.openAI.description, /does not retrieve or analyze file bytes/i);
});

test('evaluation: responses do not have to end with a follow-up question', () => {
  assert.match(instructions, /do not force every reply to end with a question/);
  assert.match(instructions, /Ask at most one natural clarification/);
});

test('evaluation: longer explanations remain available when requested', () => {
  assert.match(instructions, /give a longer explanation when the user asks for detail/);
});

test('evaluation: insufficient context prompts natural clarification instead of invented prioritization', () => {
  assert.match(instructions, /If there is no grounded choice, ask a natural clarifying question instead of inventing priorities/);
  assert.match(instructions, /Do not pretend to know personal information the user has not provided/);
});

test('evaluation: conversational recommendations add no ranking or orchestration tool', () => {
  assert.match(instructions, /conversational judgment, not a new ranking or orchestration system/);
  assert.deepEqual(
    ASSISTANT_TOOL_CONTRACTS.filter(({ name }) => /rank|priorit|orchestrat/i.test(name)),
    [],
  );
});

test('evaluation: getting-healthy thought opens conversation instead of triggering a plan dump', () => {
  assert.match(instructions, /“I’m thinking of getting healthy” is an opening, not a request for a health plan/);
  assert.match(instructions, /Curiosity or brief reflection is usually better than immediately giving a plan/);
});

test('evaluation: an Etsy possibility remains casual context with no action or write', () => {
  assert.match(instructions, /“I might work on Etsy later” is conversation, not an action request/);
  assert.match(instructions, /do not turn it into a task, reminder, plan, or persisted update/);
});

test('evaluation: a descriptive clothing-brand reference triggers bounded Project identity retrieval', () => {
  const listProjects = ASSISTANT_TOOL_CONTRACTS.find(({ name }) => name === 'list_projects');
  assert.match(instructions, /the clothing brand I.m working on/);
  assert.match(instructions, /compare the bounded Project identities by name, type, description, goal, status, and recency/);
  assert.match(listProjects.openAI.description, /descriptive reference such as .*the clothing brand/);
});

test('evaluation: two plausible saved matches cause natural clarification rather than a guess', () => {
  assert.match(instructions, /If multiple Projects are genuinely plausible, ask one natural clarification/);
  assert.match(instructions, /do not guess or load every Project’s detailed history/);
});

test('evaluation: a standalone social question does not trigger saved-context retrieval', () => {
  const listProjects = ASSISTANT_TOOL_CONTRACTS.find(({ name }) => name === 'list_projects');
  assert.match(instructions, /Do not retrieve saved context for ordinary standalone or general-knowledge questions/);
  assert.match(listProjects.openAI.description, /standalone factual, social, calendar-only, and unrelated questions/);
});

test('evaluation: a prior linen decision is eligible for selective saved-context lookup', () => {
  assert.match(instructions, /Use read tools when Project-specific facts.*decisions.*are needed for the answer/);
  assert.match(instructions, /Treat current Project tool results as authoritative/);
});

test('evaluation: saying we talked before causes retrieval before repetition is requested', () => {
  assert.match(instructions, /we talked about this before/);
  assert.match(instructions, /Do not say you cannot browse old chats/);
});

test('evaluation: retrieved context is synthesized without exposing storage mechanics', () => {
  assert.match(instructions, /Keep tool use invisible/);
  assert.match(instructions, /If exactly one listed Project is a clear plausible match.*answer using it/);
  assert.match(instructions, /without asking the user to understand Tina’s storage structure/);
});

test('evaluation: a standalone factual question remains on the direct answer path', () => {
  assert.match(instructions, /Respond to the user’s immediate thought, question, or request first/);
  assert.match(instructions, /Use tools only when their data is needed for the current request/);
});

test('evaluation: contextual retrieval is read-only and cannot create Project truth', () => {
  assert.match(instructions, /Context retrieval is read-only/);
  assert.match(instructions, /Never create or change a Project, task, decision, knowledge item, or other truth/);
});

test('evaluation: mixed-intent messages are not forced through a rigid classifier', () => {
  assert.match(instructions, /A turn may be .* or a mixture/);
  assert.match(instructions, /flexible signals, not rigid modes/);
});

test('evaluation: playful questions allow natural guesses without invented memory', () => {
  assert.match(instructions, /For harmless playful or social questions, respond naturally and you may play along/);
  assert.match(instructions, /Clearly frame guesses as guesses/);
  assert.match(instructions, /do not invent a remembered personal fact/);
});
