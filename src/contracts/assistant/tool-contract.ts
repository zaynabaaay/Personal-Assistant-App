export type AssistantToolExecution = 'client' | 'server';

export const MAX_ASSISTANT_TOOL_STEPS = 6;

export type AssistantToolCall<
  Name extends string = string,
  Execution extends AssistantToolExecution = AssistantToolExecution,
  Arguments = unknown,
> = {
  arguments: Arguments;
  callId: string;
  execution: Execution;
  name: Name;
};

export type AssistantToolOutput<
  Name extends string = string,
  Execution extends AssistantToolExecution = AssistantToolExecution,
  Result = unknown,
> = {
  callId: string;
  execution: Execution;
  name: Name;
  result: Result;
};

export type AssistantToolStep = {
  calls: AssistantToolCall[];
  outputs: AssistantToolOutput[];
};

export type AssistantToolContinuation = {
  steps: AssistantToolStep[];
};

export type AssistantToolContract<
  Name extends string = string,
  Execution extends AssistantToolExecution = AssistantToolExecution,
  Arguments = unknown,
  Result = unknown,
> = {
  execution: Execution;
  isArguments: (value: unknown) => value is Arguments;
  isResult: (value: unknown) => value is Result;
  name: Name;
  openAI: {
    description: string;
    parameters: Record<string, unknown>;
    strict: true;
    type: 'function';
  };
};
