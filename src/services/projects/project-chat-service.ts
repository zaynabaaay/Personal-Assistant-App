import type {
  ProjectWorkSession,
  ProjectWorkSessionEntry,
} from '@/domain/projects';

import type { ProjectRepository } from './project-repository';
import { ProjectService } from './project-service';

let fallbackSequence = 1;

function createId(prefix: string) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${fallbackSequence++}`;
}

export class ProjectChatService {
  private readonly projectService: ProjectService;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly now: () => Date = () => new Date(),
    projectService?: ProjectService,
  ) {
    this.projectService = projectService ?? new ProjectService(repository, { now });
  }

  private async createSession(projectId: string) {
    const occurredAt = this.now().toISOString();
    const session: ProjectWorkSession = {
      createdAt: occurredAt,
      id: createId('project-chat'),
      projectId,
      startedAt: occurredAt,
      title: 'Project chat',
      updatedAt: occurredAt,
    };
    await this.repository.saveWorkSession(session);
    return session;
  }

  async getOrCreateSession(projectId: string) {
    const project = await this.repository.getProject(projectId);
    if (!project) throw new Error('Project was not found.');

    const sessions = await this.repository.listWorkSessions(projectId);
    const open = [...sessions].reverse().find((session) => !session.endedAt);
    if (open) return open;

    return this.createSession(projectId);
  }

  async load(projectId: string) {
    const session = await this.getOrCreateSession(projectId);
    return {
      entries: await this.repository.listWorkSessionEntries(session.id),
      session,
    };
  }

  async startNewSession(session: ProjectWorkSession) {
    const current = await this.repository.getWorkSession(session.id);
    if (!current || current.projectId !== session.projectId) {
      throw new Error('The Project chat session is no longer available.');
    }

    if (!current.endedAt) {
      const entries = await this.repository.listWorkSessionEntries(current.id);
      const messageCount = entries.filter(
        (entry) => entry.kind === 'user_message' || entry.kind === 'assistant_message',
      ).length;
      const summary = `Project chat ended with ${messageCount} ${messageCount === 1 ? 'message' : 'messages'}.`;
      await this.projectService.closeWorkSession(
        current.id,
        summary,
        this.now().toISOString(),
      );
    }

    return this.createSession(current.projectId);
  }

  async append(
    session: ProjectWorkSession,
    kind: Extract<ProjectWorkSessionEntry['kind'], 'assistant_message' | 'user_message'>,
    content: string,
    position: number,
  ) {
    const current = await this.repository.getWorkSession(session.id);
    if (!current || current.projectId !== session.projectId || current.endedAt) {
      throw new Error('The Project chat session is no longer available.');
    }
    const entry: ProjectWorkSessionEntry = {
      content: content.trim(),
      id: createId('project-chat-entry'),
      kind,
      occurredAt: this.now().toISOString(),
      position,
      sessionId: session.id,
    };
    if (!entry.content) throw new Error('A Project chat message cannot be empty.');
    await this.repository.saveWorkSessionEntry(entry);
    return entry;
  }
}
