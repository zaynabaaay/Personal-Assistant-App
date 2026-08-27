export type CalendarPermissionState =
  | { status: 'granted' }
  | { canAskAgain: boolean; message: string; status: 'denied' }
  | { message: string; status: 'unavailable' };

export type CalendarEvent = {
  calendarName?: string;
  endDate: string;
  id: string;
  isAllDay: boolean;
  location?: string;
  startDate: string;
  timeZone?: string;
  title: string;
};

export type CalendarResult<T> =
  | { data: T; status: 'success' }
  | Exclude<CalendarPermissionState, { status: 'granted' }>
  | { message: string; status: 'error' };

export interface CalendarService {
  findNextUpcomingEvent(now?: Date): Promise<CalendarResult<CalendarEvent | null>>;
  getPermissionStatus(): Promise<CalendarPermissionState>;
  readEventsInRange(startDate: Date, endDate: Date): Promise<CalendarResult<CalendarEvent[]>>;
  readTodayEvents(now?: Date): Promise<CalendarResult<CalendarEvent[]>>;
  readTomorrowEvents(now?: Date): Promise<CalendarResult<CalendarEvent[]>>;
  requestPermission(): Promise<CalendarPermissionState>;
}
