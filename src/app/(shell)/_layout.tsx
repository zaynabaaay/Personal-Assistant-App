import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

function TinaIcon({ focused }: { focused: boolean }) {
  return (
    <View style={styles.tinaIcon}>
      <View style={[styles.tinaBubble, focused && styles.iconFocused]} />
      <View style={[styles.tinaTail, focused && styles.tailFocused]} />
    </View>
  );
}

function ProjectsIcon({ focused }: { focused: boolean }) {
  return (
    <View style={[styles.projectsIcon, focused && styles.projectsIconFocused]}>
      <View style={[styles.projectLine, focused && styles.projectLineFocused]} />
      <View style={[styles.projectLine, styles.projectLineShort, focused && styles.projectLineFocused]} />
    </View>
  );
}

export default function ShellLayout() {
  return (
    <Tabs
      backBehavior="history"
      detachInactiveScreens={false}
      screenOptions={{
        animation: 'fade',
        headerShown: false,
        lazy: false,
        sceneStyle: styles.scene,
        tabBarActiveTintColor: '#F2F2F4',
        tabBarHideOnKeyboard: true,
        tabBarInactiveTintColor: '#66666C',
        tabBarItemStyle: styles.tabBarItem,
        tabBarLabelStyle: styles.label,
        tabBarStyle: styles.tabBar,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarAccessibilityLabel: 'Tina conversation',
          tabBarIcon: ({ focused }) => <TinaIcon focused={focused} />,
          tabBarLabel: ({ color }) => <Text style={[styles.label, { color }]}>Tina</Text>,
          title: 'Tina',
        }}
      />
      <Tabs.Screen
        name="projects/index"
        options={{
          tabBarAccessibilityLabel: 'Projects library',
          tabBarIcon: ({ focused }) => <ProjectsIcon focused={focused} />,
          tabBarLabel: ({ color }) => <Text style={[styles.label, { color }]}>Projects</Text>,
          title: 'Projects',
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  scene: { backgroundColor: '#050505' },
  tabBar: {
    backgroundColor: '#09090A',
    borderTopColor: '#202023',
    borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 0,
  },
  tabBarItem: { minHeight: 48, paddingTop: 4 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.1 },
  tinaIcon: { height: 21, position: 'relative', width: 22 },
  tinaBubble: {
    borderColor: '#66666C', borderRadius: 7, borderWidth: 1.5, height: 16, width: 21,
  },
  tinaTail: {
    borderBottomColor: '#66666C', borderBottomWidth: 1.5, height: 6,
    left: 4, position: 'absolute', top: 13, transform: [{ rotate: '-35deg' }], width: 6,
  },
  iconFocused: { borderColor: '#F2F2F4' },
  tailFocused: { borderBottomColor: '#F2F2F4' },
  projectsIcon: {
    borderColor: '#66666C', borderRadius: 4, borderWidth: 1.5,
    height: 19, justifyContent: 'center', paddingHorizontal: 4, width: 21,
  },
  projectsIconFocused: { borderColor: '#F2F2F4' },
  projectLine: { backgroundColor: '#66666C', borderRadius: 1, height: 1.5, width: 11 },
  projectLineFocused: { backgroundColor: '#F2F2F4' },
  projectLineShort: { marginTop: 4, width: 7 },
});
