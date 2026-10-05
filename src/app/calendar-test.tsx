import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  calendarService,
  type CalendarEvent,
  type CalendarResult,
} from '@/services/calendar/calendar-service';

type TestAction = 'next' | 'range' | 'today' | 'tomorrow';

const ACTION_LABELS: Record<TestAction, string> = {
  next: 'Next event',
  range: 'Next 7 days',
  today: 'Today',
  tomorrow: 'Tomorrow',
};

function eventSummary(event: CalendarEvent) {
  const start = new Date(event.startDate).toLocaleString();
  const end = new Date(event.endDate).toLocaleString();
  const details = [event.calendarName, event.location].filter(Boolean).join(' · ');

  return `${event.title}\n${start} – ${end}${details ? `\n${details}` : ''}`;
}

export default function CalendarTestScreen() {
  const [activeAction, setActiveAction] = useState<TestAction | null>(null);
  const [result, setResult] = useState<CalendarResult<CalendarEvent[] | CalendarEvent | null> | null>(
    null,
  );

  if (!__DEV__) {
    return <Redirect href="/" />;
  }

  const runTest = async (action: TestAction) => {
    setActiveAction(action);

    if (action === 'today') {
      setResult(await calendarService.readTodayEvents());
    } else if (action === 'tomorrow') {
      setResult(await calendarService.readTomorrowEvents());
    } else if (action === 'next') {
      setResult(await calendarService.findNextUpcomingEvent());
    } else {
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 7);
      setResult(await calendarService.readEventsInRange(startDate, endDate));
    }

    setActiveAction(null);
  };

  const events =
    result?.status === 'success'
      ? Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : []
      : [];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>Development only</Text>
        <Text style={styles.title}>Calendar access test</Text>
        <Text style={styles.description}>
          These actions read the device calendar. They do not send calendar data to the assistant.
        </Text>

        <View style={styles.actions}>
          {(Object.keys(ACTION_LABELS) as TestAction[]).map((action) => (
            <Pressable
              disabled={activeAction !== null}
              key={action}
              onPress={() => runTest(action)}
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            >
              <Text style={styles.buttonText}>
                {activeAction === action ? 'Reading…' : ACTION_LABELS[action]}
              </Text>
            </Pressable>
          ))}
        </View>

        {result ? (
          <View style={styles.results}>
            <Text style={styles.resultStatus}>Status: {result.status}</Text>
            {result.status === 'success' ? (
              events.length > 0 ? (
                events.map((event) => (
                  <Text key={`${event.id}-${event.startDate}`} style={styles.event}>
                    {eventSummary(event)}
                  </Text>
                ))
              ) : (
                <Text style={styles.message}>No matching events.</Text>
              )
            ) : (
              <Text style={styles.message}>{result.message}</Text>
            )}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 24 },
  button: {
    backgroundColor: '#E9E7E0',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonPressed: { opacity: 0.65 },
  buttonText: { color: '#3E3D39', fontSize: 15 },
  content: { padding: 24 },
  description: { color: '#6E6B64', fontSize: 15, lineHeight: 22, marginTop: 10 },
  event: {
    borderTopColor: '#DDDBD4',
    borderTopWidth: StyleSheet.hairlineWidth,
    color: '#3E3D39',
    fontSize: 15,
    lineHeight: 22,
    paddingVertical: 14,
  },
  eyebrow: { color: '#8B8983', fontSize: 12, textTransform: 'uppercase' },
  message: { color: '#5B5953', fontSize: 15, lineHeight: 22 },
  results: { marginTop: 30 },
  resultStatus: { color: '#8B8983', fontSize: 13, marginBottom: 12 },
  safeArea: { backgroundColor: '#F5F4F0', flex: 1 },
  title: { color: '#343330', fontSize: 28, marginTop: 6 },
});
