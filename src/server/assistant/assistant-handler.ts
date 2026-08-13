import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
  isAssistantToolOutput,
  MAX_ASSISTANT_TOOL_STEPS,
} from '../../contracts/assistant';
import type {
  AssistantErrorCode,
  AssistantToolCall,
  AssistantToolOutput,
  AssistantToolStep,
} from '../../contracts/assistant';
import {
  OpenAIAssistantProviderError,
  requestOpenAIAssistant,
} from './openai-assistant-provider';
import {
  ASSISTANT_REQUEST_LIMITS,
  parseAssistantJsonBody,
} from './request-validation';
import {
  executeAssistantServerTool,
  type AssistantServerToolExecutor,
} from './server-tool-executor';
import type { AccessTokenVerifier } from '../auth/authenticated-user';
import {
  createSupabaseAccessTokenVerifier,
  InvalidAccessTokenError,
  SupabaseAuthUnavailableError,
} from '../auth/supabase-token-verifier';

declare const process: {
  env: Record<string, string | undefined>;
};

const DEFAULT_MODEL = 'gpt-5.4-mini';
const defaultVerifyAccessToken = createSupabaseAccessTokenVerifier();

export type AssistantHandlerOptions = {
  allowedOrigin?: string;
  apiKey?: string;
  executeServerTool?: AssistantServerToolExecutor;
  fetchImplementation?: typeof fetch;
  model?: string;
  verifyAccessToken?: AccessTokenVerifier;
};

export { ASSISTANT_REQUEST_LIMITS };

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function corsHeaders(origin: string) {
  return {
    ...securityHeaders(),
    'Access-Control-Allow-Headers': `Authorization, Content-Type, ${ASSISTANT_CLIENT_HEADER}`,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(body: unknown, status: number, origin?: string) {
  return new Response(JSON.stringify(body), {
    headers: origin ? corsHeaders(origin) : securityHeaders(),
    status,
  });
}

function errorResponse(
  code: AssistantErrorCode,
  error: string,
  status: number,
  origin?: string,
) {
  return jsonResponse({ code, error }, status, origin);
}

function normalizeOrigin(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function outputMatchesCall(
  output: AssistantToolOutput,
  call: AssistantToolCall,
) {
  return (
    output.callId === call.callId &&
    output.execution === call.execution &&
    output.name === call.name
  );
}

async function executeServerCalls(
  calls: readonly AssistantToolCall[],
  executor: AssistantServerToolExecutor,
  accessToken: string,
  userId: string,
) {
  const outputs = await Promise.all(
    calls.map((call) => executor(call, { accessToken, userId })),
  );

  if (
    !outputs.every(isAssistantToolOutput) ||
    !outputs.every((output, index) => outputMatchesCall(output, calls[index]))
  ) {
    throw new Error('A server assistant tool returned an invalid output.');
  }

  return outputs;
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get('Authorization');

  if (!authorization) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

export async function handleAssistantRequest(
  request: Request,
  options: AssistantHandlerOptions = {},
) {
  const allowedOrigin = normalizeOrigin(options.allowedOrigin ?? process.env.ALLOWED_ORIGIN);
  const rawRequestOrigin = request.headers.get('Origin');
  const requestOrigin = normalizeOrigin(rawRequestOrigin);

  if (!allowedOrigin) {
    return errorResponse('assistant_unavailable', 'The assistant is unavailable.', 500);
  }

  const isAllowedBrowserRequest = requestOrigin === allowedOrigin;
  const isAllowedNativeRequest =
    rawRequestOrigin === null &&
    request.headers.get(ASSISTANT_CLIENT_HEADER) === ASSISTANT_CLIENT_ID;

  if (!isAllowedBrowserRequest && !isAllowedNativeRequest) {
    return errorResponse('invalid_request', 'The assistant request was rejected.', 403);
  }

  const responseOrigin = isAllowedBrowserRequest ? allowedOrigin : undefined;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(allowedOrigin), status: 204 });
  }

  if (request.method !== 'POST') {
    return errorResponse(
      'invalid_request',
      'The assistant request was rejected.',
      405,
      responseOrigin,
    );
  }

  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return errorResponse(
      'authentication_required',
      'Authentication is required.',
      401,
      responseOrigin,
    );
  }

  let authenticatedUser;

  try {
    authenticatedUser = await (
      options.verifyAccessToken ?? defaultVerifyAccessToken
    )(accessToken);
  } catch (error) {
    if (error instanceof SupabaseAuthUnavailableError) {
      console.error('Supabase authentication is not configured.');
      return errorResponse(
        'assistant_unavailable',
        'The assistant is unavailable.',
        500,
        responseOrigin,
      );
    }

    if (!(error instanceof InvalidAccessTokenError)) {
      console.error('Supabase access-token verification failed.');
    }

    return errorResponse(
      'authentication_required',
      'Authentication is required.',
      401,
      responseOrigin,
    );
  }

  const parsedBody = await parseAssistantJsonBody(request);

  if (parsedBody.status !== 'success') {
    return parsedBody.status === 'too_large'
      ? errorResponse(
          'request_too_large',
          'The assistant request is too large.',
          413,
          responseOrigin,
        )
      : errorResponse(
          'invalid_request',
          'The assistant request was invalid.',
          400,
          responseOrigin,
        );
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return errorResponse(
      'assistant_unavailable',
      'The assistant is unavailable.',
      500,
      responseOrigin,
    );
  }

  const body = parsedBody.body;
  const steps: AssistantToolStep[] = [...(body.toolContinuation?.steps ?? [])];
  const completedServerSteps: AssistantToolStep[] = [];
  const executeServerTool = options.executeServerTool ?? executeAssistantServerTool;

  try {
    while (true) {
      const modelResult = await requestOpenAIAssistant(body, steps, {
        apiKey,
        fetchImplementation: options.fetchImplementation ?? fetch,
        model: options.model ?? DEFAULT_MODEL,
        signal: request.signal,
      });

      if (modelResult.status === 'completed') {
        return jsonResponse(
          { content: modelResult.content, status: 'completed' },
          200,
          responseOrigin,
        );
      }

      if (steps.length >= MAX_ASSISTANT_TOOL_STEPS) {
        console.error('Assistant tool loop reached its configured step limit.');
        return errorResponse(
          'assistant_unavailable',
          'The assistant could not respond.',
          502,
          responseOrigin,
        );
      }

      const serverCalls = modelResult.toolCalls.filter(
        (call) => call.execution === 'server',
      );
      const clientCalls = modelResult.toolCalls.filter(
        (call) => call.execution === 'client',
      );
      const serverOutputs = await executeServerCalls(
        serverCalls,
        executeServerTool,
        accessToken,
        authenticatedUser.id,
      );
      const step: AssistantToolStep = {
        calls: modelResult.toolCalls,
        outputs: serverOutputs,
      };

      if (clientCalls.length > 0) {
        return jsonResponse(
          {
            completedToolSteps: completedServerSteps,
            pendingToolStep: step,
            status: 'requires_client_tools',
          },
          200,
          responseOrigin,
        );
      }

      steps.push(step);
      completedServerSteps.push(step);
    }
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(
        'assistant_unavailable',
        'The assistant request was cancelled.',
        499,
        responseOrigin,
      );
    }

    if (error instanceof OpenAIAssistantProviderError) {
      console.error('OpenAI request failed.', {
        message: error.message,
        requestId: error.requestId,
        status: error.status,
      });
    } else {
      console.error('Assistant server request failed.', error);
    }

    return errorResponse(
      'assistant_unavailable',
      'The assistant could not respond.',
      502,
      responseOrigin,
    );
  }
}
