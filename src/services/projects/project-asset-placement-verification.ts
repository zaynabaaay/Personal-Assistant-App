import type { ProjectAssetSectionPlacement, ProjectResource } from '@/domain/projects';

import type { ProjectRepository } from './project-repository';

export type ProjectAssetPlacementMismatchKind =
  | 'missing_legacy_section'
  | 'cleaned_attempt_with_placement'
  | 'cleaned_attempt_with_resource'
  | 'finalized_attempt_without_resource'
  | 'pending_attempt_with_placement'
  | 'pending_attempt_with_resource'
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
  attemptsChecked: number;
  isValid: boolean;
  mismatches: ProjectAssetPlacementMismatch[];
  placementsChecked: number;
  projectId: string;
};

function placementKey(value: ProjectAssetSectionPlacement) {
  return `${value.assetId}\u0000${value.sectionId}\u0000${value.createdAt}`;
}

/**
 * Explicit Stage 2C diagnostic. It verifies the temporary compatibility
 * designation and upload-attempt lifecycle without requiring any placement. It never
 * repairs data and is not called by normal Project reads or rendering.
 */
export async function verifyProjectAssetPlacementShadow(
  repository: ProjectRepository,
  projectId: string,
): Promise<ProjectAssetPlacementVerification> {
  const [resources, sections, attempts] = await Promise.all([
    repository.listResources(projectId),
    repository.listSections(projectId),
    repository.listAssetUploadAttempts(projectId),
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
    if (placements.length === 0) {
      if (resource.sectionId) report(resource, 'wrong_section', placements);
    } else if (!resource.sectionId) {
      report(resource, 'missing_legacy_section', placements);
    } else if (!placements.some(({ sectionId }) => sectionId === resource.sectionId)) {
      report(resource, 'wrong_section', placements);
    }
  }

  for (const attempt of attempts) {
    const resource = resourcesById.get(attempt.assetId);
    const placements = placementsByResource.get(attempt.assetId) ?? [];
    if (attempt.status === 'pending') {
      if (resource) report(resource, 'pending_attempt_with_resource', placements);
      if (placements.length > 0) {
        report(resource ?? { id: attempt.assetId }, 'pending_attempt_with_placement', placements);
      }
    } else if (attempt.status === 'finalized' &&
      (!resource || resource.resourceKind !== 'uploaded_asset')) {
      report(resource ?? { id: attempt.assetId }, 'finalized_attempt_without_resource', placements);
    } else if (attempt.status === 'cleaned') {
      if (resource) report(resource, 'cleaned_attempt_with_resource', placements);
      if (placements.length > 0) {
        report(resource ?? { id: attempt.assetId }, 'cleaned_attempt_with_placement', placements);
      }
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
    attemptsChecked: attempts.length,
    isValid: mismatches.length === 0,
    mismatches,
    placementsChecked: allPlacements.size,
    projectId,
  };
}
