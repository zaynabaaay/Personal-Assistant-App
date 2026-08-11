import { createAssistantContext, type AssistantContext } from './assistant-context';

export type AssistantMessage = {
  content: string;
  role: 'user' | 'assistant';
};

export type AssistantRequest = {
  context: AssistantContext;
  messages: readonly AssistantMessage[];
  sessionId: string;
};

export type AssistantResult =
  | {
      message: AssistantMessage;
      sessionId: string;
      status: 'success';
    }
  | {
      error: {
        code: 'provider_error';
        message: string;
      };
      sessionId: string;
      status: 'error';
    }
  | {
      sessionId: string;
      status: 'cancelled';
    };

export type AssistantProvider = (
  request: AssistantRequest,
  signal: AbortSignal,
) => Promise<string>;

const PLACEHOLDER_RESPONSE = 'Assistant response will appear here.';

let nextSessionNumber = 1;

function createSessionId() {
  return `assistant-session-${nextSessionNumber++}`;
}

const placeholderProvider: AssistantProvider = async (_request, signal) => {
  await Promise.resolve();

  if (signal.aborted) {
    throw new Error('Assistant request cancelled.');
  }

  return PLACEHOLDER_RESPONSE;
};

export class AssistantService {
  private activeController: AbortController | null = null;
  private sessionId = createSessionId();

  constructor(private readonly provider: AssistantProvider = placeholderProvider) {}

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
