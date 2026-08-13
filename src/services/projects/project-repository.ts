import type {
  Project,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectDeliverable,
  ProjectKnowledgeItem,
  ProjectMilestone,
  ProjectResource,
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
  getTask(id: string): Promise<ProjectTask | null>;
  getWorkSession(id: string): Promise<ProjectWorkSession | null>;
  listChangeEvents(projectId: string): Promise<ProjectChangeEvent[]>;
  listDecisions(projectId: string): Promise<ProjectDecision[]>;
  listDeliverables(projectId: string): Promise<ProjectDeliverable[]>;
  listKnowledgeItems(projectId: string): Promise<ProjectKnowledgeItem[]>;
  listMilestones(projectId: string): Promise<ProjectMilestone[]>;
  listProjects(): Promise<Project[]>;
  listResources(projectId: string): Promise<ProjectResource[]>;
  listTasks(projectId: string): Promise<ProjectTask[]>;
  listWorkSessionEntries(sessionId: string): Promise<ProjectWorkSessionEntry[]>;
  listWorkSessions(projectId: string): Promise<ProjectWorkSession[]>;
  saveDecision(decision: ProjectDecision): Promise<void>;
  saveDeliverable(deliverable: ProjectDeliverable): Promise<void>;
  saveKnowledgeItem(item: ProjectKnowledgeItem): Promise<void>;
  saveMilestone(milestone: ProjectMilestone): Promise<void>;
  saveProject(project: Project): Promise<void>;
  saveResource(resource: ProjectResource): Promise<void>;
  saveTask(task: ProjectTask): Promise<void>;
  saveWorkSession(session: ProjectWorkSession): Promise<void>;
  saveWorkSessionEntry(entry: ProjectWorkSessionEntry): Promise<void>;
  saveAtomically(changes: ProjectRepositoryChanges): Promise<void>;
}
