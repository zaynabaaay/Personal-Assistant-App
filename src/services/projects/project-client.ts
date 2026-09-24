import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  ProjectAssetService,
  createSupabaseProjectAssetStorage,
  loadProjectAssetSelectionBinary,
} from './project-asset-service';
import { ProjectService } from './project-service';
import { ProjectChatService } from './project-chat-service';
import { SupabaseProjectRepository } from './supabase-project-repository';

export const projectRepository = new SupabaseProjectRepository();
export const projectService = new ProjectService(projectRepository);
export const projectAssetService = new ProjectAssetService(projectRepository, {
  loadBinary: async (selection) => {
    return loadProjectAssetSelectionBinary(selection, {
      fetchBinary: async (uri) => {
        const response = await fetch(uri);
        if (!response.ok) throw new Error('The selected file could not be read.');
        return response.arrayBuffer();
      },
      platform: Platform.OS,
      readNativeFile: (uri) => new File(uri).arrayBuffer(),
    });
  },
  storage: createSupabaseProjectAssetStorage(),
});
export const projectChatService = new ProjectChatService(projectRepository);
