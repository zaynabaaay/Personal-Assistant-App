import { createUnavailableCalendarService } from './calendar-core';

export type {
  CalendarEvent,
  CalendarPermissionState,
  CalendarResult,
  CalendarService,
} from './calendar-types';

export const calendarService = createUnavailableCalendarService();
