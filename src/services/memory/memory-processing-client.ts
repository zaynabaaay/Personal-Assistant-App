import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '@/contracts/assistant';
import { authService } from '@/services/auth';

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_URL = 'https://personal-assistant-app-ten.vercel.app/api/process-memory';
const MEMORY_URL = process.env.EXPO_PUBLIC_MEMORY_PROCESSING_API_URL ?? DEFAULT_URL;
const TIMEOUT_MS = 30_000;
const MAX_DRAIN_REQUESTS = 32;
const MAX_TRANSIENT_FAILURES = 3;

export async function processConversationMemory(conversationId?: string) {
  const accessToken = await authService.getAccessToken();
  if (!accessToken) throw new Error('Authentication is required.');

  let transientFailures = 0;
  for (let attempt = 0; attempt < MAX_DRAIN_REQUESTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(MEMORY_URL, {
        body: JSON.stringify(conversationId ? { conversationId } : {}),
        headers: {
          [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as { status?: unknown };
      if (response.ok && body.status === 'processed') return { status: 'processed' as const };
      if (response.status === 202 && body.status === 'partial') {
        transientFailures = 0;
        continue;
      }
      if (response.status === 202 && body.status === 'processing') {
        return { status: 'processing' as const };
      }
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_FAILURES) {
        throw new Error('Memory processing failed.');
      }
      continue;
    } catch (error) {
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_FAILURES) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { status: 'processing' as const };
}

export const MEMORY_DRAIN_LIMITS = {
  requests: MAX_DRAIN_REQUESTS,
  transientFailures: MAX_TRANSIENT_FAILURES,
};
