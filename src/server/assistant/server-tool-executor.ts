import type {
  AssistantToolCall,
  AssistantToolOutput,
} from '../../contracts/assistant';

export type AssistantServerToolContext = {
  userId: string;
};

export type AssistantServerToolExecutor = (
  call: AssistantToolCall,
  context: AssistantServerToolContext,
) => Promise<AssistantToolOutput>;

export async function executeAssistantServerTool(
  call: AssistantToolCall,
  _context: AssistantServerToolContext,
): Promise<AssistantToolOutput> {
  throw new Error(`No server executor is registered for assistant tool: ${call.name}`);
}
