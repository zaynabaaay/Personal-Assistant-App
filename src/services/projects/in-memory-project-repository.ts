import { orderWorkSessionEntries } from '@/domain/projects';
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
  assetPlacements?: (ProjectAssetSectionPlacement & { projectId: string })[];
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
  private readonly assetPlacements: (ProjectAssetSectionPlacement & { projectId: string })[];
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
    this.assetPlacements = clone(seed.assetPlacements ?? (seed.resources ?? [])
      .filter((resource) => resource.resourceKind === 'uploaded_asset' && resource.sectionId)
      .map((resource) => ({
        assetId: resource.id,
        createdAt: resource.createdAt,
        projectId: resource.projectId,
        sectionId: resource.sectionId!,
      })));
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

  async addAssetPlacement(projectId: string, assetId: string, sectionId: string) {
    const asset = this.requirePlacementAsset(projectId, assetId);
    this.requirePlacementSection(projectId, sectionId);
    const exists = this.assetPlacements.some((placement) => placement.projectId === projectId &&
      placement.assetId === assetId && placement.sectionId === sectionId);
    if (!exists) {
      this.assetPlacements.push({ assetId, createdAt: new Date().toISOString(), projectId, sectionId });
      await this.touchPlacementActivity(projectId);
    }
    return clone(asset);
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
    this.syncAssetPlacement(asset);
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

  async removeAssetPlacement(projectId: string, assetId: string, sectionId: string) {
    let asset = this.requirePlacementAsset(projectId, assetId);
    const placements = this.assetPlacements.filter((placement) =>
      placement.projectId === projectId && placement.assetId === assetId);
    const removed = placements.find((placement) => placement.sectionId === sectionId);
    if (!removed) return clone(asset);
    if (placements.length === 1) {
      throw new Error('This material must remain in at least one section for now.');
    }
    if (asset.sectionId === sectionId) {
      const fallback = placements.filter((placement) => placement.sectionId !== sectionId)
        .filter((placement) => this.sections.get(placement.sectionId)?.status === 'active')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
          left.sectionId.localeCompare(right.sectionId))[0];
      if (!fallback) {
        throw new Error('This material must remain in at least one active section for now.');
      }
      const updated = { ...asset, sectionId: fallback.sectionId, updatedAt: new Date().toISOString() };
      this.resources.set(assetId, clone(updated));
      this.syncAssetPlacement(updated, sectionId);
      asset = updated;
    } else {
      this.deleteAssetPlacement(projectId, assetId, sectionId);
      await this.touchPlacementActivity(projectId);
    }
    return clone(asset);
  }

  async replaceAssetPlacement(projectId: string, assetId: string, sourceSectionId: string,
    targetSectionId: string) {
    let asset = this.requirePlacementAsset(projectId, assetId);
    this.requirePlacementSection(projectId, targetSectionId);
    if (!this.assetPlacements.some((placement) => placement.projectId === projectId &&
      placement.assetId === assetId && placement.sectionId === sourceSectionId)) {
      throw new Error('The source section does not contain this material.');
    }
    if (sourceSectionId === targetSectionId) return clone(asset);
    if (asset.sectionId === sourceSectionId) {
      const updated = { ...asset, sectionId: targetSectionId, updatedAt: new Date().toISOString() };
      this.resources.set(assetId, clone(updated));
      this.syncAssetPlacement(updated, sourceSectionId);
      asset = updated;
    } else {
      const targetExists = this.assetPlacements.some((placement) => placement.projectId === projectId &&
        placement.assetId === assetId && placement.sectionId === targetSectionId);
      if (!targetExists) this.assetPlacements.push({ assetId, createdAt: new Date().toISOString(),
        projectId, sectionId: targetSectionId });
      this.deleteAssetPlacement(projectId, assetId, sourceSectionId);
      await this.touchPlacementActivity(projectId);
    }
    return clone(asset);
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

  async listAssetPlacements(projectId: string, assetId: string) {
    return this.assetPlacements
      .filter((placement) => placement.projectId === projectId && placement.assetId === assetId)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.sectionId.localeCompare(right.sectionId))
      .map(({ projectId: _projectId, ...placement }) => clone(placement));
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

  async listProjectAssets(projectId: string): Promise<ProjectGlobalAsset[]> {
    return listForProject(this.resources.values(), projectId)
      .filter((resource) => resource.resourceKind === 'uploaded_asset')
      .map(({ externalUrl: _externalUrl, sectionId: _sectionId, storagePath: _storagePath,
        ...resource }) => resource as ProjectGlobalAsset)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listResources(projectId: string) {
    return listForProject(this.resources.values(), projectId);
  }

  async listSectionAssetPlacements(projectId: string, sectionId: string) {
    return this.assetPlacements
      .filter((placement) => placement.projectId === projectId && placement.sectionId === sectionId)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.assetId.localeCompare(right.assetId))
      .map(({ projectId: _projectId, ...placement }) => clone(placement));
  }

  async listSectionAssets(projectId: string, sectionId: string): Promise<ProjectGlobalAsset[]> {
    const ids = (await this.listSectionAssetPlacements(projectId, sectionId)).map(({ assetId }) => assetId);
    return ids.flatMap((id) => {
      const resource = this.resources.get(id);
      if (!resource || resource.projectId !== projectId || resource.resourceKind !== 'uploaded_asset') return [];
      const { externalUrl: _externalUrl, sectionId: _sectionId, storagePath: _storagePath,
        ...safe } = clone(resource);
      return [safe as ProjectGlobalAsset];
    });
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
    const previous = this.resources.get(resource.id);
    this.resources.set(resource.id, clone(resource));
    if (resource.resourceKind === 'uploaded_asset') this.syncAssetPlacement(resource, previous?.sectionId);
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

  async touchProjectActivity(projectId: string, occurredAt: string) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project was not found.');
    if (occurredAt > project.updatedAt) {
      this.projects.set(projectId, clone({ ...project, updatedAt: occurredAt }));
    }
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
    changes.resources?.forEach((resource) => {
      const previous = this.resources.get(resource.id);
      this.resources.set(resource.id, clone(resource));
      if (resource.resourceKind === 'uploaded_asset') this.syncAssetPlacement(resource, previous?.sectionId);
    });
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

  private syncAssetPlacement(resource: ProjectResource, previousSectionId?: string) {
    if (!resource.sectionId) {
      throw new Error('Uploaded Project assets require an authoritative section relationship.');
    }
    if (previousSectionId && previousSectionId !== resource.sectionId) {
      this.deleteAssetPlacement(resource.projectId, resource.id, previousSectionId);
    }
    const exists = this.assetPlacements.some((placement) =>
      placement.projectId === resource.projectId && placement.assetId === resource.id &&
      placement.sectionId === resource.sectionId);
    if (!exists) this.assetPlacements.push({ assetId: resource.id, createdAt: resource.updatedAt,
      projectId: resource.projectId, sectionId: resource.sectionId });
    if (previousSectionId && previousSectionId !== resource.sectionId) {
      void this.touchPlacementActivity(resource.projectId);
    }
  }

  private deleteAssetPlacement(projectId: string, assetId: string, sectionId: string) {
    const index = this.assetPlacements.findIndex((placement) => placement.projectId === projectId &&
      placement.assetId === assetId && placement.sectionId === sectionId);
    if (index >= 0) this.assetPlacements.splice(index, 1);
  }

  private requirePlacementAsset(projectId: string, assetId: string) {
    const resource = this.resources.get(assetId);
    if (!resource || resource.projectId !== projectId || resource.resourceKind !== 'uploaded_asset') {
      throw new Error('Project asset was not found in this Project.');
    }
    return resource as ProjectAsset;
  }

  private requirePlacementSection(projectId: string, sectionId: string) {
    const section = this.sections.get(sectionId);
    if (!section || section.projectId !== projectId || section.status !== 'active') {
      throw new Error('The selected section is not active in this Project.');
    }
  }

  private async touchPlacementActivity(projectId: string) {
    try { await this.touchProjectActivity(projectId, new Date().toISOString()); } catch { /* secondary */ }
  }
}
