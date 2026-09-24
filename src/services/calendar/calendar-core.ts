import type { CalendarEvent, CalendarService } from './calendar-types';

export const CALENDAR_UNAVAILABLE_MESSAGE =
  'Device calendar access is unavailable on this platform.';

export function getLocalDayRange(date: Date, dayOffset = 0) {
  const startDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayOffset,
  );
  const endDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayOffset + 1,
  );

  return { endDate, startDate };
}

export function isValidDateRange(startDate: Date, endDate: Date) {
  return (
    Number.isFinite(startDate.getTime()) &&
    Number.isFinite(endDate.getTime()) &&
    endDate.getTime() > startDate.getTime()
  );
}

export function sortCalendarEvents(events: CalendarEvent[]) {
  return [...events].sort((left, right) => {
    const startDifference =
      new Date(left.startDate).getTime() - new Date(right.startDate).getTime();

    if (startDifference !== 0) {
      return startDifference;
    }

    return new Date(left.endDate).getTime() - new Date(right.endDate).getTime();
  });
}

export function selectNextUpcomingEvent(events: CalendarEvent[], now: Date) {
  const nowTime = now.getTime();

  return (
    sortCalendarEvents(events).find(
      (event) => new Date(event.startDate).getTime() >= nowTime,
    ) ?? null
  );
}

export function createUnavailableCalendarService(
  message = CALENDAR_UNAVAILABLE_MESSAGE,
): CalendarService {
  const unavailable = () => ({ message, status: 'unavailable' }) as const;

  return {
    async findNextUpcomingEvent() {
      return unavailable();
    },
    async getPermissionStatus() {
      return unavailable();
    },
    async readEventsInRange() {
      return unavailable();
    },
    async readTodayEvents() {
      return unavailable();
    },
    async readTomorrowEvents() {
      return unavailable();
    },
    async requestPermission() {
      return unavailable();
    },
  };
}
