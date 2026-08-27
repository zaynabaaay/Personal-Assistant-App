import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import { ProjectService } from '../src/services/projects/project-service.ts';
import {
  PROJECT_ASSET_MAX_BYTES,
  PROJECT_IMAGE_MAX_DIMENSION,
  PROJECT_IMAGE_MAX_PIXELS,
  ProjectAssetService,
  isProjectAsset,
  isProjectAssetSignedUrlFresh,
  normalizeProjectAssetSelection,
  openProjectAssetOriginal,
} from '../src/services/projects/project-asset-service.ts';

const AT = '2026-08-26T17:00:00.000Z';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project = (id) => ({ createdAt: AT, id, name: id, priority: 'normal', status: 'active', timezone: 'America/Toronto', type: 'general', updatedAt: AT });
const section = (id, projectId, isDefault = false) => ({ createdAt: AT, id, isDefault, position: isDefault ? 0 : 1, projectId, status: 'active', title: isDefault ? 'Overview' : id, updatedAt: AT });
const selection = (overrides = {}) => ({ mimeType: 'image/png', name: 'linen-swatch.png', size: 4, source: 'photo-library', uri: 'memory://linen', width: 1200, height: 800, ...overrides });

function setup(overrides = {}) {
  const repository = new InMemoryProjectRepository({
    ownerId: OWNER,
    projects: [project('aqal'), project('other')],
    sections: [section('overview', 'aqal', true), section('materials', 'aqal'), section('other-section', 'other')],
  });
  const objects = new Map();
  let sequence = 0;
  const storage = {
    createSignedUrl: async (path) => ({ expiresAt: Date.now() + 600_000, url: `https://storage.test/${path}` }),
    remove: async (path) => { objects.delete(path); },
    upload: async (path, bytes, mimeType) => { objects.set(path, { bytes: bytes.slice(0), mimeType }); },
    ...overrides.storage,
  };
  const service = new ProjectAssetService(repository, {
    createId: () => `generated-${++sequence}`,
    loadBinary: overrides.loadBinary ?? (async () => new Uint8Array([1, 2, 3, 4]).buffer),
    now: () => new Date(AT), storage,
  });
  return { objects, repository, service };
}

test('owned Project and active section persist an authoritative original asset and preview path', async () => {
  const { objects, repository, service } = setup();
  const asset = await service.upload('aqal', 'materials', selection());
  assert.equal(asset.projectId, 'aqal');
  assert.equal(asset.sectionId, 'materials');
  assert.equal(asset.originalFilename, 'linen-swatch.png');
  assert.equal(asset.name, 'linen-swatch.png');
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.byteSize, 4);
  assert.deepEqual([asset.width, asset.height], [1200, 800]);
  assert.equal(asset.resourceKind, 'uploaded_asset');
  assert.match(asset.storagePath, new RegExp(`^${OWNER}/aqal/${asset.id}/generated-3$`));
  assert.deepEqual(new Uint8Array(objects.get(asset.storagePath).bytes), new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(await repository.getResource(asset.id), asset);
  assert.equal((await service.signedUrl(asset)).url, `https://storage.test/${asset.storagePath}`);
});

test('PDF and document metadata are stored without claiming content extraction', async () => {
  const pdf = setup();
  const pdfAsset = await pdf.service.upload('aqal', 'overview', selection({ mimeType: 'application/pdf', name: 'supplier.pdf', source: 'document-picker', width: undefined, height: undefined }));
  assert.equal(pdfAsset.type, 'pdf');
  assert.equal(pdfAsset.sourceMetadata.kind, 'original-upload');
  assert.equal(pdfAsset.sourceMetadata.picker, 'document-picker');
  assert.equal('content' in pdfAsset, false);

  const doc = setup();
  const docAsset = await doc.service.upload('aqal', 'materials', selection({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'brief.docx', source: 'document-picker', width: undefined, height: undefined }));
  assert.equal(docAsset.type, 'document');
  assert.equal(docAsset.originalFilename, 'brief.docx');
});

