import type { CompletedConversation } from '../../domain/conversations';

export type ChatGroup = {
  conversations: CompletedConversation[];
  title: string;
};

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function localCalendarDayDifference(date: Date, now: Date) {
  const milliseconds = startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime();
  return Math.round(milliseconds / 86_400_000);
}

export function chatGroupTitle(completedAt: string, now = new Date()) {
  const date = new Date(completedAt);
  const difference = localCalendarDayDifference(date, now);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  if (difference >= 2 && difference <= 6) return 'Earlier this week';
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

export function groupChats(conversations: CompletedConversation[], now = new Date()): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const conversation of conversations) {
    const title = chatGroupTitle(conversation.completedAt, now);
    const current = groups[groups.length - 1];
    if (current?.title === title) current.conversations.push(conversation);
    else groups.push({ conversations: [conversation], title });
  }
  return groups;
}

export function chatMetadata(conversation: CompletedConversation) {
  const date = new Date(conversation.completedAt);
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  const messages = `${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`;
  return `${day} · ${time} · ${messages}`;
}
