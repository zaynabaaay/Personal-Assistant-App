import type { AssistantContext } from './assistant-context';

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
