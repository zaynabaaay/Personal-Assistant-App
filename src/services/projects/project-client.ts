import { ProjectService } from './project-service';
import { SupabaseProjectRepository } from './supabase-project-repository';

export const projectRepository = new SupabaseProjectRepository();
export const projectService = new ProjectService(projectRepository);
