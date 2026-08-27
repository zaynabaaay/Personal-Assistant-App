import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLocalDayRange,
  isValidDateRange,
  selectNextUpcomingEvent,
} from '../src/services/calendar/calendar-core.ts';
import { calendarService } from '../src/services/calendar/calendar-service.ts';

function event(id, startDate, endDate = startDate) {
  return {
    endDate,
    id,
    isAllDay: false,
    startDate,
    title: id,
  };
}

test('today and tomorrow ranges use local calendar-day boundaries', () => {
  const now = new Date(2026, 7, 11, 15, 30);
  const today = getLocalDayRange(now);
  const tomorrow = getLocalDayRange(now, 1);

  assert.deepEqual(
    [today.startDate.getHours(), today.startDate.getDate(), today.endDate.getDate()],
    [0, 11, 12],
  );
  assert.deepEqual(
    [tomorrow.startDate.getHours(), tomorrow.startDate.getDate(), tomorrow.endDate.getDate()],
    [0, 12, 13],
  );
});

test('requested ranges must contain valid dates and end after they begin', () => {
  assert.equal(isValidDateRange(new Date('2026-08-11'), new Date('2026-08-12')), true);
  assert.equal(isValidDateRange(new Date('invalid'), new Date('2026-08-12')), false);
  assert.equal(isValidDateRange(new Date('2026-08-12'), new Date('2026-08-11')), false);
});

test('next upcoming event ignores past events and returns the earliest future start', () => {
  const now = new Date('2026-08-11T14:00:00.000Z');
  const events = [
    event('later', '2026-08-11T18:00:00.000Z'),
    event('past', '2026-08-11T12:00:00.000Z'),
    event('next', '2026-08-11T15:00:00.000Z'),
  ];

  assert.equal(selectNextUpcomingEvent(events, now)?.id, 'next');
});

test('the non-native calendar service returns a safe unavailable state', async () => {
  const result = await calendarService.readTodayEvents();

  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /unavailable/i);
});
