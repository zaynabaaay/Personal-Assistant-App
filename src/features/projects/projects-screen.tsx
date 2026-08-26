import { useCallback, useState } from 'react';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Project } from '@/domain/projects';
import { projectRepository } from '@/services/projects/project-client';

import {
  groupProjects,
  projectDescription,
  projectFallbackInitial,
} from './project-presentation';
import {
  projectViewPreference,
  type ProjectViewMode,
} from './project-view-preference';

function ViewToggle({ mode, onChange }: { mode: ProjectViewMode; onChange: (mode: ProjectViewMode) => void }) {
  return (
    <View accessibilityLabel="Project layout" style={styles.toggle} testID="projects-view-toggle">
      {(['list', 'grid'] as const).map((value) => (
        <Pressable
          accessibilityLabel={`${value === 'list' ? 'List' : 'Grid'} view`}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === value }}
          key={value}
          onPress={() => onChange(value)}
          style={[styles.toggleButton, mode === value && styles.toggleButtonSelected]}
          testID={`projects-${value}-view`}
        >
          <Text style={[styles.toggleText, mode === value && styles.toggleTextSelected]}>
            {value === 'list' ? '☷' : '▦'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ProjectItem({ mode, onPress, project }: {
  mode: ProjectViewMode;
  onPress: () => void;
  project: Project;
}) {
  if (mode === 'grid') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.gridCard, pressed && styles.pressed]}
        testID={`project-card-${project.id}`}
      >
        <View style={styles.fallbackCover} testID="project-cover-fallback">
          <Text style={styles.fallbackInitial}>{projectFallbackInitial(project)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.gridName}>{project.name}</Text>
        <Text numberOfLines={2} style={styles.gridDescription}>{projectDescription(project)}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && styles.pressed]}
      testID={`project-row-${project.id}`}
    >
      <View style={styles.listInitial}><Text style={styles.listInitialText}>{projectFallbackInitial(project)}</Text></View>
      <View style={styles.listCopy}>
        <Text numberOfLines={1} style={styles.listName}>{project.name}</Text>
        <Text numberOfLines={2} style={styles.listDescription}>{projectDescription(project)}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function ProjectSection({ mode, projects, quiet, title, onOpen }: {
  mode: ProjectViewMode;
  projects: Project[];
  quiet?: boolean;
  title: string;
  onOpen: (project: Project) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <View style={[styles.section, quiet && styles.quietSection]} testID={`projects-section-${title.toLowerCase()}`}>
      <Text style={[styles.sectionTitle, quiet && styles.quietTitle]}>{title}</Text>
      <View style={mode === 'grid' ? styles.grid : styles.list}>
        {projects.map((project) => (
          <ProjectItem key={project.id} mode={mode} onPress={() => onOpen(project)} project={project} />
        ))}
      </View>
    </View>
  );
}

export default function ProjectsScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<ProjectViewMode>('list');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([projectRepository.listProjects(), projectViewPreference.load()]).then(
      ([values, savedMode]) => {
        if (!active) return;
        setProjects(values);
        setMode(savedMode);
      },
      () => active && setError('Projects could not be loaded.'),
    ).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []));

  const groups = groupProjects(projects);
  const changeMode = (value: ProjectViewMode) => {
    setMode(value);
    void projectViewPreference.save(value).catch(() => undefined);
  };
  const openProject = (project: Project) => router.push({
    pathname: '/projects/[id]',
    params: { id: project.id },
  } as unknown as Href);

  return (
    <SafeAreaView style={styles.safeArea} testID="projects-screen">
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back to Tina" onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Projects</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/projects/new' as Href)}
          style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
          testID="new-project-button"
        >
          <Text style={styles.newButtonText}>+ New Project</Text>
        </Pressable>
      </View>
      <View style={styles.controls}><View /><ViewToggle mode={mode} onChange={changeMode} /></View>

      {loading ? <View style={styles.center}><ActivityIndicator color="#8F8F95" /></View> : error ? (
        <View style={styles.center}><Text style={styles.error}>{error}</Text></View>
      ) : projects.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No Projects yet</Text>
          <Text style={styles.emptyBody}>Create a workspace when something deserves ongoing attention.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ProjectSection mode={mode} onOpen={openProject} projects={groups.active} title="Active" />
          <ProjectSection mode={mode} onOpen={openProject} projects={groups.paused} quiet title="Paused" />
          <ProjectSection mode={mode} onOpen={openProject} projects={groups.archived} quiet title="Archived" />
          <ProjectSection mode={mode} onOpen={openProject} projects={groups.other} quiet title="Other" />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#050505', flex: 1 },
  header: { alignItems: 'center', borderBottomColor: '#171719', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 54, paddingHorizontal: 10 },
  backButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 40 },
  backText: { color: '#E5E5E7', fontSize: 34, fontWeight: '200', lineHeight: 36 },
  title: { color: '#F7F7F8', flex: 1, fontSize: 22, fontWeight: '600', letterSpacing: -0.5 },
  newButton: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 4 },
  newButtonText: { color: '#8AB4F8', fontSize: 14, fontWeight: '600' },
  controls: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12 },
  toggle: { backgroundColor: '#121214', borderColor: '#27272A', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', padding: 2 },
  toggleButton: { alignItems: 'center', borderRadius: 7, height: 32, justifyContent: 'center', width: 38 },
  toggleButtonSelected: { backgroundColor: '#29292D' },
  toggleText: { color: '#6E6E73', fontSize: 18 },
  toggleTextSelected: { color: '#F2F2F4' },
  content: { paddingBottom: 36, paddingHorizontal: 16 },
  section: { marginTop: 20 },
  quietSection: { marginTop: 30, opacity: 0.78 },
  sectionTitle: { color: '#D7D7DA', fontSize: 13, fontWeight: '600', marginBottom: 9 },
  quietTitle: { color: '#85858B' },
  list: { gap: 0 },
  listRow: { alignItems: 'center', borderBottomColor: '#1E1E21', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 72, paddingVertical: 11 },
  listInitial: { alignItems: 'center', backgroundColor: '#171C24', borderColor: '#273348', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, height: 44, justifyContent: 'center', width: 44 },
  listInitialText: { color: '#9CB8E6', fontSize: 17, fontWeight: '600' },
  listCopy: { flex: 1, marginLeft: 12, minWidth: 0 },
  listName: { color: '#F2F2F4', fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  listDescription: { color: '#85858B', fontSize: 13, lineHeight: 18, marginTop: 3 },
  chevron: { color: '#515157', fontSize: 25, marginLeft: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  gridCard: { backgroundColor: '#101012', borderColor: '#242428', borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, minHeight: 190, overflow: 'hidden', paddingBottom: 14, width: '48%' },
  fallbackCover: { alignItems: 'center', backgroundColor: '#151A23', borderBottomColor: '#273040', borderBottomWidth: StyleSheet.hairlineWidth, height: 106, justifyContent: 'center' },
  fallbackInitial: { color: '#A9BFE4', fontSize: 38, fontWeight: '300' },
  gridName: { color: '#F2F2F4', fontSize: 15, fontWeight: '600', marginHorizontal: 13, marginTop: 12 },
  gridDescription: { color: '#7F7F85', fontSize: 12, lineHeight: 17, marginHorizontal: 13, marginTop: 4 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 32 },
  error: { color: '#E39A8E', fontSize: 14, textAlign: 'center' },
  emptyTitle: { color: '#F2F2F4', fontSize: 19, fontWeight: '600' },
  emptyBody: { color: '#85858B', fontSize: 14, lineHeight: 20, marginTop: 8, maxWidth: 300, textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