test('unsupported, mismatched, oversized, and malformed picker inputs fail deterministically', () => {
  assert.throws(() => normalizeProjectAssetSelection(selection({ mimeType: 'application/x-sh', name: 'run.sh' })), /not supported/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ mimeType: 'image/jpeg' })), /do not match/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ size: PROJECT_ASSET_MAX_BYTES + 1 })), /25 MB/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ size: undefined })), /invalid or missing size/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ name: undefined })), /missing required picker metadata/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ width: undefined })), /safe preview dimensions/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ width: PROJECT_IMAGE_MAX_DIMENSION + 1 })), /too large/);
  assert.throws(() => normalizeProjectAssetSelection(selection({ width: 8000, height: Math.ceil(PROJECT_IMAGE_MAX_PIXELS / 8000) + 1 })), /too large/);
});

test('one upload identity is single-flight and idempotent across rapid duplicate submission', async () => {
  let uploads = 0;
  const value = setup({ storage: { upload: async (path, bytes, mimeType) => {
    uploads += 1;
    value.objects.set(path, { bytes, mimeType });
  } } });
  const identity = value.service.createUploadIdentity();
  const [first, second] = await Promise.all([
    value.service.uploadWithIdentity('aqal', 'materials', selection(), identity),
    value.service.uploadWithIdentity('aqal', 'materials', selection(), identity),
  ]);
  assert.equal(first.id, identity.assetId);
  assert.equal(second.id, first.id);
  assert.equal(uploads, 1);
  assert.equal((await value.repository.listResources('aqal')).length, 1);
  const retry = await value.service.uploadWithIdentity('aqal', 'materials', selection(), identity);
  assert.equal(retry.id, first.id);
  assert.equal(uploads, 1);
});

test('failed finalization cleans only its pending object and retry reuses the same identities', async () => {
  const value = setup();
  const identity = value.service.createUploadIdentity();
  const finalize = value.repository.finalizeAssetUpload.bind(value.repository);
  let failures = 2;
  value.repository.finalizeAssetUpload = async (attemptId) => {
    if (failures-- > 0) throw new Error('metadata unavailable');
    return finalize(attemptId);
  };
  await assert.rejects(value.service.uploadWithIdentity('aqal', 'materials', selection(), identity), /metadata unavailable/);
  assert.equal(value.objects.size, 0);
  assert.equal((await value.repository.listResources('aqal')).length, 0);
  const retry = await value.service.uploadWithIdentity('aqal', 'materials', selection(), identity);
  assert.equal(retry.id, identity.assetId);
  assert.match(retry.storagePath, new RegExp(`/${identity.assetId}/${identity.objectId}$`));
  assert.equal(value.objects.size, 1);
});

test('explicit subtype does not reinterpret a legacy resource as a binary', () => {
  const legacy = { byteSize: 4, createdAt: AT, id: 'legacy', mimeType: 'image/png',
    name: 'Legacy', originalFilename: 'legacy.png', projectId: 'aqal', role: 'reference',
    sectionId: 'materials', status: 'current', storagePath: 'owner/project/asset/object',
    type: 'image', updatedAt: AT };
  assert.equal(isProjectAsset(legacy), false);
  assert.equal(isProjectAsset({ ...legacy, resourceKind: 'uploaded_asset' }), true);
});

test('signed URL freshness refreshes near expiry without persisting URLs as metadata', () => {
  const now = 1_000_000;
  assert.equal(isProjectAssetSignedUrlFresh({ expiresAt: now + 60_000, url: 'signed' }, now), true);
  assert.equal(isProjectAssetSignedUrlFresh({ expiresAt: now + 29_999, url: 'stale' }, now), false);
});

