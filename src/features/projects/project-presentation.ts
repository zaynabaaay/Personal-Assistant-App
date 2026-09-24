import type { Project } from '@/domain/projects';

export type ProjectSort = 'created' | 'name' | 'recent';

function compareText(left: string, right: string) {
  const normalizedLeft = left.trim().toLocaleLowerCase();
  const normalizedRight = right.trim().toLocaleLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function descendingDate(left: string, right: string) {
  return right.localeCompare(left);
}

export function sortProjects(projects: readonly Project[], sort: ProjectSort) {
  return [...projects].sort((left, right) => {
    if (sort === 'recent') {
      return descendingDate(left.updatedAt, right.updatedAt) ||
        descendingDate(left.createdAt, right.createdAt) ||
        compareText(left.name, right.name) || compareText(left.id, right.id);
    }
    if (sort === 'created') {
      return descendingDate(left.createdAt, right.createdAt) ||
        descendingDate(left.updatedAt, right.updatedAt) ||
        compareText(left.name, right.name) || compareText(left.id, right.id);
    }
    return compareText(left.name, right.name) ||
      descendingDate(left.createdAt, right.createdAt) || compareText(left.id, right.id);
  });
}

export function projectLibraryCollections(projects: readonly Project[], sort: ProjectSort) {
  return {
    archived: sortProjects(projects.filter((project) => project.status === 'archived'), sort),
    projects: sortProjects(projects.filter((project) => project.status !== 'archived'), sort),
  };
}

export function projectDescription(project: Project) {
  return project.description?.trim() || 'No description yet.';
}

export function projectFallbackInitial(project: Pick<Project, 'name'>) {
  return project.name.trim().charAt(0).toLocaleUpperCase() || 'P';
}

export function projectRecencyLabel(updatedAt: string, now = new Date()) {
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return 'Recently updated';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const updatedDay = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.floor((today.getTime() - updatedDay.getTime()) / 86_400_000);
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 7) return `Updated ${days} days ago`;
  return `Updated ${value.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}
