import type { ProjectAssetSectionPlacement, ProjectResource } from '@/domain/projects';

import type { ProjectRepository } from './project-repository';

export type ProjectAssetPlacementMismatchKind =
  | 'missing_legacy_section'
  | 'missing_placement'
  | 'placement_without_resource'
  | 'wrong_resource_kind'
  | 'wrong_section';

export type ProjectAssetPlacementMismatch = {
  assetId: string;
  kind: ProjectAssetPlacementMismatchKind;
  legacySectionId?: string;
  placementSectionIds: string[];
};

export type ProjectAssetPlacementVerification = {
  assetsChecked: number;
  isValid: boolean;
  mismatches: ProjectAssetPlacementMismatch[];
  placementsChecked: number;
  projectId: string;
};

function placementKey(value: ProjectAssetSectionPlacement) {
  return `${value.assetId}\u0000${value.sectionId}\u0000${value.createdAt}`;
}

/**
 * Explicit Stage 2B diagnostic. It verifies that every uploaded asset has one
 * or more memberships including its designated compatibility section. It never
 * repairs data and is not called by normal Project reads or rendering.
 */
export async function verifyProjectAssetPlacementShadow(
  repository: ProjectRepository,
  projectId: string,
): Promise<ProjectAssetPlacementVerification> {
  const [resources, sections] = await Promise.all([
    repository.listResources(projectId),
    repository.listSections(projectId),
  ]);
  const placementsByResource = new Map<string, ProjectAssetSectionPlacement[]>();
  await Promise.all(resources.map(async (resource) => {
    placementsByResource.set(
      resource.id,
      await repository.listAssetPlacements(projectId, resource.id),
    );
  }));

  const allPlacements = new Map<string, ProjectAssetSectionPlacement>();
  for (const placements of placementsByResource.values()) {
    for (const placement of placements) allPlacements.set(placementKey(placement), placement);
  }
  await Promise.all(sections.map(async (section) => {
    const placements = await repository.listSectionAssetPlacements(projectId, section.id);
    for (const placement of placements) allPlacements.set(placementKey(placement), placement);
  }));

  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const mismatches: ProjectAssetPlacementMismatch[] = [];
  const uploadedResources = resources
    .filter((resource) => resource.resourceKind === 'uploaded_asset')
    .sort((left, right) => left.id.localeCompare(right.id));

  const report = (
    resource: Pick<ProjectResource, 'id' | 'sectionId'>,
    kind: ProjectAssetPlacementMismatchKind,
    placements: readonly ProjectAssetSectionPlacement[],
  ) => mismatches.push({
    assetId: resource.id,
    kind,
    ...(resource.sectionId ? { legacySectionId: resource.sectionId } : {}),
    placementSectionIds: placements.map(({ sectionId }) => sectionId).sort(),
  });

  for (const resource of resources.sort((left, right) => left.id.localeCompare(right.id))) {
    const placements = placementsByResource.get(resource.id) ?? [];
    if (resource.resourceKind !== 'uploaded_asset') {
      if (placements.length > 0) report(resource, 'wrong_resource_kind', placements);
      continue;
    }
    if (!resource.sectionId) report(resource, 'missing_legacy_section', placements);
    if (placements.length === 0) {
      report(resource, 'missing_placement', placements);
    } else if (!placements.some(({ sectionId }) => sectionId === resource.sectionId)) {
      report(resource, 'wrong_section', placements);
    }
  }

  for (const placement of allPlacements.values()) {
    if (!resourcesById.has(placement.assetId)) {
      report({ id: placement.assetId }, 'placement_without_resource', [placement]);
    }
  }

  mismatches.sort((left, right) =>
    left.assetId.localeCompare(right.assetId) || left.kind.localeCompare(right.kind));
  return {
    assetsChecked: uploadedResources.length,
    isValid: mismatches.length === 0,
    mismatches,
    placementsChecked: allPlacements.size,
    projectId,
  };
}
