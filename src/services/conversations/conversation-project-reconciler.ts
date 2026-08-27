import type {
  ConversationProjectCandidate,
  ConversationProjectPlanItem,
  ConversationWithMessages,
  PendingProjectCandidate,
} from '../../domain/conversations';
import type {
  Project,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectKnowledgeItem,
  ProjectTask,
  ProjectWorkSession,
} from '../../domain/projects';
import type { ProjectRepositoryChanges } from '../projects/project-repository';
import type { ProjectCommitPrecondition } from './conversation-project-processing-repository';

import type { ConversationProjectSnapshot } from './conversation-project-analyzer';

export type ConversationProjectResult = {
  candidates: PendingProjectCandidate[];
  changes: ProjectRepositoryChanges;
  preconditions: ProjectCommitPrecondition[];
};

function normalizedIdentity(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

const OVERRIDE_LANGUAGE = /\b(actually|instead|final(?:ly)?|now|changed my mind|replacing|no longer)\b/i;

function candidateIdentity(candidate: ConversationProjectCandidate) {
  return normalizedIdentity(candidate.subjectKey ?? candidate.title ?? candidate.content);
}

function logicalTarget(candidate: ConversationProjectCandidate) {
  return [candidate.target, candidate.knowledgeKind ?? '', candidateIdentity(candidate)].join(':');
}

function resolveIntraPlanConflicts(
  conversation: ConversationWithMessages,
  candidates: readonly ConversationProjectCandidate[],
) {
  const positionById = new Map(conversation.messages.map((message) => [message.id, message.position]));
  const messageById = new Map(conversation.messages.map((message) => [message.id, message]));
  const groups = new Map<string, ConversationProjectCandidate[]>();
  for (const candidate of candidates) {
    const key = logicalTarget(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.values()].flatMap((group) => {
    const distinct = new Set(group.map((candidate) => normalizedIdentity(candidate.content)));
    if (group.length < 2 || distinct.size < 2) return group;
    const ordered = [...group].sort((left, right) => {
      const leftPosition = Math.max(-1, ...left.evidenceMessageIds.map((id) => positionById.get(id) ?? -1));
      const rightPosition = Math.max(-1, ...right.evidenceMessageIds.map((id) => positionById.get(id) ?? -1));
      return leftPosition - rightPosition;
    });
    const latest = ordered.at(-1)!;
    const latestEvidence = latest.evidenceMessageIds
      .map((id) => messageById.get(id))
      .filter((message) => message?.role === 'user')
      .map((message) => message?.content ?? '')
      .join(' ');
    if (OVERRIDE_LANGUAGE.test(latestEvidence)) return [latest];
    return group.map((candidate) => ({
      ...candidate,
      classification: 'ambiguous' as const,
      usefulPending: true,
    }));
  });
}

export function conversationProjectSessionId(conversationId: string, projectId: string) {
  return `conversation:${conversationId}:project:${projectId}:session`;
}

function derivedId(
  conversationId: string,
  projectId: string,
  kind: string,
  index: number,
) {
  return `conversation:${conversationId}:project:${projectId}:${kind}:${index}`;
}

function pendingCandidate(
  conversation: ConversationWithMessages,
  projectId: string,
  sessionId: string,
  candidate: ConversationProjectCandidate,
  index: number,
): PendingProjectCandidate {
  return {
    content: candidate.content.trim(),
    conversationId: conversation.conversation.id,
    createdAt: conversation.conversation.completedAt,
    id: derivedId(conversation.conversation.id, projectId, 'pending', index),
    projectId,
    sessionId,
    status: 'pending',
  };
}

function knowledgeChangeEvent(
  conversationId: string,
  projectId: string,
  sessionId: string,
  item: ProjectKnowledgeItem,
  index: number,
): ProjectChangeEvent {
  return {
    after: { status: item.status },
    entityId: item.id,
    entityType: 'knowledge',
    eventType: 'knowledge_accepted',
    id: derivedId(conversationId, projectId, 'knowledge-event', index),
    occurredAt: item.updatedAt,
    projectId,
    sourceSessionId: sessionId,
    summary: `Accepted project knowledge: ${item.title ?? item.content}`,
  };
}

function shouldRemainPending(candidate: ConversationProjectCandidate) {
  return candidate.usefulPending && (
    candidate.classification === 'brainstorming' ||
    candidate.classification === 'ambiguous' ||
    candidate.classification === 'clear_update'
  );
}

export function buildConversationProjectResult(input: {
  conversation: ConversationWithMessages;
  item: ConversationProjectPlanItem;
  project: Project;
  snapshot: ConversationProjectSnapshot;
}): ConversationProjectResult {
  const { conversation, item, project, snapshot } = input;
  const conversationId = conversation.conversation.id;
  const sessionId = conversationProjectSessionId(conversationId, project.id);
  const occurredAt = conversation.conversation.completedAt;
  const relevantMessages = item.relevantMessageIds
    .map((id) => conversation.messages.find((message) => message.id === id))
    .filter((message) => message !== undefined);
  const relevantTimes = relevantMessages.map((message) => Date.parse(message.occurredAt));
  const startedAt = relevantTimes.length > 0
    ? new Date(Math.min(...relevantTimes)).toISOString()
    : conversation.conversation.startedAt;
  const endedAt = relevantTimes.length > 0
    ? new Date(Math.max(...relevantTimes)).toISOString()
    : occurredAt;
  const session: ProjectWorkSession = {
    createdAt: occurredAt,
    endedAt,
    id: sessionId,
    projectId: project.id,
    sourceConversationId: conversationId,
    startedAt,
    summary: item.summary.trim(),
    title: item.title.trim(),
    updatedAt: occurredAt,
  };
  const changes: ProjectRepositoryChanges = { workSessions: [session] };
  const pending: PendingProjectCandidate[] = [];
  const preconditions: ProjectCommitPrecondition[] = [];
  const knowledge = [...snapshot.knowledgeItems];
  const decisions = [...snapshot.decisions];
  const tasks = [...snapshot.tasks];

  resolveIntraPlanConflicts(conversation, item.candidates).forEach((candidate, index) => {
    const content = candidate.content.trim();
    const derivedIdentity = candidateIdentity(candidate);
    if (!content || candidate.classification === 'already_known') return;

    if (candidate.classification === 'brainstorming' || candidate.classification === 'ambiguous') {
      if (candidate.usefulPending) {
        pending.push(pendingCandidate(conversation, project.id, sessionId, candidate, index));
      }
      return;
    }

    if (candidate.classification === 'new' && candidate.target === 'task') {
      const title = candidate.title?.trim() || content;
      const duplicate = tasks.find((task) =>
        task.status !== 'cancelled' && (
          task.derivedIdentity === derivedIdentity ||
          normalizedIdentity(task.title) === normalizedIdentity(title)));
      if (duplicate) return;
      const task: ProjectTask = {
        createdAt: occurredAt,
        derivedIdentity,
        id: derivedId(conversationId, project.id, 'task', index),
        position: tasks.reduce((maximum, value) => Math.max(maximum, value.position), -1) + 1,
        priority: 'normal',
        projectId: project.id,
        sourceSessionId: sessionId,
        status: 'todo',
        title,
        updatedAt: occurredAt,
      };
      tasks.push(task);
      changes.tasks = [...(changes.tasks ?? []), task];
      preconditions.push({ derivedIdentity, entityType: 'task', existingEntityId: null,
        expectedUpdatedAt: null, knowledgeKind: null, operation: 'create' });
      return;
    }

    if (
      (candidate.classification === 'new' || candidate.classification === 'unresolved_question') &&
      candidate.target === 'knowledge'
    ) {
      const kind = candidate.classification === 'unresolved_question'
        ? 'question'
        : candidate.knowledgeKind;
      if (!kind) return;
      const duplicate = knowledge.find((value) =>
        value.status === 'current' && value.kind === kind &&
        (value.derivedIdentity === derivedIdentity ||
          normalizedIdentity(value.content) === normalizedIdentity(content)));
      if (duplicate) return;
      const value: ProjectKnowledgeItem = {
        content,
        createdAt: occurredAt,
        derivedIdentity,
        id: derivedId(conversationId, project.id, 'knowledge', index),
        kind,
        projectId: project.id,
        sourceSessionId: sessionId,
        status: 'current',
        ...(candidate.title?.trim() ? { title: candidate.title.trim() } : {}),
        updatedAt: occurredAt,
      };
      knowledge.push(value);
      changes.knowledgeItems = [...(changes.knowledgeItems ?? []), value];
      changes.changeEvents = [
        ...(changes.changeEvents ?? []),
        knowledgeChangeEvent(conversationId, project.id, sessionId, value, index),
      ];
      preconditions.push({ derivedIdentity, entityType: 'knowledge', existingEntityId: null,
        expectedUpdatedAt: null, knowledgeKind: kind, operation: 'create' });
      return;
    }

    if (candidate.classification === 'clear_update' && candidate.target === 'knowledge') {
      const previous = knowledge.find((value) =>
        value.id === candidate.existingEntityId && value.status === 'current');
      if (!previous || !candidate.knowledgeKind) {
        pending.push(pendingCandidate(conversation, project.id, sessionId, candidate, index));
        return;
      }
      if (
        previous.kind === candidate.knowledgeKind &&
        normalizedIdentity(previous.content) === normalizedIdentity(content)
      ) return;
      const superseded: ProjectKnowledgeItem = {
        ...previous,
        status: 'superseded',
        updatedAt: occurredAt,
      };
      const replacement: ProjectKnowledgeItem = {
        content,
        createdAt: occurredAt,
        derivedIdentity,
        id: derivedId(conversationId, project.id, 'knowledge', index),
        kind: candidate.knowledgeKind,
        projectId: project.id,
        sourceSessionId: sessionId,
        status: 'current',
        supersedesKnowledgeItemId: previous.id,
        ...(candidate.title?.trim() ? { title: candidate.title.trim() } : {}),
        updatedAt: occurredAt,
      };
      changes.knowledgeItems = [...(changes.knowledgeItems ?? []), superseded, replacement];
      const knowledgeIndex = knowledge.findIndex((value) => value.id === previous.id);
      knowledge.splice(knowledgeIndex, 1, superseded, replacement);
      preconditions.push({ derivedIdentity, entityType: 'knowledge', existingEntityId: previous.id,
        expectedUpdatedAt: previous.updatedAt, knowledgeKind: candidate.knowledgeKind,
        operation: 'replace' });
      changes.changeEvents = [...(changes.changeEvents ?? []), {
        after: { knowledgeItemId: replacement.id, kind: replacement.kind },
        before: { knowledgeItemId: previous.id, kind: previous.kind },
        entityId: replacement.id,
        entityType: 'knowledge',
        eventType: 'knowledge_superseded',
        id: derivedId(conversationId, project.id, 'knowledge-event', index),
        occurredAt,
        projectId: project.id,
        sourceSessionId: sessionId,
        summary: `Replaced project knowledge: ${previous.title ?? previous.content}`,
      }];
      return;
    }

    if (candidate.classification === 'confirmed_decision' && candidate.target === 'decision') {
      if (candidate.existingEntityId && !decisions.some((value) =>
        value.id === candidate.existingEntityId && value.status === 'active')) {
        pending.push(pendingCandidate(conversation, project.id, sessionId, candidate, index));
        return;
      }
      const existing = candidate.existingEntityId
        ? decisions.find((value) => value.id === candidate.existingEntityId && value.status === 'active')
        : decisions.find((value) => value.status === 'active' && (
          value.derivedIdentity === derivedIdentity ||
          normalizedIdentity(value.statement) === normalizedIdentity(content)));
      if (existing && normalizedIdentity(existing.statement) === normalizedIdentity(content)) return;
      const replacement: ProjectDecision = {
        createdAt: occurredAt,
        decidedAt: occurredAt,
        derivedIdentity,
        id: derivedId(conversationId, project.id, 'decision', index),
        projectId: project.id,
        ...(candidate.rationale?.trim() ? { rationale: candidate.rationale.trim() } : {}),
        sourceSessionId: sessionId,
        statement: content,
        status: 'active',
        ...(existing ? { supersedesDecisionId: existing.id } : {}),
        updatedAt: occurredAt,
      };
      if (existing) {
        const superseded: ProjectDecision = {
          ...existing,
          status: 'superseded',
          updatedAt: occurredAt,
        };
        changes.decisions = [...(changes.decisions ?? []), superseded, replacement];
        const decisionIndex = decisions.findIndex((value) => value.id === existing.id);
        decisions.splice(decisionIndex, 1, superseded, replacement);
        preconditions.push({ derivedIdentity, entityType: 'decision', existingEntityId: existing.id,
          expectedUpdatedAt: existing.updatedAt, knowledgeKind: null, operation: 'replace' });
        changes.changeEvents = [...(changes.changeEvents ?? []), {
          after: { decisionId: replacement.id, statement: replacement.statement },
          before: { decisionId: existing.id, statement: existing.statement },
          entityId: replacement.id,
          entityType: 'decision',
          eventType: 'decision_superseded',
          id: derivedId(conversationId, project.id, 'decision-event', index),
          occurredAt,
          projectId: project.id,
          sourceSessionId: sessionId,
          summary: `Replaced decision “${existing.statement}” with “${replacement.statement}”.`,
        }];
      } else {
        changes.decisions = [...(changes.decisions ?? []), replacement];
        decisions.push(replacement);
        preconditions.push({ derivedIdentity, entityType: 'decision', existingEntityId: null,
          expectedUpdatedAt: null, knowledgeKind: null, operation: 'create' });
      }
      return;
    }

    if (shouldRemainPending(candidate)) {
      pending.push(pendingCandidate(conversation, project.id, sessionId, candidate, index));
    }
  });

  return { candidates: pending, changes, preconditions };
}
