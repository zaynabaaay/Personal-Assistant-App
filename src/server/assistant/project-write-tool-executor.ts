import type {
  AssistantProjectWriteToolCall,
  AssistantProjectWriteToolOutput,
  AssistantProjectWriteToolResult,
  CreateProjectToolArguments,
  ManageProjectWorkToolArguments,
  RecordProjectTruthToolArguments,
  UpdateProjectToolArguments,
} from '../../contracts/assistant';
import { ProjectDomainError } from '../../domain/projects';
import type { ProjectDeliverable, ProjectMilestone, ProjectTask } from '../../domain/projects';
import type { ProjectRepository } from '../../services/projects/project-repository';
import { ProjectService } from '../../services/projects/project-service';
import { createServerProjectRepository, type ServerProjectRepositoryContext } from '../projects/server-project-repository';

type ProjectRepositoryFactory = (context: ServerProjectRepositoryContext) => ProjectRepository;
type Success = Extract<AssistantProjectWriteToolResult, { status: 'success' }>;

function absent<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function success(
  outcome: Success['outcome'],
  kind: string,
  value: { id: string; projectId?: string; name?: string; statement?: string; status?: string; title?: string },
  projectId = value.projectId ?? value.id,
): Success {
  const label = value.name ?? value.title ?? value.statement ?? value.id;
  const verb = outcome === 'created' ? 'Created' : outcome === 'updated' ? 'Updated' : 'Already present';
  return {
    entity: { id: value.id, kind, label, projectId, ...(value.status ? { state: value.status } : {}) },
    message: `${verb}: ${label}`,
    outcome,
    status: 'success',
  };
}

function clarification(message: string): AssistantProjectWriteToolResult {
  return { message, status: 'clarification_required' };
}

function inputPatch<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

async function executeCreate(service: ProjectService, args: CreateProjectToolArguments): Promise<AssistantProjectWriteToolResult> {
  const result = await service.createProject({
    description: absent(args.description), goal: absent(args.goal), name: args.name,
    priority: args.priority, startDate: absent(args.startDate), status: args.status,
    targetDate: absent(args.targetDate), timezone: args.timezone, type: args.type,
  });
  return success(result.outcome, 'project', result.value);
}

async function executeProjectUpdate(service: ProjectService, args: UpdateProjectToolArguments): Promise<AssistantProjectWriteToolResult> {
  if (!args.projectId) return clarification('Which Project should I update?');
  const patch = inputPatch({ description: args.description, goal: args.goal, name: args.name,
    priority: args.priority, startDate: args.startDate, status: args.status,
    targetDate: args.targetDate, type: args.type });
  if (Object.keys(patch).length === 0) return clarification('What Project field should I update?');
  const result = await service.updateProject(args.projectId, patch);
  return success(result.outcome, 'project', result.value);
}

function taskStatus(value: string | null): Exclude<ProjectTask['status'], 'completed'> | undefined {
  return value && ['todo', 'in_progress', 'blocked', 'cancelled'].includes(value)
    ? value as Exclude<ProjectTask['status'], 'completed'> : undefined;
}

function milestoneStatus(value: string | null): ProjectMilestone['status'] | undefined {
  return value && ['planned', 'active', 'completed', 'cancelled'].includes(value)
    ? value as ProjectMilestone['status'] : undefined;
}

function deliverableStatus(value: string | null): ProjectDeliverable['status'] | undefined {
  return value && ['planned', 'in_progress', 'review', 'completed', 'cancelled'].includes(value)
    ? value as ProjectDeliverable['status'] : undefined;
}

