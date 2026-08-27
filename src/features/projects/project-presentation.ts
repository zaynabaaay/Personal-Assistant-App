import type { Project } from '@/domain/projects';

export type ProjectCollection = 'active' | 'archived' | 'other' | 'paused';

export function projectCollection(project: Project): ProjectCollection {
  if (project.status === 'active') return 'active';
  if (project.status === 'paused') return 'paused';
  if (project.status === 'archived') return 'archived';
  return 'other';
}

export function groupProjects(projects: readonly Project[]) {
  const groups: Record<ProjectCollection, Project[]> = {
    active: [],
    archived: [],
    other: [],
    paused: [],
  };

  for (const project of projects) groups[projectCollection(project)].push(project);
  for (const values of Object.values(groups)) {
    values.sort((left, right) => left.name.localeCompare(right.name));
  }
  return groups;
}

export function projectDescription(project: Project) {
  return project.description?.trim() || 'No description yet.';
}

export function projectFallbackInitial(project: Pick<Project, 'name'>) {
  return project.name.trim().charAt(0).toLocaleUpperCase() || 'P';
}
