import { isRunningInExpoGo } from 'expo';
import * as ExpoCalendar from 'expo-calendar';
import { PermissionsAndroid, Platform } from 'react-native';

import {
  getLocalDayRange,
  isValidDateRange,
  selectNextUpcomingEvent,
  sortCalendarEvents,
} from './calendar-core';
import type {
  CalendarEvent,
  CalendarPermissionState,
  CalendarResult,
  CalendarService,
} from './calendar-types';

const EXPO_GO_MESSAGE =
  'Device calendar access requires an Expo development build and is unavailable in Expo Go.';
const PERMISSION_DENIED_MESSAGE =
  'Calendar permission was denied. You can enable it in the device settings.';
const CALENDAR_ERROR_MESSAGE = 'Calendar events could not be read.';
const NEXT_EVENT_LOOKAHEAD_DAYS = 365;

let permissionRequestedThisSession = false;

function unavailableState(): CalendarPermissionState | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return {
      message: 'Device calendar access is unavailable on this platform.',
      status: 'unavailable',
    };
  }

  if (isRunningInExpoGo()) {
    return { message: EXPO_GO_MESSAGE, status: 'unavailable' };
  }

  return null;
}

function deniedState(canAskAgain: boolean): CalendarPermissionState {
  return {
    canAskAgain,
    message: PERMISSION_DENIED_MESSAGE,
    status: 'denied',
  };
}

async function getPermissionStatus(): Promise<CalendarPermissionState> {
  const unavailable = unavailableState();

  if (unavailable) {
    return unavailable;
  }

  try {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_CALENDAR,
      );
      return granted ? { status: 'granted' } : deniedState(true);
    }

    const permission = await ExpoCalendar.getCalendarPermissions(false);
    return permission.granted
      ? { status: 'granted' }
      : deniedState(permission.canAskAgain);
  } catch {
    return {
      message: 'Device calendar access is unavailable in this app build.',
      status: 'unavailable',
    };
  }
}

async function requestPermission(): Promise<CalendarPermissionState> {
  const unavailable = unavailableState();

  if (unavailable) {
    return unavailable;
  }

  permissionRequestedThisSession = true;

  try {
    if (Platform.OS === 'android') {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_CALENDAR,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED
        ? { status: 'granted' }
        : deniedState(result !== PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    }

    // Reading calendar events requires full calendar access on iOS 17 and later.
    // `false` explicitly avoids requesting write-only permission.
    const permission = await ExpoCalendar.requestCalendarPermissions(false);
    return permission.granted
      ? { status: 'granted' }
      : deniedState(permission.canAskAgain);
  } catch {
    return {
      message: 'Device calendar access is unavailable in this app build.',
      status: 'unavailable',
    };
  }
}

async function ensurePermission() {
  const permission = await getPermissionStatus();

  if (
    permission.status === 'denied' &&
    permission.canAskAgain &&
    !permissionRequestedThisSession
  ) {
    return requestPermission();
  }

  return permission;
}

function normalizeEvent(
  event: ExpoCalendar.ExpoCalendarEvent,
  calendarNames: Map<string, string>,
): CalendarEvent {
  const location = event.location?.trim();
  const calendarName = calendarNames.get(event.calendarId)?.trim();
  const timeZone = event.timeZone?.trim();

  return {
    ...(calendarName ? { calendarName } : {}),
    endDate: new Date(event.endDate).toISOString(),
    id: event.instanceId ?? event.id,
    isAllDay: event.allDay,
    ...(location ? { location } : {}),
    startDate: new Date(event.startDate).toISOString(),
    ...(timeZone ? { timeZone } : {}),
    title: event.title.trim() || 'Untitled event',
  };
}

async function readEventsInRange(
  startDate: Date,
  endDate: Date,
): Promise<CalendarResult<CalendarEvent[]>> {
  if (!isValidDateRange(startDate, endDate)) {
    return { message: 'The requested calendar date range is invalid.', status: 'error' };
  }

  const permission = await ensurePermission();

  if (permission.status !== 'granted') {
    return permission;
  }

  try {
    const calendars = await ExpoCalendar.getCalendars(ExpoCalendar.EntityTypes.EVENT);
    const events = await ExpoCalendar.listEvents(calendars, startDate, endDate);
    const calendarNames = new Map(
      calendars.map((calendar) => [calendar.id, calendar.title]),
    );
    const normalizedEvents = events.flatMap((event) => {
      try {
        return [normalizeEvent(event, calendarNames)];
      } catch {
        return [];
      }
    });

    return { data: sortCalendarEvents(normalizedEvents), status: 'success' };
  } catch {
    return { message: CALENDAR_ERROR_MESSAGE, status: 'error' };
  }
}

const calendarService: CalendarService = {
  async findNextUpcomingEvent(now = new Date()) {
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + NEXT_EVENT_LOOKAHEAD_DAYS);
    const result = await readEventsInRange(now, endDate);

    return result.status === 'success'
      ? { data: selectNextUpcomingEvent(result.data, now), status: 'success' }
      : result;
  },
  getPermissionStatus,
  readEventsInRange,
  async readTodayEvents(now = new Date()) {
    const range = getLocalDayRange(now);
    return readEventsInRange(range.startDate, range.endDate);
  },
  async readTomorrowEvents(now = new Date()) {
    const range = getLocalDayRange(now, 1);
    return readEventsInRange(range.startDate, range.endDate);
  },
  requestPermission,
};

export type {
  CalendarEvent,
  CalendarPermissionState,
  CalendarResult,
  CalendarService,
} from './calendar-types';

export { calendarService };
