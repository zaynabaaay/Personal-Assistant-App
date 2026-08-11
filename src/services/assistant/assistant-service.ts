import { createAssistantContext } from './assistant-context';
import { openAIProvider } from './openai-provider';
import type {
  AssistantMessage,
  AssistantProvider,
  AssistantRequest,
  AssistantResult,
} from './assistant-types';

export type {
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
  private sessionId = createSessionId();

  constructor(private readonly provider: AssistantProvider = openAIProvider) {}

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
          code: 'provider_error',
          message: error instanceof Error ? error.message : 'The assistant request failed.',
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
