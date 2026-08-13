import { ASSISTANT_CALENDAR_TOOL_CONTRACTS } from './calendar-tool-contract';
import { ASSISTANT_PROJECT_TOOL_CONTRACTS } from './project-tool-contract';
import { ASSISTANT_PROJECT_WRITE_TOOL_CONTRACTS } from './project-write-tool-contract';
import type {
  AssistantToolCall,
  AssistantToolContract,
  AssistantToolOutput,
  AssistantToolStep,
} from './tool-contract';

export const ASSISTANT_TOOL_CONTRACTS: readonly AssistantToolContract[] = [
  ...ASSISTANT_CALENDAR_TOOL_CONTRACTS,
  ...ASSISTANT_PROJECT_TOOL_CONTRACTS,
  ...ASSISTANT_PROJECT_WRITE_TOOL_CONTRACTS,
];

export function getAssistantToolContract(name: unknown) {
  return typeof name === 'string'
    ? ASSISTANT_TOOL_CONTRACTS.find((contract) => contract.name === name) ?? null
    : null;
}

export function isAssistantToolCall(value: unknown): value is AssistantToolCall {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const call = value as Partial<AssistantToolCall>;
  const contract = getAssistantToolContract(call.name);

  return (
    !!contract &&
    typeof call.callId === 'string' &&
    call.callId.length > 0 &&
    call.callId.length <= 100 &&
    call.execution === contract.execution &&
    contract.isArguments(call.arguments)
  );
}

export function isAssistantToolOutput(
  value: unknown,
): value is AssistantToolOutput {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const output = value as Partial<AssistantToolOutput>;
  const contract = getAssistantToolContract(output.name);

  return (
    !!contract &&
    typeof output.callId === 'string' &&
    output.callId.length > 0 &&
    output.callId.length <= 100 &&
    output.execution === contract.execution &&
    contract.isResult(output.result)
  );
}

export function isCompleteAssistantToolStep(
  value: unknown,
): value is AssistantToolStep {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const step = value as Partial<AssistantToolStep>;

  if (
    !Array.isArray(step.calls) ||
    !Array.isArray(step.outputs) ||
    step.calls.length < 1 ||
    step.calls.length > 4 ||
    step.calls.length !== step.outputs.length ||
    !step.calls.every(isAssistantToolCall) ||
    !step.outputs.every(isAssistantToolOutput)
  ) {
    return false;
  }

  const callsById = new Map(step.calls.map((call) => [call.callId, call]));
  return (
    callsById.size === step.calls.length &&
    new Set(step.outputs.map((output) => output.callId)).size === step.outputs.length &&
    step.outputs.every((output) => {
      const call = callsById.get(output.callId);
      return (
        call?.name === output.name && call.execution === output.execution
      );
    })
  );
}

export function isPendingAssistantToolStep(
  value: unknown,
): value is AssistantToolStep {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const step = value as Partial<AssistantToolStep>;

  if (
    !Array.isArray(step.calls) ||
    !Array.isArray(step.outputs) ||
    step.calls.length < 1 ||
    step.calls.length > 4 ||
    step.outputs.length >= step.calls.length ||
    !step.calls.every(isAssistantToolCall) ||
    !step.outputs.every(isAssistantToolOutput)
  ) {
    return false;
  }

  const callsById = new Map(step.calls.map((call) => [call.callId, call]));
  return (
    callsById.size === step.calls.length &&
    new Set(step.outputs.map((output) => output.callId)).size === step.outputs.length &&
    step.outputs.every((output) => {
      const call = callsById.get(output.callId);
      return call?.name === output.name && call.execution === output.execution;
    }) &&
    step.calls.some(
      (call) =>
        call.execution === 'client' &&
        !step.outputs?.some((output) => output.callId === call.callId),
    )
  );
}
