import type {
  Project,
  ProjectAsset,
  ProjectAssetSectionPlacement,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectDeliverable,
  ProjectKnowledgeItem,
  ProjectGlobalAsset,
  ProjectMilestone,
  ProjectResource,
  ProjectSection,
  ProjectTask,
  ProjectWorkSession,
  ProjectWorkSessionEntry,
} from '@/domain/projects';

export type ProjectAssetUploadIdentity = {
  assetId: string;
  attemptId: string;
  objectId: string;
};

export type BeginProjectAssetUploadInput = ProjectAssetUploadIdentity & {
  byteSize: number;
  height?: number;
  mimeType: string;
  originalFilename: string;
  picker: 'document-picker' | 'photo-library' | 'web-file-picker';
  projectId: string;
  sectionId?: string;
  width?: number;
};

export type ProjectAssetUploadReservation = ProjectAssetUploadIdentity & {
  objectExists: boolean;
  projectId: string;
  sectionId?: string;
  status: 'finalized' | 'pending';
  storagePath: string;
};

export type ProjectAssetUploadAttemptState = {
  assetId: string;
  projectId: string;
  sectionId?: string;
  status: 'cleaned' | 'finalized' | 'pending';
};

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
  addAssetPlacement(projectId: string, assetId: string, sectionId: string): Promise<ProjectAsset>;
  beginAssetUpload(input: BeginProjectAssetUploadInput): Promise<ProjectAssetUploadReservation>;
  finalizeAssetUpload(attemptId: string): Promise<ProjectAsset>;
  getDecision(id: string): Promise<ProjectDecision | null>;
  getDeliverable(id: string): Promise<ProjectDeliverable | null>;
  getKnowledgeItem(id: string): Promise<ProjectKnowledgeItem | null>;
  getMilestone(id: string): Promise<ProjectMilestone | null>;
  getProject(id: string): Promise<Project | null>;
  getResource(id: string): Promise<ProjectResource | null>;
  getSection(id: string): Promise<ProjectSection | null>;
  getTask(id: string): Promise<ProjectTask | null>;
  getWorkSession(id: string): Promise<ProjectWorkSession | null>;
  listChangeEvents(projectId: string): Promise<ProjectChangeEvent[]>;
  listAssetPlacements(
    projectId: string,
    assetId: string,
  ): Promise<ProjectAssetSectionPlacement[]>;
  listAssetUploadAttempts(projectId: string): Promise<ProjectAssetUploadAttemptState[]>;
  listDecisions(projectId: string, limit?: number): Promise<ProjectDecision[]>;
  listDeliverables(projectId: string): Promise<ProjectDeliverable[]>;
  listKnowledgeItems(projectId: string, limit?: number): Promise<ProjectKnowledgeItem[]>;
  listMilestones(projectId: string): Promise<ProjectMilestone[]>;
  listProjects(limit?: number): Promise<Project[]>;
  listProjectAssets(projectId: string): Promise<ProjectGlobalAsset[]>;
  listResources(projectId: string): Promise<ProjectResource[]>;
  listSectionAssetPlacements(
    projectId: string,
    sectionId: string,
  ): Promise<ProjectAssetSectionPlacement[]>;
  listSectionAssets(projectId: string, sectionId: string): Promise<ProjectGlobalAsset[]>;
  listSections(projectId: string): Promise<ProjectSection[]>;
  listTasks(projectId: string, limit?: number): Promise<ProjectTask[]>;
  listWorkSessionEntries(sessionId: string): Promise<ProjectWorkSessionEntry[]>;
  listWorkSessions(projectId: string, limit?: number): Promise<ProjectWorkSession[]>;
  markAssetUploadCleaned(attemptId: string): Promise<void>;
  reconcileAssetUploads(projectId: string, sectionId?: string): Promise<void>;
  removeAssetPlacement(projectId: string, assetId: string, sectionId: string): Promise<ProjectAsset>;
  replaceAssetPlacement(
    projectId: string,
    assetId: string,
    sourceSectionId: string,
    targetSectionId: string,
  ): Promise<ProjectAsset>;
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
  touchProjectActivity(projectId: string, occurredAt: string): Promise<void>;
  saveAtomically(changes: ProjectRepositoryChanges): Promise<void>;
  reorderSections(
    projectId: string,
    sectionIds: readonly string[],
    updatedAt: string,
  ): Promise<ProjectSection[]>;
}
