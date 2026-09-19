import { useCallback, useMemo, useState } from 'react';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Project } from '@/domain/projects';
import { projectRepository } from '@/services/projects/project-client';

import {
  projectDescription,
  projectFallbackInitial,
  projectLibraryCollections,
  projectRecencyLabel,
  type ProjectSort,
} from './project-presentation';
import { projectSortPreference } from './project-view-preference';

const SORT_OPTIONS: readonly { label: string; value: ProjectSort }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Created', value: 'created' },
  { label: 'Name', value: 'name' },
];

function SortControl({ onChange, value }: { onChange: (value: ProjectSort) => void; value: ProjectSort }) {
  return (
    <View accessibilityLabel="Sort Projects" style={styles.sortControl} testID="projects-sort-control">
      {SORT_OPTIONS.map((option) => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: value === option.value }}
          key={option.value}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => [styles.sortButton, value === option.value && styles.sortButtonSelected, pressed && styles.pressed]}
          testID={`projects-sort-${option.value}`}
        >
          <Text style={[styles.sortText, value === option.value && styles.sortTextSelected]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ProjectRow({ archived = false, onPress, project }: { archived?: boolean; onPress: () => void; project: Project }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.projectRow, pressed && styles.pressed]}
      testID={`project-row-${project.id}`}
    >
      <View style={styles.fallbackCover} testID="project-cover-fallback">
        <Text style={styles.fallbackInitial}>{projectFallbackInitial(project)}</Text>
      </View>
      <View style={styles.projectCopy}>
        <View style={styles.projectHeading}>
          <Text numberOfLines={1} style={styles.projectName}>{project.name}</Text>
          {archived ? <Text style={styles.archiveMarker}>Archived</Text> : null}
        </View>
        <Text numberOfLines={2} style={styles.projectDescription}>{projectDescription(project)}</Text>
        <Text style={styles.recency}>{projectRecencyLabel(project.updatedAt)}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

export default function ProjectsScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([projectRepository.listProjects(), projectSortPreference.load()]).then(
      ([values, savedSort]) => {
        if (!active) return;
        setProjects(values);
        setSort(savedSort);
      },
      () => active && setError('Projects could not be loaded.'),
    ).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []));

  const collections = useMemo(() => projectLibraryCollections(projects, sort), [projects, sort]);
  const changeSort = (value: ProjectSort) => {
    setSort(value);
    void projectSortPreference.save(value).catch(() => undefined);
  };
  const openProject = (project: Project) => router.push({
    pathname: '/projects/[id]', params: { id: project.id },
  } as unknown as Href);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea} testID="projects-screen">
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Projects</Text>
          <Text style={styles.subtitle}>Your ongoing spaces</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => router.push('/projects/new' as Href)} style={({ pressed }) => [styles.newButton, pressed && styles.pressed]} testID="new-project-button">
          <Text style={styles.newButtonText}>+ New</Text>
        </Pressable>
      </View>
      <View style={styles.controls}>
        <Text style={styles.sortLabel}>Sort by</Text>
        <SortControl onChange={changeSort} value={sort} />
      </View>

      {loading ? <View style={styles.center}><ActivityIndicator color="#8F8F95" /></View> : error ? (
        <View style={styles.center}><Text style={styles.error}>{error}</Text></View>
      ) : projects.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No Projects yet</Text>
          <Text style={styles.emptyBody}>Create a space when something deserves ongoing attention.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View testID="projects-library">
            {collections.projects.map((project) => <ProjectRow key={project.id} onPress={() => openProject(project)} project={project} />)}
          </View>
          {collections.archived.length > 0 ? (
            <View style={styles.archiveSection} testID="projects-archive-section">
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showArchived }} onPress={() => setShowArchived((value) => !value)} style={({ pressed }) => [styles.archiveButton, pressed && styles.pressed]} testID="toggle-archived-projects">
                <Text style={styles.archiveButtonText}>Archived ({collections.archived.length})</Text>
                <Text style={styles.archiveChevron}>{showArchived ? '⌃' : '⌄'}</Text>
              </Pressable>
              {showArchived ? collections.archived.map((project) => <ProjectRow archived key={project.id} onPress={() => openProject(project)} project={project} />) : null}
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#050505', flex: 1 },
  header: { alignItems: 'center', borderBottomColor: '#171719', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 64, paddingHorizontal: 18 },
  titleBlock: { flex: 1, minWidth: 0 },
  title: { color: '#F7F7F8', fontSize: 24, fontWeight: '600', letterSpacing: -0.6 },
  subtitle: { color: '#6F6F75', fontSize: 12, marginTop: 2 },
  newButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 64 },
  newButtonText: { color: '#8AB4F8', fontSize: 14, fontWeight: '600' },
  controls: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 13 },
  sortLabel: { color: '#77777D', fontSize: 12 },
  sortControl: { backgroundColor: '#101012', borderColor: '#242427', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', padding: 2 },
  sortButton: { alignItems: 'center', borderRadius: 7, justifyContent: 'center', minHeight: 34, paddingHorizontal: 11 },
  sortButtonSelected: { backgroundColor: '#28282C' },
  sortText: { color: '#77777D', fontSize: 12, fontWeight: '500' },
  sortTextSelected: { color: '#F1F1F3' },
  content: { paddingBottom: 30, paddingHorizontal: 18 },
  projectRow: { alignItems: 'center', borderBottomColor: '#1E1E21', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 94, paddingVertical: 13 },
  fallbackCover: { alignItems: 'center', backgroundColor: '#161B23', borderColor: '#263142', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, height: 54, justifyContent: 'center', overflow: 'hidden', width: 54 },
  fallbackInitial: { color: '#A3B9DC', fontSize: 20, fontWeight: '500' },
  projectCopy: { flex: 1, marginLeft: 13, minWidth: 0 },
  projectHeading: { alignItems: 'center', flexDirection: 'row', minWidth: 0 },
  projectName: { color: '#F2F2F4', flexShrink: 1, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  projectDescription: { color: '#89898F', fontSize: 13, lineHeight: 18, marginTop: 3 },
  recency: { color: '#5F6268', fontSize: 11, marginTop: 6 },
  chevron: { color: '#4E4E54', fontSize: 24, marginLeft: 9 },
  archiveMarker: { color: '#73737A', fontSize: 10, marginLeft: 8 },
  archiveSection: { marginTop: 20 },
  archiveButton: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 44 },
  archiveButtonText: { color: '#85858B', fontSize: 12, fontWeight: '600' },
  archiveChevron: { color: '#66666C', fontSize: 17 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 32 },
  error: { color: '#E39A8E', fontSize: 14, textAlign: 'center' },
  emptyTitle: { color: '#F2F2F4', fontSize: 19, fontWeight: '600' },
  emptyBody: { color: '#85858B', fontSize: 14, lineHeight: 20, marginTop: 8, maxWidth: 300, textAlign: 'center' },
  pressed: { opacity: 0.58 },
});
