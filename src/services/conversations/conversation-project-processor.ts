import type {
  ConversationProjectCandidate,
  ConversationProjectPlanItem,
  ConversationProjectProcessingPlan,
  ConversationWithMessages,
} from '../../domain/conversations';
import type { Project } from '../../domain/projects';
import { ASSISTANT_REQUEST_LIMITS } from '../../server/assistant/request-validation';
import type { ProjectRepository } from '../projects/project-repository';

import type {
  ConversationProjectAnalyzer,
  ConversationProjectSnapshot,
  ProjectSegmentMatch,
} from './conversation-project-analyzer';
import {
  ConversationProcessingInProgressError,
  StaleProjectStateError,
  type ConversationProjectProcessingRepository,
} from './conversation-project-processing-repository';
import {
  buildConversationProjectResult,
  conversationProjectSessionId,
} from './conversation-project-reconciler';

export type ConversationProjectProcessingResult = {
  projectCount: number;
  status: 'processed' | 'already_processed';
};

const MAX_MATCHABLE_PROJECTS = 50;
const MAX_PROJECT_STATE_ITEMS = 100;
const EXPLORATORY_LANGUAGE = /\b(maybe|perhaps|might|could|consider(?:ing)?|thinking (?:about|of)|what if|should we|unsure|not (?:yet )?decided)\b/i;
const DECISION_LANGUAGE = /\b(i (?:have )?decided|we (?:have )?decided|decided on|chose|confirmed|accepted|approved|agreed on|settled on|final decision|going with|let(?:'|’)s go with|will use)\b/i;
const UPDATE_LANGUAGE = /\b(now|instead|change(?:d|ing)?|replace(?:d|ing)?|update(?:d|ing)?|no longer|actually|definitely|confirmed|decided)\b/i;
const STRONG_UPDATE_LANGUAGE = /\b(instead|changed|replaced|updated|no longer|actually|definitely|confirmed|decided)\b/i;
const NON_DISTINCTIVE_WORDS = new Set([
  'about', 'already', 'could', 'from', 'have', 'project', 'should', 'that', 'their',
  'there', 'these', 'this', 'use', 'with', 'would',
]);
const PROJECT_ACRONYM = /^[A-Z][A-Z0-9-]{2,}$/;
const EXPLICIT_PROJECT_WORK_LANGUAGE = new RegExp([
  '\\b(?:i|we)\\s+(?:want|need|plan)\\s+to\\s+',
  '(?:work|explore|research|compare|figure|decide|change|switch|build|create|update|review|discuss)',
  '|\\bback to\\b|\\blet(?:\'|’)s\\b',
  '|\\b(?:i|we)\\s+(?:finished|completed|decided|changed|switched|updated)\\b',
].join(''), 'i');

function normalizedWords(value: string) {
  return new Set(value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function projectsOverlap(left: Project, right: Project) {
  const leftName = left.name.trim().toLocaleLowerCase();
  const rightName = right.name.trim().toLocaleLowerCase();
  if (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName)) return true;
  const leftWords = normalizedWords([left.name, left.description, left.goal].filter(Boolean).join(' '));
  const rightWords = normalizedWords([right.name, right.description, right.goal].filter(Boolean).join(' '));
  const shared = [...leftWords].filter((word) => word.length > 3 && rightWords.has(word));
  return shared.length >= 2;
}

function normalizedPhrase(value: string) {
  return (value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ');
}

function explicitlyReferencedProjectIds(content: string, projects: readonly Project[]) {
  const phrase = normalizedPhrase(content);
  const fullNameMatches = projects.filter((project) => {
    const name = normalizedPhrase(project.name);
    return name.length > 0 && (` ${phrase} `).includes(` ${name} `);
  });
  const mostSpecificFullNames = fullNameMatches.filter((candidate) => {
    const candidateName = normalizedPhrase(candidate.name);
    return !fullNameMatches.some((other) =>
      other.id !== candidate.id && normalizedPhrase(other.name) !== candidateName &&
      (` ${normalizedPhrase(other.name)} `).includes(` ${candidateName} `));
  });
  const projectIds = new Set(mostSpecificFullNames.map((project) => project.id));
  const contentWords = normalizedWords(content);
  const acronymOwners = new Map<string, Set<string>>();

  projects.forEach((project) => {
    for (const token of project.name.split(/\s+/)) {
      if (!PROJECT_ACRONYM.test(token)) continue;
      const normalized = token.toLocaleLowerCase();
      const owners = acronymOwners.get(normalized) ?? new Set<string>();
      owners.add(project.id);
      acronymOwners.set(normalized, owners);
    }
  });
  acronymOwners.forEach((owners, acronym) => {
    if (owners.size === 1 && contentWords.has(acronym)) {
      projectIds.add([...owners][0]);
    }
  });

  return projectIds;
}

function deterministicExplicitMatches(
  conversation: ConversationWithMessages,
  projects: readonly Project[],
) {
  const evidenceByProject = new Map<string, Set<string>>();
  conversation.messages.forEach((message, index) => {
    if (message.role !== 'user' || !EXPLICIT_PROJECT_WORK_LANGUAGE.test(message.content)) return;
    for (const projectId of explicitlyReferencedProjectIds(message.content, projects)) {
      const evidence = evidenceByProject.get(projectId) ?? new Set<string>();
      evidence.add(message.id);
      const response = conversation.messages[index + 1];
      if (response?.role === 'assistant') evidence.add(response.id);
      evidenceByProject.set(projectId, evidence);
    }
  });
  return [...evidenceByProject].map(([projectId, evidence]) => ({
    confidence: 'high' as const,
    projectId,
    relevantMessageIds: conversation.messages
      .filter((message) => evidence.has(message.id))
      .map((message) => message.id),
  }));
}

function explicitProjectEvidence(
  conversation: ConversationWithMessages,
  match: ProjectSegmentMatch,
  project: Project,
  similarProjects: readonly Project[],
) {
  return conversation.messages.some((message) =>
    message.role === 'user' && match.relevantMessageIds.includes(message.id) &&
    explicitlyReferencedProjectIds(message.content, [project, ...similarProjects]).has(project.id) &&
    !similarProjects.some((value) =>
      explicitlyReferencedProjectIds(message.content, [project, ...similarProjects]).has(value.id)));
}

function hasProjectEvidence(
  conversation: ConversationWithMessages,
  relevantMessageIds: readonly string[],
  project: Project,
  projects: readonly Project[],
) {
  const projectName = project.name.trim().toLocaleLowerCase();
  const distinctive = [...normalizedWords([project.description, project.goal]
    .filter(Boolean).join(' '))].filter((word) => word.length > 4);
  return conversation.messages.some((message) => {
    if (message.role !== 'user' || !relevantMessageIds.includes(message.id)) return false;
    const content = message.content.toLocaleLowerCase();
    if (content.includes(projectName) ||
      explicitlyReferencedProjectIds(message.content, projects).has(project.id)) return true;
    const words = normalizedWords(content);
    return distinctive.filter((word) => words.has(word)).length >= 2;
  });
}

export function validMatches(
  conversation: ConversationWithMessages,
  projects: readonly Project[],
  matches: readonly ProjectSegmentMatch[],
) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const messageById = new Map(conversation.messages.map((message) => [message.id, message]));
  const grouped = new Map<string, string[]>();

  for (const match of matches) {
    const project = projectById.get(match.projectId);
    if (match.confidence !== 'high' || !project) continue;
    const relevant = [...new Set(match.relevantMessageIds)]
      .filter((id) => messageById.has(id));
    if (!relevant.some((id) => messageById.get(id)?.role === 'user')) continue;
    if (!hasProjectEvidence(conversation, relevant, project, projects)) continue;
    const similarProjects = projects.filter((value) =>
      value.id !== project.id && projectsOverlap(project, value));
    if (similarProjects.length > 0 &&
      !explicitProjectEvidence(conversation, match, project, similarProjects)) continue;
    const current = grouped.get(match.projectId) ?? [];
    grouped.set(match.projectId, [...new Set([...current, ...relevant])]);
  }

  return [...grouped].map(([projectId, relevantMessageIds]) => ({
    projectId,
    relevantMessageIds: conversation.messages
      .filter((message) => relevantMessageIds.includes(message.id))
      .map((message) => message.id),
  }));
}

async function loadSnapshot(
  repository: ProjectRepository,
  projectId: string,
): Promise<ConversationProjectSnapshot> {
  const [decisions, knowledgeItems, tasks, sessions] = await Promise.all([
    repository.listDecisions(projectId, MAX_PROJECT_STATE_ITEMS),
    repository.listKnowledgeItems(projectId, MAX_PROJECT_STATE_ITEMS),
    repository.listTasks(projectId, MAX_PROJECT_STATE_ITEMS),
    repository.listWorkSessions(projectId, 10),
  ]);

  return {
    decisions,
    knowledgeItems,
    recentWorkSessions: [...sessions]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, 10),
    tasks,
  };
}

function validatedCandidates(
  raw: ConversationProjectPlanItem,
  conversation: ConversationWithMessages,
  project: Project,
) {
  const relevant = new Set(raw.relevantMessageIds);
  const messageById = new Map(conversation.messages.map((message) => [message.id, message]));
  const candidates: ConversationProjectCandidate[] = [];
  for (const candidate of raw.candidates) {
    const evidenceIds = [...new Set(candidate.evidenceMessageIds)];
    const evidence = evidenceIds.map((id) => messageById.get(id));
    if (
      evidenceIds.length < 1 || evidence.some((message) => !message) ||
      evidenceIds.some((id) => !relevant.has(id)) ||
      !evidence.some((message) => message?.role === 'user') ||
      !candidate.subjectKey?.trim()
    ) continue;

    const userEvidence = evidence
      .filter((message) => message?.role === 'user')
      .map((message) => message?.content ?? '')
      .join(' ');
    const truthChanging = ['new', 'clear_update', 'confirmed_decision', 'unresolved_question']
      .includes(candidate.classification);
    const candidateWords = normalizedWords([
      candidate.content, candidate.title, candidate.subjectKey,
    ].filter(Boolean).join(' '));
    const evidenceWords = normalizedWords(userEvidence);
    const projectNameWords = normalizedWords(project.name);
    const supportedWords = [...candidateWords].filter((word) =>
      word.length > 2 && !NON_DISTINCTIVE_WORDS.has(word) &&
      !projectNameWords.has(word) && evidenceWords.has(word));
    if (truthChanging && supportedWords.length < 1) continue;
    const unsupportedDecision = candidate.classification === 'confirmed_decision' &&
      !DECISION_LANGUAGE.test(userEvidence);
    const unsupportedUpdate = candidate.classification === 'clear_update' &&
      (!UPDATE_LANGUAGE.test(userEvidence) ||
        (EXPLORATORY_LANGUAGE.test(userEvidence) && !STRONG_UPDATE_LANGUAGE.test(userEvidence)));
    if (unsupportedDecision || unsupportedUpdate) {
      candidates.push({
        ...candidate,
        classification: 'ambiguous' as const,
        evidenceMessageIds: evidenceIds,
        usefulPending: true,
      });
      continue;
    }
    candidates.push({
      ...candidate,
      evidenceMessageIds: evidenceIds,
      subjectKey: candidate.subjectKey.trim(),
    });
  }
  return candidates;
}

function validatePlanItem(
  raw: ConversationProjectPlanItem,
  conversation: ConversationWithMessages,
  project: Project,
) {
  const messageIds = new Set(conversation.messages.map((message) => message.id));
  if (
    !raw.summary.trim() || !raw.title.trim() ||
    raw.summary.length > 2_000 || raw.title.length > 300 ||
    raw.relevantMessageIds.length < 1 ||
    raw.relevantMessageIds.some((id) => !messageIds.has(id)) ||
    raw.candidates.length > 30
  ) {
    throw new Error('Conversation Project analysis returned an invalid plan.');
  }
  return { ...raw, candidates: validatedCandidates(raw, conversation, project) };
}

function validateConversationBounds(conversation: ConversationWithMessages) {
  const total = conversation.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (
    conversation.messages.length > ASSISTANT_REQUEST_LIMITS.messageCount ||
    total > ASSISTANT_REQUEST_LIMITS.totalMessageLength ||
    conversation.messages.some((message) =>
      message.content.length > ASSISTANT_REQUEST_LIMITS.messageLength)
  ) throw new Error('Completed conversation exceeds safe Project-processing limits.');
}

export class ConversationProjectProcessor {
  constructor(
    private readonly analyzer: ConversationProjectAnalyzer,
    private readonly processingRepository: ConversationProjectProcessingRepository,
    private readonly projectRepository: ProjectRepository,
  ) {}

  async process(conversationId: string): Promise<ConversationProjectProcessingResult> {
    let activeProjectId: string | null = null;

    try {
      const claim = await this.processingRepository.claim(conversationId);
      if (claim.status === 'processed') {
        return { projectCount: claim.conversation.conversation.processingPlan?.projects.length ?? 0,
          status: 'already_processed' };
      }

      const conversation = claim.conversation;
      validateConversationBounds(conversation);
      let plan = conversation.conversation.processingPlan;

      if (!plan) {
        plan = await this.createPlan(conversation);
        plan = await this.processingRepository.savePlan(
          conversationId,
          plan,
          plan.projects.map((item) => ({
            projectId: item.projectId,
            sessionId: conversationProjectSessionId(conversationId, item.projectId),
          })),
        );
      }

      const checkpoints = await this.processingRepository.listCheckpoints(conversationId);
      const checkpointByProject = new Map(checkpoints.map((value) => [value.projectId, value]));

      for (const item of plan.projects) {
        activeProjectId = item.projectId;
        if (['processed', 'skipped'].includes(checkpointByProject.get(item.projectId)?.status ?? '')) continue;

        const project = await this.projectRepository.getProject(item.projectId);
        if (!project || project.status === 'archived' || project.status === 'cancelled') {
          await this.processingRepository.commitProjectResult({
            candidates: [], changes: {}, conversationId, preconditions: [], projectId: item.projectId,
          });
          continue;
        }
        let snapshot = await loadSnapshot(this.projectRepository, project.id);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = buildConversationProjectResult({ conversation, item, project, snapshot });
          try {
            await this.processingRepository.commitProjectResult({
              candidates: result.candidates,
              changes: result.changes,
              conversationId,
              preconditions: result.preconditions,
              projectId: project.id,
            });
            break;
          } catch (error) {
            if (!(error instanceof StaleProjectStateError) || attempt > 0) throw error;
            const currentProject = await this.projectRepository.getProject(project.id);
            if (!currentProject || ['archived', 'cancelled'].includes(currentProject.status)) {
              await this.processingRepository.commitProjectResult({
                candidates: [], changes: {}, conversationId, preconditions: [], projectId: project.id,
              });
              break;
            }
            snapshot = await loadSnapshot(this.projectRepository, project.id);
          }
        }
      }

      activeProjectId = null;
      await this.processingRepository.complete(conversationId);
      return { projectCount: plan.projects.length, status: 'processed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Conversation Project processing failed.';
      if (!(error instanceof ConversationProcessingInProgressError)) {
        await this.processingRepository.fail(conversationId, activeProjectId, message).catch(() => undefined);
      }
      throw error;
    }
  }

  private async createPlan(
    conversation: ConversationWithMessages,
  ): Promise<ConversationProjectProcessingPlan> {
    const allProjects = await this.projectRepository.listProjects(MAX_MATCHABLE_PROJECTS + 1);
    if (allProjects.length > MAX_MATCHABLE_PROJECTS) {
      throw new Error('Too many Projects to match safely in one processing request.');
    }
    const projects = allProjects.filter(
      (project) => project.status !== 'archived' && project.status !== 'cancelled',
    );
    if (projects.length < 1) return { projects: [], version: 2 };

    const analyzedMatches = await this.analyzer.matchProjectSegments(conversation, projects);
    const matches = validMatches(
      conversation,
      projects,
      [...analyzedMatches, ...deterministicExplicitMatches(conversation, projects)],
    );
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const items = await Promise.all(matches.map(async (match) => {
      const project = projectById.get(match.projectId);
      if (!project) throw new Error('A matched Project was not found.');
      const snapshot = await loadSnapshot(this.projectRepository, project.id);
      const reconciliation = await this.analyzer.reconcileProjectSegment({
        conversation,
        project,
        relevantMessageIds: match.relevantMessageIds,
        snapshot,
      });
      return validatePlanItem({
        candidates: reconciliation.candidates,
        projectId: project.id,
        relevantMessageIds: match.relevantMessageIds,
        summary: reconciliation.summary,
        title: reconciliation.title,
      }, conversation, project);
    }));

    return { projects: items, version: 2 };
  }
}

export { loadSnapshot as loadConversationProjectSnapshot };
