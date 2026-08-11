export type AssistantContext = {
  currentLocalDate: string;
  currentLocalTime: string;
  dayOfWeek: string;
  timezone: string;
};

const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const LOCAL_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const DAY_OF_WEEK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
});

export function createAssistantContext(now = new Date()): AssistantContext {
  return {
    currentLocalDate: LOCAL_DATE_FORMATTER.format(now),
    currentLocalTime: LOCAL_TIME_FORMATTER.format(now),
    dayOfWeek: DAY_OF_WEEK_FORMATTER.format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
