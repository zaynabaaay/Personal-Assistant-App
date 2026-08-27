import {
  ASSISTANT_CALENDAR_TOOL_NAMES,
  type AssistantCalendarToolCall,
  type AssistantToolCall,
  type AssistantToolOutput,
} from '@/contracts/assistant';

import { executeAssistantCalendarTool } from './assistant-calendar-executor';

function isCalendarToolCall(
  call: AssistantToolCall,
): call is AssistantCalendarToolCall {
  return (
    call.execution === 'client' &&
    ASSISTANT_CALENDAR_TOOL_NAMES.some((name) => name === call.name)
  );
}

export async function executeAssistantClientTool(
  call: AssistantToolCall,
): Promise<AssistantToolOutput> {
  if (isCalendarToolCall(call)) {
    return executeAssistantCalendarTool(call);
  }

  throw new Error(`Unsupported client assistant tool: ${call.name}`);
}

