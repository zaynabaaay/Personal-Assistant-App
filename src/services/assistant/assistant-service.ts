import { createAssistantContext } from './assistant-context';
import { AssistantApiClientError, assistantApiClient } from './assistant-api-client';
import type {
  AssistantErrorCode,
  AssistantMessage,
  AssistantProvider,
  AssistantRequest,
  AssistantResult,
} from './assistant-types';

export type {
  AssistantErrorCode,
  AssistantMessage,
  AssistantProvider,
  AssistantRequest,
  AssistantResult,
} from './assistant-types';

let nextSessionNumber = 1;

function createSessionId() {
  return `assistant-session-${nextSessionNumber++}`;
}

export class AssistantService {
  private activeController: AbortController | null = null;
  private readonly provider: AssistantProvider;
  private sessionId = createSessionId();

  constructor(provider: AssistantProvider = assistantApiClient) {
    this.provider = provider;
  }

  cancelRequest() {
    this.activeController?.abort();
    this.activeController = null;
  }

  resetSession() {
    this.cancelRequest();
    this.sessionId = createSessionId();
  }

  async respond(messages: readonly AssistantMessage[]): Promise<AssistantResult> {
    this.cancelRequest();

    const controller = new AbortController();
    const sessionId = this.sessionId;
    const request: AssistantRequest = {
      context: createAssistantContext(),
      messages: messages.map((message) => ({ ...message })),
      sessionId,
    };

    this.activeController = controller;

    try {
      const content = await this.provider(request, controller.signal);

      if (controller.signal.aborted) {
        return { sessionId, status: 'cancelled' };
      }

      return {
        message: { content, role: 'assistant' },
        sessionId,
        status: 'success',
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { sessionId, status: 'cancelled' };
      }

      return {
        error: {
          code:
            error instanceof AssistantApiClientError
              ? error.code
              : ('assistant_unavailable' satisfies AssistantErrorCode),
          message:
            error instanceof AssistantApiClientError
              ? error.message
              : 'The assistant could not respond. Please try again.',
        },
        sessionId,
        status: 'error',
      };
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }
}

export const assistantService = new AssistantService();
