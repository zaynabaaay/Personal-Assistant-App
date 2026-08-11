import type {
  AssistantToolCall,
  AssistantToolOutput,
} from '../../contracts/assistant';

export type AssistantServerToolExecutor = (
  call: AssistantToolCall,
) => Promise<AssistantToolOutput>;

export async function executeAssistantServerTool(
  call: AssistantToolCall,
): Promise<AssistantToolOutput> {
  throw new Error(`No server executor is registered for assistant tool: ${call.name}`);
}
