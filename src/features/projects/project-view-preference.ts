import AsyncStorage from '@react-native-async-storage/async-storage';

export type ProjectViewMode = 'grid' | 'list';

type PreferenceStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;

export const PROJECT_VIEW_PREFERENCE_KEY = 'tina.projects.view-mode';

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
