import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ProjectSort } from './project-presentation';

export type ProjectViewMode = 'grid' | 'list';

type PreferenceStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;

export const PROJECT_VIEW_PREFERENCE_KEY = 'tina.projects.view-mode';
export const PROJECT_SORT_PREFERENCE_KEY = 'tina.projects.sort';

export function createProjectViewPreference(storage: PreferenceStorage = AsyncStorage) {
  return {
    async load(): Promise<ProjectViewMode> {
      const value = await storage.getItem(PROJECT_VIEW_PREFERENCE_KEY);
      return value === 'grid' ? 'grid' : 'list';
    },
    async save(value: ProjectViewMode) {
      await storage.setItem(PROJECT_VIEW_PREFERENCE_KEY, value);
    },
  };
}

export const projectViewPreference = createProjectViewPreference();

export function createProjectSortPreference(storage: PreferenceStorage = AsyncStorage) {
  return {
    async load(): Promise<ProjectSort> {
      const value = await storage.getItem(PROJECT_SORT_PREFERENCE_KEY);
      return value === 'created' || value === 'name' ? value : 'recent';
    },
    async save(value: ProjectSort) {
      await storage.setItem(PROJECT_SORT_PREFERENCE_KEY, value);
    },
  };
}

export const projectSortPreference = createProjectSortPreference();
