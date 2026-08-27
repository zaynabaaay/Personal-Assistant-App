import type {
  ProjectKnowledgeItem,
  ProjectWorkSessionEntry,
} from './project-types';

function compareDateThenId(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function selectCurrentAcceptedKnowledge(
  items: readonly ProjectKnowledgeItem[],
) {
  return items
    .filter((item) => item.status === 'current' && item.kind !== 'question')
    .sort(compareDateThenId);
}

export function selectUnresolvedQuestions(items: readonly ProjectKnowledgeItem[]) {
  return items
    .filter((item) => item.status === 'current' && item.kind === 'question')
    .sort(compareDateThenId);
}

export function orderWorkSessionEntries(
  entries: readonly ProjectWorkSessionEntry[],
) {
  return [...entries].sort(
    (left, right) =>
      left.position - right.position ||
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
}

