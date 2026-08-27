import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
  isCompleteAssistantToolStep,
  isPendingAssistantToolStep,
  MAX_ASSISTANT_TOOL_STEPS,
} from '@/contracts/assistant';
import type {
  AssistantApiRequest,
  AssistantErrorCode,
  AssistantToolCall,
  AssistantToolOutput,
  AssistantToolStep,
} from '@/contracts/assistant';
import { authService } from '@/services/auth';

import { executeAssistantClientTool } from './assistant-client-tool-executor';
import type { AssistantProvider } from './assistant-types';

declare const process: {
  env: Record<string, string | undefined>;
};

type AssistantApiErrorBody = {
  code?: unknown;
};

type AssistantClientToolExecutor = (
  call: AssistantToolCall,
) => Promise<AssistantToolOutput>;
type AccessTokenProvider = () => Promise<string | null>;

const DEFAULT_ASSISTANT_API_URL =
  'https://personal-assistant-app-ten.vercel.app/api/assistant';
const ASSISTANT_API_URL =
  process.env.EXPO_PUBLIC_ASSISTANT_API_URL ?? DEFAULT_ASSISTANT_API_URL;
const ERROR_MESSAGES: Record<AssistantErrorCode, string> = {
  assistant_unavailable: 'The assistant could not respond. Please try again.',
  authentication_required: 'Please sign in again to continue.',
  invalid_request: 'The assistant request was invalid.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  request_too_large: 'That conversation is too large to send.',
};

function isAssistantErrorCode(value: unknown): value is AssistantErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value);
}

function getErrorCode(response: Response, body: AssistantApiErrorBody): AssistantErrorCode {
  if (response.status === 429) {
    return 'rate_limited';
  }

  if (response.status === 413) {
    return 'request_too_large';
  }

  if (isAssistantErrorCode(body.code)) {
    return body.code;
  }

  return response.status === 400 ? 'invalid_request' : 'assistant_unavailable';
}

export class AssistantApiClientError extends Error {
  readonly code: AssistantErrorCode;

  constructor(code: AssistantErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'AssistantApiClientError';
  }
}

async function postAssistantRequest(
  request: AssistantApiRequest,
  signal: AbortSignal,
  fetchImplementation: typeof fetch,
  getAccessToken: AccessTokenProvider,
) {
  const accessToken = await getAccessToken();

  if (!accessToken) {
    throw new AssistantApiClientError('authentication_required');
  }

  const response = await fetchImplementation(ASSISTANT_API_URL, {
    body: JSON.stringify(request),
    headers: {
      [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as unknown;

  if (!response.ok) {
    throw new AssistantApiClientError(
      getErrorCode(response, body as AssistantApiErrorBody),
    );
  }

  return body;
}

function getCompletedContent(body: unknown) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const response = body as { content?: unknown; status?: unknown };
  return response.status === 'completed' &&
    typeof response.content === 'string' &&
    response.content.trim()
    ? response.content.trim()
    : null;
}

function getClientToolRequest(body: unknown) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const response = body as {
    completedToolSteps?: unknown;
    pendingToolStep?: unknown;
    status?: unknown;
  };

  if (
    response.status !== 'requires_client_tools' ||
    !Array.isArray(response.completedToolSteps) ||
    !response.completedToolSteps.every(isCompleteAssistantToolStep) ||
    !isPendingAssistantToolStep(response.pendingToolStep)
  ) {
    return null;
  }

  return {
    completedToolSteps: response.completedToolSteps,
    pendingToolStep: response.pendingToolStep,
  };
}

async function completeClientToolStep(
  pendingStep: AssistantToolStep,
  executeTool: AssistantClientToolExecutor,
) {
  const completedCallIds = new Set(
    pendingStep.outputs.map((output) => output.callId),
  );
  const clientCalls = pendingStep.calls.filter(
    (call) => call.execution === 'client' && !completedCallIds.has(call.callId),
  );

  if (clientCalls.length < 1) {
    throw new AssistantApiClientError('assistant_unavailable');
  }

  const clientOutputs = await Promise.all(clientCalls.map(executeTool));
  const completedStep: AssistantToolStep = {
    calls: pendingStep.calls,
    outputs: [...pendingStep.outputs, ...clientOutputs],
  };

  if (!isCompleteAssistantToolStep(completedStep)) {
    throw new AssistantApiClientError('assistant_unavailable');
  }

  return completedStep;
}

export function createAssistantApiClient(
  fetchImplementation?: typeof fetch,
  executeTool: AssistantClientToolExecutor = executeAssistantClientTool,
  getAccessToken: AccessTokenProvider = () => authService.getAccessToken(),
): AssistantProvider {
  return async (request, signal) => {
    const requestFetch = fetchImplementation ?? fetch;
    const completedSteps: AssistantToolStep[] = [];

    while (true) {
      const body = await postAssistantRequest(
        {
          ...request,
          ...(completedSteps.length > 0
            ? { toolContinuation: { steps: completedSteps } }
            : {}),
        },
        signal,
        requestFetch,
        getAccessToken,
      );
      const content = getCompletedContent(body);

      if (content) {
        return content;
      }

      const toolRequest = getClientToolRequest(body);

      if (!toolRequest) {
        throw new AssistantApiClientError('assistant_unavailable');
      }

      const nextStepCount =
        completedSteps.length + toolRequest.completedToolSteps.length + 1;

      if (nextStepCount > MAX_ASSISTANT_TOOL_STEPS) {
        throw new AssistantApiClientError('assistant_unavailable');
      }

      completedSteps.push(...toolRequest.completedToolSteps);
      completedSteps.push(
        await completeClientToolStep(toolRequest.pendingToolStep, executeTool),
      );
    }
  };
}

export const assistantApiClient = createAssistantApiClient();
