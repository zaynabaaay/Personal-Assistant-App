import { orderWorkSessionEntries } from '@/domain/projects';
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

import type {
  ProjectRepository,
  ProjectRepositoryChanges,
} from './project-repository';

export type InMemoryProjectRepositorySeed = {
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
  private readonly tasks: Map<string, ProjectTask>;
  private readonly workSessionEntries: Map<string, ProjectWorkSessionEntry>;
  private readonly workSessions: Map<string, ProjectWorkSession>;

  constructor(seed: InMemoryProjectRepositorySeed = {}) {
    this.changeEvents = createMap(seed.changeEvents);
    this.decisions = createMap(seed.decisions);
    this.deliverables = createMap(seed.deliverables);
    this.knowledgeItems = createMap(seed.knowledgeItems);
    this.milestones = createMap(seed.milestones);
    this.projects = createMap(seed.projects);
    this.resources = createMap(seed.resources);
    this.tasks = createMap(seed.tasks);
    this.workSessionEntries = createMap(seed.workSessionEntries);
    this.workSessions = createMap(seed.workSessions);
  }

  async addChangeEvent(event: ProjectChangeEvent) {
    this.changeEvents.set(event.id, clone(event));
  }

  async getDecision(id: string) {
    return this.get(this.decisions, id);
  }

  async getKnowledgeItem(id: string) {
    return this.get(this.knowledgeItems, id);
  }

  async getProject(id: string) {
    return this.get(this.projects, id);
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
    apply(this.workSessionEntries, changes.workSessionEntries);
    apply(this.changeEvents, changes.changeEvents);
  }

  private get<T>(values: Map<string, T>, id: string) {
    const value = values.get(id);
    return value ? clone(value) : null;
  }
}
