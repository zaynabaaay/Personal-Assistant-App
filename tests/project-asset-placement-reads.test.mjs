import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import { verifyProjectAssetPlacementShadow } from '../src/services/projects/project-asset-placement-verification.ts';

const EARLY = '2026-09-03T10:00:00.000Z';
const LATE = '2026-09-03T11:00:00.000Z';

const project = (id) => ({
  createdAt: EARLY, id, name: id, priority: 'normal', status: 'active',
  timezone: 'America/Toronto', type: 'general', updatedAt: EARLY,
});

const section = (id, projectId, position) => ({
  createdAt: EARLY, id, isDefault: position === 0, position, projectId,
  status: 'active', title: id, updatedAt: EARLY,
});

const asset = (id, sectionId, overrides = {}) => ({
  byteSize: 4,
  createdAt: EARLY,
  id,
  mimeType: 'image/png',
  name: `${id}.png`,
  originalFilename: `${id}.png`,
  projectId: 'project-a',
  resourceKind: 'uploaded_asset',
  role: 'reference',
  sectionId,
  sourceMetadata: { kind: 'original-upload', picker: 'photo-library' },
  status: 'current',
  storagePath: `owner/project-a/${id}/object`,
  type: 'image',
  updatedAt: EARLY,
  ...overrides,
});

const legacy = (id, overrides = {}) => ({
  createdAt: EARLY, externalUrl: 'https://example.com', id, name: id,
  projectId: 'project-a', resourceKind: 'legacy', role: 'reference', type: 'link',
  updatedAt: EARLY, ...overrides,
});

function repository(overrides = {}) {
  return new InMemoryProjectRepository({
    projects: [project('project-a'), project('project-b')],
    resources: [
      asset('asset-b', 'section-a', { createdAt: LATE, status: 'archived', updatedAt: LATE }),
      asset('asset-a', 'section-a'),
      legacy('legacy-a'),
    ],
    sections: [
      section('section-a', 'project-a', 0),
      section('section-b', 'project-a', 1),
      section('other-section', 'project-b', 0),
    ],
    ...overrides,
  });
}

