import { ProjectAssetService, createSupabaseProjectAssetStorage } from './project-asset-service';
import { ProjectService } from './project-service';
import { ProjectChatService } from './project-chat-service';
import { SupabaseProjectRepository } from './supabase-project-repository';

export const projectRepository = new SupabaseProjectRepository();
export const projectService = new ProjectService(projectRepository);
export const projectAssetService = new ProjectAssetService(projectRepository, {
  storage: createSupabaseProjectAssetStorage(),
});
export const projectChatService = new ProjectChatService(projectRepository);
