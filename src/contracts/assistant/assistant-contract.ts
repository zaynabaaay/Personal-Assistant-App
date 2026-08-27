import type { AssistantToolContinuation, AssistantToolStep } from './tool-contract';

export const ASSISTANT_CLIENT_HEADER = 'X-Personal-Assistant-Client';
export const ASSISTANT_CLIENT_ID = 'personal-assistant-app-v1';

export type AssistantContext = {
  currentLocalDate: string;
  currentLocalTime: string;
  dayOfWeek: string;
  timezone: string;
};

export type AssistantMessage = {
  content: string;
  role: 'user' | 'assistant';
};

export type AssistantRequest = {
  context: AssistantContext;
  messages: readonly AssistantMessage[];
  projectScope?: {
    projectId: string;
    projectName: string;
  };
  sessionId: string;
};

export type AssistantApiRequest = AssistantRequest & {
  toolContinuation?: AssistantToolContinuation;
};

export type AssistantErrorCode =
  | 'assistant_unavailable'
  | 'authentication_required'
  | 'invalid_request'
  | 'rate_limited'
  | 'request_too_large';

export type AssistantApiResponse =
  | { content: string; status: 'completed' }
  | {
      completedToolSteps: AssistantToolStep[];
      pendingToolStep: AssistantToolStep;
      status: 'requires_client_tools';
    }
  | { code: AssistantErrorCode; error: string; status?: 'error' };