test('placement reads by asset and section are scoped and deterministically ordered', async () => {
  const value = repository({
    assetPlacements: [
      { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
      { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
      { assetId: 'other-asset', createdAt: EARLY, projectId: 'project-b', sectionId: 'other-section' },
    ],
  });

  assert.deepEqual(await value.listAssetPlacements('project-a', 'asset-a'), [{
    assetId: 'asset-a', createdAt: EARLY, sectionId: 'section-a',
  }]);
  assert.deepEqual(
    (await value.listSectionAssetPlacements('project-a', 'section-a')).map(({ assetId }) => assetId),
    ['asset-a', 'asset-b'],
  );
  assert.deepEqual(await value.listSectionAssetPlacements('project-a', 'other-section'), []);
  assert.equal('projectId' in (await value.listAssetPlacements('project-a', 'asset-a'))[0], false);
});

test('Project-global asset read is resource-driven, unique, archived-aware, and storage-free', async () => {
  const value = repository({
    assetPlacements: [
      { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
      { assetId: 'asset-a', createdAt: LATE, projectId: 'project-a', sectionId: 'section-b' },
      { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
    ],
  });
  const assets = await value.listProjectAssets('project-a');

  assert.deepEqual(assets.map(({ id, status }) => [id, status]), [
    ['asset-a', 'current'],
    ['asset-b', 'archived'],
  ]);
  assert.equal(new Set(assets.map(({ id }) => id)).size, assets.length);
  assert.equal(assets.some((item) => 'storagePath' in item || 'sectionId' in item || 'externalUrl' in item), false);
  assert.deepEqual(await value.listProjectAssets('project-b'), []);
});

test('placement section read is equivalent to the authoritative direct section list', async () => {
  const value = repository();
  const direct = (await value.listResources('project-a'))
    .filter((resource) => resource.resourceKind === 'uploaded_asset' && resource.sectionId === 'section-a')
    .map(({ id }) => id)
    .sort();
  const shadow = (await value.listSectionAssetPlacements('project-a', 'section-a'))
    .map(({ assetId }) => assetId)
    .sort();
  assert.deepEqual(shadow, direct);
  assert.equal((await verifyProjectAssetPlacementShadow(value, 'project-a')).isValid, true);
});

test('metadata-only writes preserve authoritative placements and ignore stale compatibility input', async () => {
  const value = repository();
  const original = await value.getResource('asset-a');
  const before = await value.listAssetPlacements('project-a', 'asset-a');
  await value.saveResource({ ...original, status: 'archived', updatedAt: LATE });
  assert.deepEqual(await value.listAssetPlacements('project-a', 'asset-a'), before);

  await value.saveResource({ ...original, sectionId: 'section-b', updatedAt: LATE });
  assert.deepEqual(await value.listAssetPlacements('project-a', 'asset-a'), [{
    assetId: 'asset-a', createdAt: EARLY, sectionId: 'section-a',
  }]);
  assert.deepEqual(await value.listSectionAssetPlacements('project-a', 'section-a'), [
    { assetId: 'asset-a', createdAt: EARLY, sectionId: 'section-a' },
    { assetId: 'asset-b', createdAt: LATE, sectionId: 'section-a' },
  ]);
});

test('explicit verification detects missing and missing-designation drift while accepting multiple placements', async () => {
  const missing = repository({ assetPlacements: [
    { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
  ] });
  assert.deepEqual((await verifyProjectAssetPlacementShadow(missing, 'project-a')).mismatches
    .map(({ assetId, kind }) => [assetId, kind]), [['asset-a', 'wrong_section']]);

  const wrong = repository({ assetPlacements: [
    { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-b' },
    { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
  ] });
  assert.deepEqual((await verifyProjectAssetPlacementShadow(wrong, 'project-a')).mismatches
    .map(({ assetId, kind }) => [assetId, kind]), [['asset-a', 'wrong_section']]);

  const multiple = repository({ assetPlacements: [
    { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
    { assetId: 'asset-a', createdAt: LATE, projectId: 'project-a', sectionId: 'section-b' },
    { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
  ] });
  assert.equal((await verifyProjectAssetPlacementShadow(multiple, 'project-a')).isValid, true);
});

test('Stage 2C verification accepts a current asset with zero placements and null compatibility', async () => {
  const unplaced = asset('asset-unplaced', undefined);
  const value = repository({
    assetPlacements: [
      { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
      { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
    ],
    resources: [
      asset('asset-a', 'section-a'), asset('asset-b', 'section-a', { status: 'archived' }),
      legacy('legacy-a'), unplaced,
    ],
  });
  const verification = await verifyProjectAssetPlacementShadow(value, 'project-a');
  assert.equal(verification.isValid, true);
  assert.equal(verification.assetsChecked, 3);
});

test('explicit verification detects placements on the wrong resource kind and orphan rows', async () => {
  const value = repository({ assetPlacements: [
    { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
    { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
    { assetId: 'legacy-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
    { assetId: 'missing-resource', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
  ] });
  assert.deepEqual((await verifyProjectAssetPlacementShadow(value, 'project-a')).mismatches
    .map(({ assetId, kind }) => [assetId, kind]), [
    ['legacy-a', 'wrong_resource_kind'],
    ['missing-resource', 'placement_without_resource'],
  ]);
});

test('explicit verification detects invalid pending, finalized, and cleaned upload-attempt states', async () => {
  const value = repository({ assetPlacements: [
    { assetId: 'asset-a', createdAt: EARLY, projectId: 'project-a', sectionId: 'section-a' },
    { assetId: 'asset-b', createdAt: LATE, projectId: 'project-a', sectionId: 'section-a' },
  ] });
  value.listAssetUploadAttempts = async () => [
    { assetId: 'asset-a', projectId: 'project-a', sectionId: 'section-a', status: 'pending' },
    { assetId: 'missing-finalized', projectId: 'project-a', status: 'finalized' },
    { assetId: 'asset-b', projectId: 'project-a', sectionId: 'section-a', status: 'cleaned' },
  ];

  const verification = await verifyProjectAssetPlacementShadow(value, 'project-a');
  assert.equal(verification.attemptsChecked, 3);
  assert.deepEqual(verification.mismatches.map(({ assetId, kind }) => [assetId, kind]), [
    ['asset-a', 'pending_attempt_with_placement'],
    ['asset-a', 'pending_attempt_with_resource'],
    ['asset-b', 'cleaned_attempt_with_placement'],
    ['asset-b', 'cleaned_attempt_with_resource'],
    ['missing-finalized', 'finalized_attempt_without_resource'],
  ]);
});
