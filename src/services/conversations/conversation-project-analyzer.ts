import type {
  ConversationProjectCandidate,
  ConversationWithMessages,
} from '../../domain/conversations';
import type {
  Project,
  ProjectDecision,
  ProjectKnowledgeItem,
  ProjectTask,
  ProjectWorkSession,
} from '../../domain/projects';

export type ProjectSegmentMatch = {
  confidence: 'high' | 'medium' | 'low';
  projectId: string;
  relevantMessageIds: string[];
};

export type ProjectConversationReconciliation = {
  candidates: ConversationProjectCandidate[];
  summary: string;
  title: string;
};

export type ConversationProjectSnapshot = {
  decisions: ProjectDecision[];
  knowledgeItems: ProjectKnowledgeItem[];
  recentWorkSessions: ProjectWorkSession[];
  tasks: ProjectTask[];
};

export interface ConversationProjectAnalyzer {
  matchProjectSegments(
    conversation: ConversationWithMessages,
    projects: readonly Project[],
  ): Promise<ProjectSegmentMatch[]>;
  reconcileProjectSegment(input: {
    conversation: ConversationWithMessages;
    project: Project;
    relevantMessageIds: readonly string[];
    snapshot: ConversationProjectSnapshot;
  }): Promise<ProjectConversationReconciliation>;
}
