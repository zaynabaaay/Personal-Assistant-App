import type { AssistantProvider } from './assistant-types';

declare const process: {
  env: Record<string, string | undefined>;
};

type AssistantApiResponse = {
  content?: unknown;
  error?: unknown;
};

const ASSISTANT_API_URL = process.env.EXPO_PUBLIC_ASSISTANT_API_URL;

function getErrorMessage(response: AssistantApiResponse) {
  return typeof response.error === 'string'
    ? response.error
    : 'The assistant request failed.';
}

export const openAIProvider: AssistantProvider = async (request, signal) => {
  if (!ASSISTANT_API_URL) {
    throw new Error('The assistant service is not configured.');
  }

  const response = await fetch(ASSISTANT_API_URL, {
    body: JSON.stringify(request),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as AssistantApiResponse;

  if (!response.ok) {
    throw new Error(getErrorMessage(body));
  }

  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw new Error('The assistant returned an empty response.');
  }

  return body.content.trim();
};