function openAssetHarness(overrides = {}) {
  const asset = { byteSize: 4, createdAt: AT, id: 'asset-open', mimeType: 'application/pdf',
    name: 'Supplier quote', originalFilename: 'supplier.pdf', projectId: 'aqal',
    resourceKind: 'uploaded_asset', role: 'reference', sectionId: 'materials', status: 'current',
    storagePath: `${OWNER}/aqal/asset-open/object-open`, type: 'pdf', updatedAt: AT };
  const busy = [];
  const errors = [];
  const forced = [];
  const invalidated = [];
  const opened = [];
  const signed = [
    { expiresAt: Date.now() + 600_000, url: 'https://storage.test/cached' },
    { expiresAt: Date.now() + 600_000, url: 'https://storage.test/fresh' },
  ];
  let signIndex = 0;
  const run = () => openProjectAssetOriginal({
    asset,
    canOpenUrl: overrides.canOpenUrl ?? (async () => true),
    getSignedUrl: async (_asset, force = false) => {
      forced.push(force);
      return signed[Math.min(signIndex++, signed.length - 1)];
    },
    invalidateSignedUrl: (assetId) => invalidated.push(assetId),
    onBusyChange: (value) => busy.push(value),
    onError: (value) => errors.push(value),
    openUrl: async (url) => {
      opened.push(url);
      await overrides.openUrl?.(url, opened.length);
    },
  });
  return { asset, busy, errors, forced, invalidated, opened, run };
}

test('Open original uses a valid cached URL without refreshing and clears busy state', async () => {
  const value = openAssetHarness();
  await value.run();
  assert.deepEqual(value.forced, [false]);
  assert.deepEqual(value.opened, ['https://storage.test/cached']);
  assert.deepEqual(value.invalidated, []);
  assert.deepEqual(value.errors, [null]);
  assert.deepEqual(value.busy, [true, false]);
  assert.equal('signedUrl' in value.asset || 'url' in value.asset || 'expiresAt' in value.asset, false);
});

test('Open original invalidates a failed URL, force-refreshes, and retries exactly once', async () => {
  const value = openAssetHarness({ openUrl: async (_url, attempt) => {
    if (attempt === 1) throw new Error('expired URL');
  } });
  await value.run();
  assert.deepEqual(value.forced, [false, true]);
  assert.deepEqual(value.invalidated, ['asset-open']);
  assert.deepEqual(value.opened, [
    'https://storage.test/cached',
    'https://storage.test/fresh',
  ]);
  assert.deepEqual(value.errors, [null]);
  assert.deepEqual(value.busy, [true, false]);
});

test('Open original stops after one retry, surfaces the second failure, and clears busy state', async () => {
  const value = openAssetHarness({ openUrl: async () => { throw new Error('open failed'); } });
  await value.run();
  assert.deepEqual(value.forced, [false, true]);
  assert.deepEqual(value.invalidated, ['asset-open']);
  assert.equal(value.opened.length, 2);
  assert.deepEqual(value.errors, [null, 'open failed']);
  assert.deepEqual(value.busy, [true, false]);
});

