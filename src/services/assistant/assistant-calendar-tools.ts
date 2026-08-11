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

export type AssistantCalendarToolCall = {
  arguments: AssistantCalendarToolArguments;
  callId: string;
  name: AssistantCalendarToolName;
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

export type AssistantCalendarToolOutput = {
  callId: string;
  result: AssistantCalendarToolResult;
};

export type AssistantCalendarToolContinuation = {
  calls: AssistantCalendarToolCall[];
  outputs: AssistantCalendarToolOutput[];
};
