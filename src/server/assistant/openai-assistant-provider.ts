import {
  ASSISTANT_TOOL_CONTRACTS,
  getAssistantToolContract,
} from '../../contracts/assistant';
import type {
  AssistantApiRequest,
  AssistantRequest,
  AssistantToolCall,
  AssistantToolStep,
} from '../../contracts/assistant';

type OpenAIResponse = {
  error?: {
    message?: unknown;
  };
  output?: {
    arguments?: unknown;
    call_id?: unknown;
    content?: {
      text?: unknown;
      type?: unknown;
    }[];
    name?: unknown;
    type?: unknown;
  }[];
};

export type AssistantModelResult =
  | { content: string; status: 'completed' }
  | { status: 'tool_calls'; toolCalls: AssistantToolCall[] };

export type OpenAIAssistantProviderOptions = {
  apiKey: string;
  fetchImplementation: typeof fetch;
  model: string;
  signal: AbortSignal;
};

export class OpenAIAssistantProviderError extends Error {
  readonly requestId: string | null;
  readonly status: number;

  constructor(message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'OpenAIAssistantProviderError';
    this.requestId = requestId;
    this.status = status;
  }
}

function createInstructions(request: AssistantRequest) {
  const { context } = request;

  return [
    'You are a personal life assistant.',
    'Be conversational and concise by default.',
    'Do not pretend to know personal information the user has not provided.',
    'When you do not have enough information, say so naturally.',
    'Treat the following app-supplied current context as authoritative:',
    `Local date: ${context.currentLocalDate}`,
    `Local time: ${context.currentLocalTime}`,
    `Weekday: ${context.dayOfWeek}`,
    `Timezone: ${context.timezone}`,
    'Tools provide factual application data and may execute on the client or server.',
    'Use tools only when their data is needed for the current request.',
    'Project tools read and, only when explicitly requested, update the authenticated user’s persistent Projects.',
    'Use read tools for Project-specific facts, progress, remaining work, decisions, knowledge, unresolved questions, resources, or recent work.',
    'Use list_projects to identify a Project when needed, then request the smallest relevant focus from get_project_context.',
    'Treat current Project tool results as authoritative. Do not treat superseded knowledge or decisions as current truth.',
    'Project work-session results contain summaries and metadata only. Never claim to have read raw transcripts.',
    'Use Project write tools only for a clear user instruction to create or change Project data. Do not infer writes from ordinary discussion, answers, summaries, or recommendations.',
    'Before writing to an existing Project, resolve the exact Project and entity with read tools when the conversation does not already make their IDs unambiguous.',
    'Resolve references such as “that task” only when exactly one retrieved or conversational entity is plausible. If multiple Projects or entities are plausible, ask a concise clarification question and do not write.',
    'Check the relevant current Project context before adding tasks, milestones, deliverables, knowledge, questions, or decisions when a duplicate or existing truth may already exist.',
    'Clear operational commands may be saved directly: creating a named Project, adding a specified task, setting a stated deadline, or completing an unambiguous task.',
    'A direct statement such as “we decided” or “save this decision” is explicit and may be recorded. Brainstorming, maybe, perhaps, thinking about, what-if, possible, tentative, and exploratory language is not confirmed truth and must not be written.',
    'Replacing a current decision or accepted knowledge requires explicit confirmation. If the user is reconsidering or exploratory, ask whether they want the new statement saved as the replacement; call the replacement tool only after they confirm.',
    'Never guess a replacement entity ID. A successful unchanged result means the information already existed; explain that naturally without claiming a duplicate was added.',
    'After a successful write, state briefly what changed. If a tool requests clarification or confirmation, ask the user instead of implying the write happened.',
    'When writes depend on earlier reads or writes, perform them in separate tool steps so each result is available before the next change.',
    'You may recommend a next step from existing Project data, but never designate or persist a next action unless the user explicitly asks for a supported Project update.',
    'Calendar tools read factual application data from the user’s device.',
    'Never invent calendar events or availability.',
    'Treat returned calendar results as authoritative and do not claim access when a tool says it is unavailable or denied.',
    'If device calendar access is unavailable, explain naturally that it is available in the native app.',
    'Do not ask for event locations unless location is necessary for the answer.',
  ].join('\n');
}