test('signing rechecks the authoritative subtype and exact stored path', async () => {
  let signs = 0;
  const value = setup({ storage: { createSignedUrl: async (path) => {
    signs += 1;
    return { expiresAt: Date.now() + 600_000, url: `signed://${path}` };
  } } });
  const asset = await value.service.upload('aqal', 'materials', selection());
  await assert.rejects(value.service.signedUrl({ ...asset, storagePath: `${asset.storagePath}-forged` }), /no longer matches/);
  assert.equal(signs, 0);
  assert.match((await value.service.signedUrl(asset)).url, /^signed:\/\//);
  assert.equal(signs, 1);
  await value.repository.saveResource({ createdAt: AT, externalUrl: 'https://example.com',
    id: 'legacy', name: 'Legacy', projectId: 'aqal', role: 'reference', type: 'link', updatedAt: AT });
  await assert.rejects(value.service.signedUrl({ id: 'legacy', projectId: 'aqal', storagePath: 'fake' }), /not found/);
  assert.equal(signs, 1);
});

test('invalid section pairing and cross-Project mutation are rejected', async () => {
  const { service } = setup();
  await assert.rejects(service.upload('aqal', 'other-section', selection()), /does not belong/);
  const asset = await service.upload('aqal', 'materials', selection());
  await assert.rejects(service.reassign('other', asset.id, 'other-section'), /does not belong to that Project/);
  await assert.rejects(service.reassign('aqal', asset.id, 'other-section'), /does not belong/);
  assert.equal((await service.list('aqal', 'materials'))[0].id, asset.id);
});

test('same-Project reassignment, rename, archive, and restore only update metadata', async () => {
  const { objects, service } = setup();
  const asset = await service.upload('aqal', 'materials', selection());
  const originalObject = objects.get(asset.storagePath);
  const renamed = await service.rename('aqal', asset.id, 'Natural linen');
  assert.equal(renamed.originalFilename, 'linen-swatch.png');
  const moved = await service.reassign('aqal', asset.id, 'overview');
  assert.equal(moved.sectionId, 'overview');
  assert.equal(moved.storagePath, asset.storagePath);
  const archived = await service.archive('aqal', asset.id);
  assert.equal(archived.status, 'archived');
  assert.equal((await service.list('aqal', 'overview')).length, 0);
  assert.equal((await service.list('aqal', 'overview', true)).length, 1);
  assert.equal(objects.get(asset.storagePath), originalObject);
  const restored = await service.restore('aqal', asset.id);
  assert.equal(restored.status, 'current');
  assert.equal((await service.list('aqal', 'overview')).length, 1);
  assert.equal(objects.get(asset.storagePath), originalObject);
});

test('section archive and restore preserve multiple attached asset identities', async () => {
  const { repository, service } = setup();
  const first = await service.upload('aqal', 'materials', selection({ name: 'first.png' }));
  const second = await service.upload('aqal', 'materials', selection({ name: 'second.png' }));
  const projects = new ProjectService(repository, { now: () => new Date(AT) });
  await projects.archiveSection('aqal', 'materials');
  const archived = await repository.getSection('materials');
  assert.equal(archived.status, 'archived');
  assert.deepEqual((await repository.listResources('aqal')).map((item) => [item.id, item.sectionId]),
    [[first.id, 'materials'], [second.id, 'materials']]);
  await projects.restoreSection('aqal', 'materials');
  assert.equal((await repository.getSection('materials')).status, 'active');
  assert.deepEqual((await service.list('aqal', 'materials')).map((item) => item.id), [first.id, second.id]);
});

test('failed binary upload never creates a false persisted asset row', async () => {
  const { repository, service } = setup({ storage: { upload: async () => { throw new Error('interrupted'); } } });
  await assert.rejects(service.upload('aqal', 'materials', selection()), /interrupted/);
  assert.deepEqual(await repository.listResources('aqal'), []);
});

test('asset UI stays section-scoped and preserves Project Tina and New Chat behavior', async () => {
  const [screen, surface, routing, chat] = await Promise.all([
    readFile(new URL('../src/features/projects/project-screen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/projects/project-section-assets.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/server/assistant/project-scope-routing.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/projects/project-chat-service.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(screen, /<ProjectSectionAssets/);
  assert.match(surface, /projectAssetService\.uploadWithIdentity/);
  assert.match(surface, /project-image-asset/);
  assert.match(surface, /project-document-asset/);
  assert.match(surface, /projectAssetService\.reassign/);
  assert.match(surface, /projectAssetService\.archive/);
  assert.match(surface, /projectAssetService\.restore/);
  assert.match(surface, /actionInFlight\.current/);
  assert.match(surface, /onError\(cause instanceof Error/);
  assert.match(surface, /setActionError\(message\)/);
  assert.match(surface, /finally \{ actionInFlight\.current = false; setBusy\(false\); \}/);
  assert.match(surface, /isProjectAssetSignedUrlFresh/);
  assert.doesNotMatch(routing, /section/i);
  assert.doesNotMatch(chat, /section/i);
  assert.match(screen, /projectChatService\.startNewSession\(session\)/);
});

test('asset migration is non-destructive, private, exact-bound, and narrowly cleans pending objects', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260826170000_add_project_assets.sql', import.meta.url), 'utf8');
  assert.match(migration, /alter table public\.project_resources/);
  assert.match(migration, /foreign key \(owner_id, project_id, section_id\)/);
  assert.match(migration, /resource_kind = 'uploaded_asset'/);
  assert.match(migration, /begin_project_asset_upload/);
  assert.match(migration, /finalize_project_asset_upload/);
  assert.match(migration, /'project-assets', 'project-assets', false, 26214400/);
  assert.match(migration, /project_assets_exact_select/);
  assert.match(migration, /project_assets_pending_insert/);
  assert.match(migration, /project_assets_pending_delete/);
  assert.match(migration, /can_delete_pending_project_asset_object/);
  assert.doesNotMatch(migration, /for delete[\s\S]+owner_id.*project_id.*prefix/i);
});
