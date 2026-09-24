export const MESSAGE_INPUT_MIN_HEIGHT = 39;
export const MESSAGE_INPUT_MAX_HEIGHT = 108;

export type MessageSendAvailability = {
  isFinishing: boolean;
  isResponding: boolean;
  isRestoring: boolean;
  isSavingMessage: boolean;
};

export function messageInputHeight(contentHeight: number) {
  if (!Number.isFinite(contentHeight)) return MESSAGE_INPUT_MIN_HEIGHT;
  return Math.min(
    MESSAGE_INPUT_MAX_HEIGHT,
    Math.max(MESSAGE_INPUT_MIN_HEIGHT, Math.ceil(contentHeight)),
  );
}

export function messageInputScrollEnabled(height: number) {
  return height >= MESSAGE_INPUT_MAX_HEIGHT;
}

export function messageSendEnabled(draft: string, state: MessageSendAvailability) {
  return draft.trim().length > 0 && !state.isResponding && !state.isFinishing &&
    !state.isRestoring && !state.isSavingMessage;
}