async function executeWork(service: ProjectService, args: ManageProjectWorkToolArguments): Promise<AssistantProjectWriteToolResult> {
  if (!args.projectId) return clarification('Which Project should I change?');
  const updateNeedsEntity = !args.operation.startsWith('create_');
  if (updateNeedsEntity && !args.entityId) return clarification('Which task, milestone, or deliverable do you mean?');
  if (args.operation.startsWith('create_') && !args.name) return clarification('What should the new item be called?');

  if (args.operation === 'create_task') {
    const result = await service.createTask(args.projectId, { description: absent(args.description), dueDate: absent(args.dueDate),
      priority: absent(args.priority), status: taskStatus(args.status), title: args.name! });
    return success(result.outcome, 'task', result.value);
  }
  if (args.operation === 'update_task') {
    const result = await service.updateTask(args.projectId, args.entityId!, inputPatch({ description: args.description,
      dueDate: args.dueDate, priority: args.priority, status: taskStatus(args.status) ?? null, title: args.name }));
    return success(result.outcome, 'task', result.value);
  }
  if (args.operation === 'complete_task') {
    const result = await service.updateTask(args.projectId, args.entityId!, { status: 'completed' });
    return success(result.outcome, 'task', result.value);
  }
  if (args.operation === 'create_milestone') {
    const result = await service.createMilestone(args.projectId, { description: absent(args.description), name: args.name!,
      status: milestoneStatus(args.status), targetDate: absent(args.targetDate) });
    return success(result.outcome, 'milestone', result.value);
  }
  if (args.operation === 'update_milestone') {
    const result = await service.updateMilestone(args.projectId, args.entityId!, inputPatch({ description: args.description,
      name: args.name, status: milestoneStatus(args.status) ?? null, targetDate: args.targetDate }));
    return success(result.outcome, 'milestone', result.value);
  }
  if (args.operation === 'create_deliverable') {
    const result = await service.createDeliverable(args.projectId, { description: absent(args.description), dueDate: absent(args.dueDate),
      milestoneId: absent(args.milestoneId), name: args.name!, status: deliverableStatus(args.status) });
    return success(result.outcome, 'deliverable', result.value);
  }
  const result = await service.updateDeliverable(args.projectId, args.entityId!, inputPatch({ description: args.description,
    dueDate: args.dueDate, milestoneId: args.milestoneId, name: args.name,
    status: deliverableStatus(args.status) ?? null }));
  return success(result.outcome, 'deliverable', result.value);
}

async function executeTruth(service: ProjectService, args: RecordProjectTruthToolArguments): Promise<AssistantProjectWriteToolResult> {
  if (!args.projectId) return clarification('Which Project should I update?');
  const replacing = args.operation === 'replace_knowledge' || args.operation === 'replace_decision';
  if (replacing && args.confirmation !== 'confirmed_replacement') {
    return { message: 'Please confirm that this should replace the current Project truth before I save it.', status: 'confirmation_required' };
  }
  if (replacing && !args.entityId) return clarification('Which current knowledge item or decision should be replaced?');
  if (args.operation === 'add_knowledge' || args.operation === 'add_question') {
    if (!args.content) return clarification('What information should I save?');
    const result = await service.addCurrentKnowledge(args.projectId, { content: args.content,
      kind: args.operation === 'add_question' ? 'question' : args.kind ?? 'note', title: absent(args.title) });
    return success(result.outcome, args.operation === 'add_question' ? 'question' : 'knowledge', result.value);
  }
  if (args.operation === 'add_decision') {
    if (!args.statement) return clarification('What confirmed decision should I save?');
    const result = await service.addDecision(args.projectId, { rationale: absent(args.rationale), statement: args.statement });
    return success(result.outcome, 'decision', result.value);
  }
  if (args.operation === 'replace_knowledge') {
    if (!args.content) return clarification('What should replace the current knowledge?');
    const result = await service.replaceKnowledge(args.projectId, args.entityId!, { content: args.content,
      kind: args.kind ?? 'note', title: absent(args.title) });
    return success(result.outcome, 'knowledge', result.value);
  }
  if (!args.statement) return clarification('What should replace the current decision?');
  const result = await service.replaceDecision(args.projectId, args.entityId!, { rationale: absent(args.rationale), statement: args.statement });
  return success(result.outcome, 'decision', result.value);
}

export function createAssistantProjectWriteToolExecutor(
  createRepository: ProjectRepositoryFactory = createServerProjectRepository,
) {
  return async (call: AssistantProjectWriteToolCall, context: ServerProjectRepositoryContext): Promise<AssistantProjectWriteToolOutput> => {
    let result: AssistantProjectWriteToolResult;
    try {
      const service = new ProjectService(createRepository(context));
      result = call.name === 'create_project'
        ? await executeCreate(service, call.arguments as CreateProjectToolArguments)
        : call.name === 'update_project'
          ? await executeProjectUpdate(service, call.arguments as UpdateProjectToolArguments)
          : call.name === 'manage_project_work'
            ? await executeWork(service, call.arguments as ManageProjectWorkToolArguments)
            : await executeTruth(service, call.arguments as RecordProjectTruthToolArguments);
    } catch (error) {
      if (error instanceof ProjectDomainError) {
        const status: 'clarification_required' | 'error' | 'not_found' =
          error.code === 'not_found' ? 'not_found' :
            error.code === 'project_mismatch' ? 'clarification_required' : 'error';
        result = { message: error.message, status };
      } else {
        console.error('Project assistant write tool failed.', error);
        result = { message: 'The Project update could not be saved.', status: 'error' };
      }
    }
    return { callId: call.callId, execution: 'server', name: call.name, result };
  };
}

export const executeAssistantProjectWriteTool = createAssistantProjectWriteToolExecutor();
