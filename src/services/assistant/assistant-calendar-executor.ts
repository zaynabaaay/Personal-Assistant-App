import { calendarService } from '../calendar/calendar-service';
import type { CalendarEvent, CalendarResult } from '../calendar/calendar-types';
import type {
  AssistantCalendarEvent,
  AssistantCalendarToolCall,
  AssistantCalendarToolOutput,
  AssistantCalendarToolResult,
} from './assistant-calendar-tools';

const MAX_CALENDAR_EVENTS = 50;
const MAX_RANGE_DAYS = 366;
const MAX_EVENT_TITLE_LENGTH = 300;
const MAX_EVENT_LOCATION_LENGTH = 500;

function sanitizeEvent(
  event: CalendarEvent,
  includeLocations: boolean,
): AssistantCalendarEvent {
  const location = includeLocations
    ? event.location?.trim().slice(0, MAX_EVENT_LOCATION_LENGTH)
    : undefined;

  return {
    endTime: event.endDate,
    isAllDay: event.isAllDay,
    ...(location ? { location } : {}),
    startTime: event.startDate,
    title: event.title.trim().slice(0, MAX_EVENT_TITLE_LENGTH) || 'Untitled event',
  };
}

function sanitizeResult(
  result: CalendarResult<CalendarEvent[] | CalendarEvent | null>,
  includeLocations: boolean,
): AssistantCalendarToolResult {
  if (result.status === 'success') {
    const events = Array.isArray(result.data)
      ? result.data
      : result.data
        ? [result.data]
        : [];

    return {
      events: events
        .slice(0, MAX_CALENDAR_EVENTS)
        .map((event) => sanitizeEvent(event, includeLocations)),
      status: 'success',
    };
  }

  const messages = {
    denied: 'Calendar access was denied on this device.',
    error: 'Calendar events could not be read on this device.',
    unavailable: 'Device calendar access is available only in the native app.',
  } as const;

  return { message: messages[result.status], status: result.status };
}

function invalidRangeResult(): AssistantCalendarToolResult {
  return {
    message: 'The requested calendar date range was invalid.',
    status: 'error',
  };
}

export async function executeAssistantCalendarTool(
  call: AssistantCalendarToolCall,
): Promise<AssistantCalendarToolOutput> {
  return createAssistantCalendarToolExecutor(calendarService)(call);
}

export function createAssistantCalendarToolExecutor(service: typeof calendarService) {
  return async function executeTool(
    call: AssistantCalendarToolCall,
  ): Promise<AssistantCalendarToolOutput> {
    const { includeLocations } = call.arguments;
    let result: CalendarResult<CalendarEvent[] | CalendarEvent | null>;

    switch (call.name) {
      case 'get_today_calendar_events':
        result = await service.readTodayEvents();
        break;
      case 'get_tomorrow_calendar_events':
        result = await service.readTomorrowEvents();
        break;
      case 'get_next_calendar_event':
        result = await service.findNextUpcomingEvent();
        break;
      case 'get_calendar_events_in_range': {
        const startDate = new Date(call.arguments.startDateTime ?? '');
        const endDate = new Date(call.arguments.endDateTime ?? '');
        const rangeLength = endDate.getTime() - startDate.getTime();

        if (
          Number.isNaN(startDate.getTime()) ||
          Number.isNaN(endDate.getTime()) ||
          rangeLength <= 0 ||
          rangeLength > MAX_RANGE_DAYS * 24 * 60 * 60 * 1_000
        ) {
          return { callId: call.callId, result: invalidRangeResult() };
        }

        result = await service.readEventsInRange(startDate, endDate);
        break;
      }
    }

    return {
      callId: call.callId,
      result: sanitizeResult(result, includeLocations),
    };
  };
}
