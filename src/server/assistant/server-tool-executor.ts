import {
  ASSISTANT_CONVERSATION_HISTORY_TOOL_NAMES,
  ASSISTANT_MEMORY_TOOL_NAMES,
  ASSISTANT_PROJECT_TOOL_NAMES,
  ASSISTANT_PROJECT_WRITE_TOOL_NAMES,
  type AssistantConversationHistoryToolCall,
  type AssistantMemoryToolCall,
  type AssistantProjectToolCall,
  type AssistantProjectWriteToolCall,
  type AssistantToolCall,
  type AssistantToolOutput,
} from '../../contracts/assistant';

import { executeAssistantConversationHistoryTool } from './conversation-history-tool-executor';
import { executeAssistantMemoryTool } from './memory-tool-executor';
import { executeAssistantProjectTool } from './project-tool-executor';
import { executeAssistantProjectWriteTool } from './project-write-tool-executor';

export type AssistantServerToolContext = {
  accessToken: string;
  userId: string;
};

export type AssistantServerToolExecutor = (
  call: AssistantToolCall,
  context: AssistantServerToolContext,
) => Promise<AssistantToolOutput>;

type AssistantServerToolExecutors = {
  history: typeof executeAssistantConversationHistoryTool;
  memory: typeof executeAssistantMemoryTool;
  project: typeof executeAssistantProjectTool;
  projectWrite: typeof executeAssistantProjectWriteTool;
};

const DEFAULT_EXECUTORS: AssistantServerToolExecutors = {
  history: executeAssistantConversationHistoryTool,
  memory: executeAssistantMemoryTool,
  project: executeAssistantProjectTool,
  projectWrite: executeAssistantProjectWriteTool,
};

export async function executeAssistantServerTool(
  call: AssistantToolCall,
  context: AssistantServerToolContext,
  executors: AssistantServerToolExecutors = DEFAULT_EXECUTORS,
): Promise<AssistantToolOutput> {
  if (
    ASSISTANT_MEMORY_TOOL_NAMES.includes(
      call.name as (typeof ASSISTANT_MEMORY_TOOL_NAMES)[number],
    ) && call.execution === 'server'
  ) {
    return executors.memory(call as AssistantMemoryToolCall, context);
  }

  if (
    ASSISTANT_CONVERSATION_HISTORY_TOOL_NAMES.includes(
      call.name as (typeof ASSISTANT_CONVERSATION_HISTORY_TOOL_NAMES)[number],
    ) && call.execution === 'server'
  ) {
    return executors.history(
      call as AssistantConversationHistoryToolCall,
      context,
    );
  }

  if (
    ASSISTANT_PROJECT_TOOL_NAMES.includes(
      call.name as (typeof ASSISTANT_PROJECT_TOOL_NAMES)[number],
    ) &&
    call.execution === 'server'
  ) {
    return executors.project(call as AssistantProjectToolCall, context);
  }

  if (
    ASSISTANT_PROJECT_WRITE_TOOL_NAMES.includes(
      call.name as (typeof ASSISTANT_PROJECT_WRITE_TOOL_NAMES)[number],
    ) && call.execution === 'server'
  ) {
    return executors.projectWrite(call as AssistantProjectWriteToolCall, context);
  }

  throw new Error(`No server executor is registered for assistant tool: ${call.name}`);
}
