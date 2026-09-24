import {
  isCompleteAssistantToolStep,
  MAX_ASSISTANT_TOOL_STEPS,
} from '../../contracts/assistant';
import type {
  AssistantApiRequest,
  AssistantMessage,
} from '../../contracts/assistant';

const MAX_REQUEST_BODY_BYTES = 48 * 1024;
const MAX_MESSAGE_COUNT = 50;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_TOTAL_MESSAGE_LENGTH = 30_000;
const MAX_CONTEXT_VALUE_LENGTH = 100;
const MAX_SESSION_ID_LENGTH = 100;
const MAX_PROJECT_ID_LENGTH = 200;

export const ASSISTANT_REQUEST_LIMITS = {
  bodyBytes: MAX_REQUEST_BODY_BYTES,
  messageCount: MAX_MESSAGE_COUNT,
  messageLength: MAX_MESSAGE_LENGTH,
  totalMessageLength: MAX_TOTAL_MESSAGE_LENGTH,
} as const;

export type ParsedAssistantBody =
  | { body: AssistantApiRequest; status: 'success' }
  | { status: 'invalid' | 'too_large' };

function isBoundedString(
  value: unknown,
  maxLength = MAX_CONTEXT_VALUE_LENGTH,
): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Partial<AssistantMessage>;
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.length > 0 &&
    message.content.length <= MAX_MESSAGE_LENGTH
  );
}

export function isAssistantApiRequest(value: unknown): value is AssistantApiRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const request = value as Partial<AssistantApiRequest>;
  const context = request.context;

  if (
    !context ||
    !isBoundedString(context.currentLocalDate) ||
    !isBoundedString(context.currentLocalTime) ||
    !isBoundedString(context.dayOfWeek) ||
    !isBoundedString(context.timezone) ||
    !isBoundedString(request.sessionId, MAX_SESSION_ID_LENGTH) ||
    !Array.isArray(request.messages) ||
    request.messages.length < 1 ||
    request.messages.length > MAX_MESSAGE_COUNT ||
    !request.messages.every(isAssistantMessage) ||
    request.messages.reduce((total, message) => total + message.content.length, 0) >
      MAX_TOTAL_MESSAGE_LENGTH
  ) {
    return false;
  }

  if (
    request.projectScope !== undefined &&
    (!request.projectScope ||
      typeof request.projectScope !== 'object' ||
      !isBoundedString(request.projectScope.projectId, MAX_PROJECT_ID_LENGTH) ||
      !isBoundedString(request.projectScope.projectName, 300))
  ) return false;

  if (request.toolContinuation === undefined) {
    return true;
  }

  return (
    !!request.toolContinuation &&
    Array.isArray(request.toolContinuation.steps) &&
    request.toolContinuation.steps.length > 0 &&
    request.toolContinuation.steps.length <= MAX_ASSISTANT_TOOL_STEPS &&
    request.toolContinuation.steps.every(isCompleteAssistantToolStep)
  );
}

export async function parseAssistantJsonBody(
  request: Request,
): Promise<ParsedAssistantBody> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return { status: 'invalid' };
  }

  const declaredLength = Number(request.headers.get('Content-Length'));

  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return { status: 'too_large' };
  }

  if (!request.body) {
    return { status: 'invalid' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: 'too_large' };
      }

      chunks.push(value);
    }
  } catch {
    return { status: 'invalid' };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;

    return isAssistantApiRequest(body)
      ? { body, status: 'success' }
      : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}