function createOpenAIInput(
  request: AssistantApiRequest,
  steps: readonly AssistantToolStep[],
) {
  const input: unknown[] = request.messages.map((message) => ({
    content: message.content,
    role: message.role,
  }));

  for (const step of steps) {
    for (const call of step.calls) {
      input.push({
        arguments: JSON.stringify(call.arguments),
        call_id: call.callId,
        name: call.name,
        type: 'function_call',
      });
    }

    for (const output of step.outputs) {
      input.push({
        call_id: output.callId,
        output: JSON.stringify(output.result),
        type: 'function_call_output',
      });
    }
  }

  return input;
}

function extractOutputText(response: OpenAIResponse) {
  return (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text as string)
    .join('\n')
    .trim();
}

function extractToolCalls(response: OpenAIResponse): AssistantToolCall[] | null {
  const rawCalls = (response.output ?? []).filter(
    (item) => item.type === 'function_call',
  );

  if (rawCalls.length === 0) {
    return [];
  }

  if (rawCalls.length > 4) {
    return null;
  }

  const calls: AssistantToolCall[] = [];

  for (const rawCall of rawCalls) {
    const contract = getAssistantToolContract(rawCall.name);

    if (
      !contract ||
      typeof rawCall.call_id !== 'string' ||
      rawCall.call_id.length < 1 ||
      rawCall.call_id.length > 100 ||
      typeof rawCall.arguments !== 'string'
    ) {
      return null;
    }

    let parsedArguments: unknown;

    try {
      parsedArguments = JSON.parse(rawCall.arguments) as unknown;
    } catch {
      return null;
    }

    if (!contract.isArguments(parsedArguments)) {
      return null;
    }

    calls.push({
      arguments: parsedArguments,
      callId: rawCall.call_id,
      execution: contract.execution,
      name: contract.name,
    });
  }

  return new Set(calls.map((call) => call.callId)).size === calls.length
    ? calls
    : null;
}

export async function requestOpenAIAssistant(
  request: AssistantApiRequest,
  steps: readonly AssistantToolStep[],
  options: OpenAIAssistantProviderOptions,
): Promise<AssistantModelResult> {
  const response = await options.fetchImplementation(
    'https://api.openai.com/v1/responses',
    {
      body: JSON.stringify({
        input: createOpenAIInput(request, steps),
        instructions: createInstructions(request),
        max_output_tokens: 600,
        model: options.model,
        reasoning: { effort: 'none' },
        store: false,
        text: { verbosity: 'low' },
        tool_choice: 'auto',
        tools: ASSISTANT_TOOL_CONTRACTS.map((contract) => ({
          ...contract.openAI,
          name: contract.name,
        })),
      }),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: options.signal,
    },
  );
  const body = (await response.json().catch(() => ({}))) as OpenAIResponse;
  const requestId = response.headers.get('x-request-id');

  if (!response.ok) {
    throw new OpenAIAssistantProviderError(
      typeof body.error?.message === 'string'
        ? body.error.message
        : 'OpenAI request failed.',
      response.status,
      requestId,
    );
  }

  const toolCalls = extractToolCalls(body);

  if (toolCalls === null) {
    throw new OpenAIAssistantProviderError(
      'OpenAI returned invalid tool calls.',
      502,
      requestId,
    );
  }

  if (toolCalls.length > 0) {
    return { status: 'tool_calls', toolCalls };
  }

  const content = extractOutputText(body);

  if (!content) {
    throw new OpenAIAssistantProviderError(
      'OpenAI returned no assistant text.',
      502,
      requestId,
    );
  }

  return { content, status: 'completed' };
}
