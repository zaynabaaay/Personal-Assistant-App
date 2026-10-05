import type {
  AssistantErrorCode,
  AssistantMessage,
  AssistantRequest,
} from '@/contracts/assistant';

export type {
  AssistantErrorCode,
  AssistantMessage,
  AssistantRequest,
} from '@/contracts/assistant';

export type AssistantResult =
  | {
      message: AssistantMessage;
      sessionId: string;
      status: 'success';
    }
  | {
      error: {
        code: AssistantErrorCode;
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
