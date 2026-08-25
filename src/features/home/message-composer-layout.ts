export const MESSAGE_INPUT_MIN_HEIGHT = 39;
export const MESSAGE_INPUT_MAX_HEIGHT = 108;

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
