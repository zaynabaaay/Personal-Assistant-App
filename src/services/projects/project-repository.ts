import type {
  Project,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectDeliverable,
  ProjectKnowledgeItem,
  ProjectMilestone,
  ProjectResource,
  ProjectSection,
  ProjectTask,
  ProjectWorkSession,
  ProjectWorkSessionEntry,
} from '@/domain/projects';

export type ProjectRepositoryChanges = {
  changeEvents?: ProjectChangeEvent[];
  decisions?: ProjectDecision[];
  deliverables?: ProjectDeliverable[];
  knowledgeItems?: ProjectKnowledgeItem[];
  milestones?: ProjectMilestone[];
  projects?: Project[];
  resources?: ProjectResource[];
  sections?: ProjectSection[];
  tasks?: ProjectTask[];
  workSessionEntries?: ProjectWorkSessionEntry[];
  workSessions?: ProjectWorkSession[];
};

export interface ProjectRepository {
  addChangeEvent(event: ProjectChangeEvent): Promise<void>;
  getDecision(id: string): Promise<ProjectDecision | null>;
  getDeliverable(id: string): Promise<ProjectDeliverable | null>;
  getKnowledgeItem(id: string): Promise<ProjectKnowledgeItem | null>;
  getMilestone(id: string): Promise<ProjectMilestone | null>;
  getProject(id: string): Promise<Project | null>;
  getSection(id: string): Promise<ProjectSection | null>;
  getTask(id: string): Promise<ProjectTask | null>;
  getWorkSession(id: string): Promise<ProjectWorkSession | null>;
  listChangeEvents(projectId: string): Promise<ProjectChangeEvent[]>;
  listDecisions(projectId: string, limit?: number): Promise<ProjectDecision[]>;
  listDeliverables(projectId: string): Promise<ProjectDeliverable[]>;
  listKnowledgeItems(projectId: string, limit?: number): Promise<ProjectKnowledgeItem[]>;
  listMilestones(projectId: string): Promise<ProjectMilestone[]>;
  listProjects(limit?: number): Promise<Project[]>;
  listResources(projectId: string): Promise<ProjectResource[]>;
  listSections(projectId: string): Promise<ProjectSection[]>;
  listTasks(projectId: string, limit?: number): Promise<ProjectTask[]>;
  listWorkSessionEntries(sessionId: string): Promise<ProjectWorkSessionEntry[]>;
  listWorkSessions(projectId: string, limit?: number): Promise<ProjectWorkSession[]>;
  saveDecision(decision: ProjectDecision): Promise<void>;
  saveDeliverable(deliverable: ProjectDeliverable): Promise<void>;
  saveKnowledgeItem(item: ProjectKnowledgeItem): Promise<void>;
  saveMilestone(milestone: ProjectMilestone): Promise<void>;
  saveProject(project: Project): Promise<void>;
  saveResource(resource: ProjectResource): Promise<void>;
  saveSection(section: ProjectSection): Promise<void>;
  saveTask(task: ProjectTask): Promise<void>;
  saveWorkSession(session: ProjectWorkSession): Promise<void>;
  saveWorkSessionEntry(entry: ProjectWorkSessionEntry): Promise<void>;
  saveAtomically(changes: ProjectRepositoryChanges): Promise<void>;
  reorderSections(
    projectId: string,
    sectionIds: readonly string[],
    updatedAt: string,
  ): Promise<ProjectSection[]>;
}
