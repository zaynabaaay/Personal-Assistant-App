import type {
  AssistantToolCall,
  AssistantToolContract,
  AssistantToolOutput,
} from './tool-contract';

export const ASSISTANT_CALENDAR_TOOL_NAMES = [
  'get_today_calendar_events',
  'get_tomorrow_calendar_events',
  'get_next_calendar_event',
  'get_calendar_events_in_range',
] as const;

export type AssistantCalendarToolName =
  (typeof ASSISTANT_CALENDAR_TOOL_NAMES)[number];

export type AssistantCalendarToolArguments = {
  endDateTime?: string;
  includeLocations: boolean;
  startDateTime?: string;
};

export type AssistantCalendarEvent = {
  endTime: string;
  isAllDay: boolean;
  location?: string;
  startTime: string;
  title: string;
};

export type AssistantCalendarToolResult =
  | { events: AssistantCalendarEvent[]; status: 'success' }
  | { message: string; status: 'denied' | 'error' | 'unavailable' };

export type AssistantCalendarToolCall = AssistantToolCall<
  AssistantCalendarToolName,
  'client',
  AssistantCalendarToolArguments
>;

export type AssistantCalendarToolOutput = AssistantToolOutput<
  AssistantCalendarToolName,
  'client',
  AssistantCalendarToolResult
>;

const MAX_ARGUMENT_LENGTH = 100;
const MAX_EVENT_COUNT = 50;
const MAX_EVENT_TITLE_LENGTH = 300;
const MAX_EVENT_LOCATION_LENGTH = 500;
const MAX_RESULT_MESSAGE_LENGTH = 150;
const MAX_RANGE_DAYS = 366;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isValidIsoDate(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_ARGUMENT_LENGTH) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isCalendarToolArgumentsForName(
  value: unknown,
  name: AssistantCalendarToolName,
): value is AssistantCalendarToolArguments {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const argumentsValue = value as Partial<AssistantCalendarToolArguments>;

  if (
    typeof argumentsValue.includeLocations !== 'boolean' ||
    !hasOnlyKeys(value, ['includeLocations', 'startDateTime', 'endDateTime'])
  ) {
    return false;
  }

  if (name !== 'get_calendar_events_in_range') {
    return (
      argumentsValue.startDateTime === undefined &&
      argumentsValue.endDateTime === undefined
    );
  }

  if (
    !isValidIsoDate(argumentsValue.startDateTime) ||
    !isValidIsoDate(argumentsValue.endDateTime)
  ) {
    return false;
  }

  const rangeLength =
    new Date(argumentsValue.endDateTime).getTime() -
    new Date(argumentsValue.startDateTime).getTime();

  return rangeLength > 0 && rangeLength <= MAX_RANGE_DAYS * 24 * 60 * 60 * 1_000;
}

function isCalendarEvent(value: unknown): value is AssistantCalendarEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const event = value as Partial<AssistantCalendarEvent>;
  return (
    hasOnlyKeys(value, ['endTime', 'isAllDay', 'location', 'startTime', 'title']) &&
    isBoundedString(event.title, MAX_EVENT_TITLE_LENGTH) &&
    isValidIsoDate(event.startTime) &&
    isValidIsoDate(event.endTime) &&
    typeof event.isAllDay === 'boolean' &&
    (event.location === undefined ||
      isBoundedString(event.location, MAX_EVENT_LOCATION_LENGTH))
  );
}

export function isAssistantCalendarToolResult(
  value: unknown,
): value is AssistantCalendarToolResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const result = value as Partial<AssistantCalendarToolResult>;

  if (result.status === 'success') {
    return (
      hasOnlyKeys(value, ['events', 'status']) &&
      Array.isArray(result.events) &&
      result.events.length <= MAX_EVENT_COUNT &&
      result.events.every(isCalendarEvent)
    );
  }

  return (
    hasOnlyKeys(value, ['message', 'status']) &&
    (result.status === 'denied' ||
      result.status === 'error' ||
      result.status === 'unavailable') &&
    isBoundedString(result.message, MAX_RESULT_MESSAGE_LENGTH)
  );
}

function calendarToolContract(
  name: AssistantCalendarToolName,
  description: string,
  parameters: Record<string, unknown>,
): AssistantToolContract<
  AssistantCalendarToolName,
  'client',
  AssistantCalendarToolArguments,
  AssistantCalendarToolResult
> {
  return {
    execution: 'client',
    isArguments: (value): value is AssistantCalendarToolArguments =>
      isCalendarToolArgumentsForName(value, name),
    isResult: isAssistantCalendarToolResult,
    name,
    openAI: { description, parameters, strict: true, type: 'function' },
  };
}

const LOCATION_PROPERTY = {
  type: 'boolean',
  description: 'True only when event locations are needed to answer the question.',
} as const;

function locationOnlyParameters() {
  return {
    type: 'object',
    properties: { includeLocations: LOCATION_PROPERTY },
    required: ['includeLocations'],
    additionalProperties: false,
  };
}

export const ASSISTANT_CALENDAR_TOOL_CONTRACTS = [
  calendarToolContract(
    'get_today_calendar_events',
    "Read today's device calendar events. Use only when the user's request needs today's calendar facts.",
    locationOnlyParameters(),
  ),
  calendarToolContract(
    'get_tomorrow_calendar_events',
    "Read tomorrow's device calendar events. Use only when the user's request needs tomorrow's calendar facts.",
    locationOnlyParameters(),
  ),
  calendarToolContract(
    'get_next_calendar_event',
    'Read the next upcoming device calendar event. Use only when the request needs the next event.',
    locationOnlyParameters(),
  ),
  calendarToolContract(
    'get_calendar_events_in_range',
    'Read device calendar events in a precise date/time range, including availability questions. Use the authoritative app timezone.',
    {
      type: 'object',
      properties: {
        startDateTime: {
          type: 'string',
          description: 'Inclusive ISO 8601 range start with timezone offset.',
        },
        endDateTime: {
          type: 'string',
          description: 'Exclusive ISO 8601 range end with timezone offset.',
        },
        includeLocations: LOCATION_PROPERTY,
      },
      required: ['startDateTime', 'endDateTime', 'includeLocations'],
      additionalProperties: false,
    },
  ),
] as const;

