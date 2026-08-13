import {
  ASSISTANT_PROJECT_TOOL_NAMES,
  ASSISTANT_PROJECT_WRITE_TOOL_NAMES,
  type AssistantProjectToolCall,
  type AssistantProjectWriteToolCall,
  type AssistantToolCall,
  type AssistantToolOutput,
} from '../../contracts/assistant';

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

export async function executeAssistantServerTool(
  call: AssistantToolCall,
  context: AssistantServerToolContext,
): Promise<AssistantToolOutput> {
  if (
    ASSISTANT_PROJECT_TOOL_NAMES.includes(
      call.name as (typeof ASSISTANT_PROJECT_TOOL_NAMES)[number],
    ) &&
    call.execution === 'server'
  ) {
    return executeAssistantProjectTool(call as AssistantProjectToolCall, context);
  }

  if (
    ASSISTANT_PROJECT_WRITE_TOOL_NAMES.includes(
      call.name as (typeof ASSISTANT_PROJECT_WRITE_TOOL_NAMES)[number],
    ) && call.execution === 'server'
  ) {
    return executeAssistantProjectWriteTool(call as AssistantProjectWriteToolCall, context);
  }

  throw new Error(`No server executor is registered for assistant tool: ${call.name}`);
}
