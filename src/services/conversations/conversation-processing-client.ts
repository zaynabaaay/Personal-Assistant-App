import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '@/contracts/assistant';
import { authService } from '@/services/auth';

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_URL =
  'https://personal-assistant-app-ten.vercel.app/api/process-conversation';
const PROCESSING_URL = process.env.EXPO_PUBLIC_CONVERSATION_PROCESSING_API_URL ?? DEFAULT_URL;
const PROCESSING_TIMEOUT_MS = 30_000;

export async function processCompletedConversation(conversationId: string) {
  const accessToken = await authService.getAccessToken();
  if (!accessToken) throw new Error('Authentication is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROCESSING_TIMEOUT_MS);

  try {
    const response = await fetch(PROCESSING_URL, {
      body: JSON.stringify({ conversationId }),
      headers: {
        [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as {
      projectCount?: unknown;
      status?: unknown;
    };

    if (response.status === 202 && body.status === 'processing') {
      return { status: 'processing' as const };
    }
    if (!response.ok || !['processed', 'already_processed'].includes(String(body.status))) {
      throw new Error('Conversation Project processing failed.');
    }
    return {
      projectCount: typeof body.projectCount === 'number' ? body.projectCount : 0,
      status: body.status as 'processed' | 'already_processed',
    };
  } finally {
    clearTimeout(timeout);
  }
}
