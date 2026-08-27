import { orderWorkSessionEntries } from '@/domain/projects';
import type {
  Project,
  ProjectAsset,
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

import type {
  BeginProjectAssetUploadInput,
  ProjectAssetUploadReservation,
  ProjectRepository,
  ProjectRepositoryChanges,
} from './project-repository';

type InMemoryUploadAttempt = BeginProjectAssetUploadInput & {
  cleaned: boolean;
  createdAt: string;
  finalized: boolean;
  objectExists: boolean;
  storagePath: string;
};

export type InMemoryProjectRepositorySeed = {
  changeEvents?: ProjectChangeEvent[];
  decisions?: ProjectDecision[];
  deliverables?: ProjectDeliverable[];
  knowledgeItems?: ProjectKnowledgeItem[];
  milestones?: ProjectMilestone[];
  ownerId?: string;
  projects?: Project[];
  resources?: ProjectResource[];
  sections?: ProjectSection[];
  tasks?: ProjectTask[];
  workSessionEntries?: ProjectWorkSessionEntry[];
  workSessions?: ProjectWorkSession[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createMap<T extends { id: string }>(values: readonly T[] = []) {
  return new Map(values.map((value) => [value.id, clone(value)]));
}

function listForProject<T extends { projectId: string }>(
  values: Iterable<T>,
  projectId: string,
) {
  return [...values]
    .filter((value) => value.projectId === projectId)
    .map(clone);
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly changeEvents: Map<string, ProjectChangeEvent>;
  private readonly decisions: Map<string, ProjectDecision>;
  private readonly deliverables: Map<string, ProjectDeliverable>;
  private readonly knowledgeItems: Map<string, ProjectKnowledgeItem>;
  private readonly milestones: Map<string, ProjectMilestone>;
  private readonly projects: Map<string, Project>;
  private readonly resources: Map<string, ProjectResource>;
  private readonly sections: Map<string, ProjectSection>;
  private readonly tasks: Map<string, ProjectTask>;
  private readonly workSessionEntries: Map<string, ProjectWorkSessionEntry>;
  private readonly workSessions: Map<string, ProjectWorkSession>;
  private readonly uploadAttempts = new Map<string, InMemoryUploadAttempt>();
  private readonly ownerId: string;

  constructor(seed: InMemoryProjectRepositorySeed = {}) {
    this.changeEvents = createMap(seed.changeEvents);
    this.decisions = createMap(seed.decisions);
    this.deliverables = createMap(seed.deliverables);
    this.knowledgeItems = createMap(seed.knowledgeItems);
    this.milestones = createMap(seed.milestones);
    this.ownerId = seed.ownerId ?? 'in-memory-owner';
    this.projects = createMap(seed.projects);
    this.resources = createMap(seed.resources);
    this.sections = createMap(seed.sections);
    this.tasks = createMap(seed.tasks);
    this.workSessionEntries = createMap(seed.workSessionEntries);
    this.workSessions = createMap(seed.workSessions);
  }

  async addChangeEvent(event: ProjectChangeEvent) {
    this.changeEvents.set(event.id, clone(event));
  }

  async beginAssetUpload(input: BeginProjectAssetUploadInput): Promise<ProjectAssetUploadReservation> {
    const existing = this.uploadAttempts.get(input.attemptId);
    if (existing) {
      const same = (['assetId', 'objectId', 'projectId', 'sectionId', 'byteSize', 'mimeType',
        'originalFilename', 'picker', 'width', 'height'] as const)
        .every((key) => existing[key] === input[key]);
      if (!same) throw new Error('Upload attempt identity cannot be changed.');
      if (existing.cleaned) {
        existing.cleaned = false;
        existing.objectExists = false;
      }
      return this.uploadReservation(existing);
    }
    const project = this.projects.get(input.projectId);
    const section = this.sections.get(input.sectionId);
    if (!project || !section || section.projectId !== input.projectId || section.status !== 'active') {
      throw new Error('Project assets require an active section in the same owned Project.');
    }
    const createdAt = new Date().toISOString();
    const attempt: InMemoryUploadAttempt = { ...clone(input), cleaned: false, createdAt,
      finalized: false, objectExists: false,
      storagePath: `${this.ownerId}/${input.projectId}/${input.assetId}/${input.objectId}` };
    this.uploadAttempts.set(input.attemptId, attempt);
    return this.uploadReservation(attempt);
  }

  async finalizeAssetUpload(attemptId: string): Promise<ProjectAsset> {
    const attempt = this.uploadAttempts.get(attemptId);
    if (!attempt) throw new Error('Upload attempt was not found.');
    const existing = this.resources.get(attempt.assetId);
    if (attempt.finalized && existing) return clone(existing) as ProjectAsset;
    if (!attempt.objectExists) throw new Error('The exact reserved Storage object does not exist.');
    const section = this.sections.get(attempt.sectionId);
    if (!section || section.status !== 'active') throw new Error('Project assets require an active section.');
    const type: ProjectAsset['type'] = attempt.mimeType.startsWith('image/') ? 'image' :
      attempt.mimeType === 'application/pdf' ? 'pdf' :
        attempt.mimeType.includes('excel') || attempt.mimeType.includes('spreadsheet') ? 'spreadsheet' : 'document';
    const asset: ProjectAsset = {
      byteSize: attempt.byteSize, createdAt: attempt.createdAt,
      ...(attempt.height ? { height: attempt.height } : {}), id: attempt.assetId,
      mimeType: attempt.mimeType, name: attempt.originalFilename,
      originalFilename: attempt.originalFilename, projectId: attempt.projectId,
      resourceKind: 'uploaded_asset', role: 'reference', sectionId: attempt.sectionId,
      sourceMetadata: { addedAt: attempt.createdAt, kind: 'original-upload', picker: attempt.picker },
      status: 'current', storagePath: attempt.storagePath, type, updatedAt: attempt.createdAt,
      ...(attempt.width ? { width: attempt.width } : {}),
    };
    this.resources.set(asset.id, clone(asset));
    attempt.finalized = true;
    return clone(asset);
  }

  async markAssetUploadCleaned(attemptId: string) {
    const attempt = this.uploadAttempts.get(attemptId);
    if (!attempt) throw new Error('Upload attempt was not found.');
    if (attempt.finalized || this.resources.has(attempt.assetId)) {
      throw new Error('A finalized asset cannot be cleaned.');
    }
    if (attempt.objectExists) throw new Error('Storage object still exists.');
    attempt.cleaned = true;
  }

  async reconcileAssetUploads(projectId: string, sectionId: string) {
    for (const attempt of this.uploadAttempts.values()) {
      if (attempt.projectId === projectId && attempt.sectionId === sectionId &&
        !attempt.finalized && !attempt.cleaned && attempt.objectExists) {
        await this.finalizeAssetUpload(attempt.attemptId);
      }
    }
  }

  /** Test/storage adapter hook: the real repository derives this from storage.objects. */
  setAssetUploadObjectExists(attemptId: string, exists: boolean) {
    const attempt = this.uploadAttempts.get(attemptId);
    if (!attempt) throw new Error('Upload attempt was not found.');
    attempt.objectExists = exists;
  }

  async getDecision(id: string) {
    return this.get(this.decisions, id);
  }

  async getDeliverable(id: string) {
    return this.get(this.deliverables, id);
  }

  async getKnowledgeItem(id: string) {
    return this.get(this.knowledgeItems, id);
  }

  async getMilestone(id: string) {
    return this.get(this.milestones, id);
  }

  async getProject(id: string) {
    return this.get(this.projects, id);
  }

  async getResource(id: string) {
    return this.get(this.resources, id);
  }

  async getSection(id: string) {
    return this.get(this.sections, id);
  }

  async getTask(id: string) {
    return this.get(this.tasks, id);
  }

  async getWorkSession(id: string) {
    return this.get(this.workSessions, id);
  }

  async listChangeEvents(projectId: string) {
    return listForProject(this.changeEvents.values(), projectId).sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
  }

  async listDecisions(projectId: string) {
    return listForProject(this.decisions.values(), projectId);
  }

  async listDeliverables(projectId: string) {
    return listForProject(this.deliverables.values(), projectId).sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  async listKnowledgeItems(projectId: string) {
    return listForProject(this.knowledgeItems.values(), projectId);
  }

  async listMilestones(projectId: string) {
    return listForProject(this.milestones.values(), projectId).sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  async listProjects() {
    return [...this.projects.values()].map(clone);
  }

  async listResources(projectId: string) {
    return listForProject(this.resources.values(), projectId);
  }

  async listSections(projectId: string) {
    return listForProject(this.sections.values(), projectId).sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  async listTasks(projectId: string) {
    return listForProject(this.tasks.values(), projectId).sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  async listWorkSessionEntries(sessionId: string) {
    return orderWorkSessionEntries(
      [...this.workSessionEntries.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map(clone),
    );
  }

  async listWorkSessions(projectId: string) {
    return listForProject(this.workSessions.values(), projectId).sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    );
  }

  async saveDecision(decision: ProjectDecision) {
    this.decisions.set(decision.id, clone(decision));
  }

  async saveDeliverable(deliverable: ProjectDeliverable) {
    this.deliverables.set(deliverable.id, clone(deliverable));
  }

  async saveKnowledgeItem(item: ProjectKnowledgeItem) {
    this.knowledgeItems.set(item.id, clone(item));
  }

  async saveMilestone(milestone: ProjectMilestone) {
    this.milestones.set(milestone.id, clone(milestone));
  }

  async saveProject(project: Project) {
    this.projects.set(project.id, clone(project));
  }

  async saveResource(resource: ProjectResource) {
    this.resources.set(resource.id, clone(resource));
  }

  async saveSection(section: ProjectSection) {
    this.sections.set(section.id, clone(section));
  }

  async saveTask(task: ProjectTask) {
    this.tasks.set(task.id, clone(task));
  }

  async saveWorkSession(session: ProjectWorkSession) {
    this.workSessions.set(session.id, clone(session));
  }

  async saveWorkSessionEntry(entry: ProjectWorkSessionEntry) {
    this.workSessionEntries.set(entry.id, clone(entry));
  }

  async saveAtomically(changes: ProjectRepositoryChanges) {
    const apply = <T extends { id: string }>(
      target: Map<string, T>,
      values: readonly T[] | undefined,
    ) => values?.forEach((value) => target.set(value.id, clone(value)));

    apply(this.projects, changes.projects);
    apply(this.milestones, changes.milestones);
    apply(this.deliverables, changes.deliverables);
    apply(this.workSessions, changes.workSessions);
    apply(this.tasks, changes.tasks);
    apply(this.knowledgeItems, changes.knowledgeItems);
    apply(this.decisions, changes.decisions);
    apply(this.resources, changes.resources);
    apply(this.sections, changes.sections);
    apply(this.workSessionEntries, changes.workSessionEntries);
    apply(this.changeEvents, changes.changeEvents);
  }

  async reorderSections(projectId: string, sectionIds: readonly string[], updatedAt: string) {
    const sections = await this.listSections(projectId);
    const active = sections.filter((section) => section.status === 'active');
    if (
      sectionIds.length !== active.length ||
      new Set(sectionIds).size !== sectionIds.length ||
      sectionIds.some((id) => !active.some((section) => section.id === id))
    ) throw new Error('Section order must contain every active section in this Project.');

    sectionIds.forEach((id, position) => {
      const section = this.sections.get(id);
      if (!section || section.projectId !== projectId) {
        throw new Error('A section does not belong to this Project.');
      }
      this.sections.set(id, clone({ ...section, position, updatedAt }));
    });
    return this.listSections(projectId).then((values) =>
      values.filter((section) => section.status === 'active'));
  }

  private get<T>(values: Map<string, T>, id: string) {
    const value = values.get(id);
    return value ? clone(value) : null;
  }

  private uploadReservation(attempt: InMemoryUploadAttempt): ProjectAssetUploadReservation {
    return { assetId: attempt.assetId, attemptId: attempt.attemptId,
      objectExists: attempt.objectExists, objectId: attempt.objectId,
      projectId: attempt.projectId, sectionId: attempt.sectionId,
      status: attempt.finalized ? 'finalized' : 'pending', storagePath: attempt.storagePath };
  }
}
