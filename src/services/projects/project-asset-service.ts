import type { ProjectAsset, ProjectResource } from '@/domain/projects';

import { getSupabaseClient } from '../auth/supabase-client';
import type {
  ProjectAssetUploadIdentity,
  ProjectAssetUploadReservation,
  ProjectRepository,
} from './project-repository';

export const PROJECT_ASSET_BUCKET = 'project-assets';
export const PROJECT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const PROJECT_IMAGE_MAX_DIMENSION = 8192;
export const PROJECT_IMAGE_MAX_PIXELS = 32_000_000;
export const PROJECT_ASSET_SIGNED_URL_SECONDS = 10 * 60;

export const SUPPORTED_PROJECT_ASSET_MIME_TYPES = new Set([
  'application/msword', 'application/pdf', 'application/rtf', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/gif', 'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
]);

// This allowlist validates declared storage metadata only. It is not content
// identification. Server-side identification and parser hardening are mandatory
// before any future document-content ingestion.

const MIME_BY_EXTENSION: Record<string, string> = {
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  pdf: 'application/pdf', png: 'image/png', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf', txt: 'text/plain', webp: 'image/webp', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export type PickedProjectAsset = {
  height?: number;
  mimeType?: string | null;
  name?: string | null;
  size?: number | null;
  source: 'document-picker' | 'photo-library' | 'web-file-picker';
  uri: string;
  width?: number;
};

export type ProjectDocumentPickerResult = {
  assets: null | { mimeType?: string; name: string; size?: number; uri: string }[];
  canceled: boolean;
};

export type ProjectDocumentPickerOutcome =
  | { status: 'cancelled' }
  | { status: 'selected'; selection: PickedProjectAsset }
  | { status: 'suppressed' };

export type ProjectDocumentPickerState = { nativePickerActive: boolean };

export function pickedProjectDocumentFromResult(result: ProjectDocumentPickerResult, platform: string) {
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset) throw new Error('The document picker returned no file.');
  return {
    mimeType: asset.mimeType, name: asset.name, size: asset.size,
    source: platform === 'web' ? 'web-file-picker' : 'document-picker', uri: asset.uri,
  } satisfies PickedProjectAsset;
}

export function createProjectDocumentPicker(options: {
  getDocument: (configuration: {
    copyToCacheDirectory: boolean;
    multiple: false;
    type: string[];
  }) => Promise<ProjectDocumentPickerResult>;
  onDiagnostic?: (cause: unknown) => void;
  platform: string;
}, state: ProjectDocumentPickerState = { nativePickerActive: false }) {
  return async (): Promise<ProjectDocumentPickerOutcome> => {
    if (state.nativePickerActive) return { status: 'suppressed' };
    state.nativePickerActive = true;
    try {
      const result = await options.getDocument({
        copyToCacheDirectory: true,
        multiple: false,
        type: [
          'application/pdf', 'application/msword', 'application/rtf', 'application/vnd.ms-excel',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain',
        ],
      });
      const selection = pickedProjectDocumentFromResult(result, options.platform);
      return selection ? { selection, status: 'selected' } : { status: 'cancelled' };
    } catch (cause) {
      options.onDiagnostic?.(cause);
      throw new Error('Couldn’t open the file picker. Please try again.');
    } finally {
      state.nativePickerActive = false;
    }
  };
}

export async function runProjectDocumentPickerFlow<T>(options: {
  onError: (message: string | null) => void;
  pick: () => Promise<ProjectDocumentPickerOutcome>;
  upload: (selection: PickedProjectAsset) => Promise<T>;
}) {
  options.onError(null);
  try {
    const outcome = await options.pick();
    if (outcome.status !== 'selected') return outcome.status;
    await options.upload(outcome.selection);
    return 'uploaded' as const;
  } catch (cause) {
    options.onError(cause instanceof Error ? cause.message : 'Couldn’t open the file picker. Please try again.');
    return 'failed' as const;
  }
}

export async function loadProjectAssetSelectionBinary(selection: PickedProjectAsset, options: {
  fetchBinary: (uri: string) => Promise<ArrayBuffer>;
  platform: string;
  readNativeFile: (uri: string) => Promise<ArrayBuffer>;
}) {
  if (options.platform !== 'web' && selection.source === 'document-picker') {
    return options.readNativeFile(selection.uri);
  }
  return options.fetchBinary(selection.uri);
}

export type ProjectAssetStorage = {
  createSignedUrl(path: string): Promise<{ expiresAt: number; url: string }>;
  remove(path: string): Promise<void>;
  upload(path: string, contents: ArrayBuffer, mimeType: string): Promise<void>;
};

export type ProjectAssetSignedUrl = { expiresAt: number; url: string };

type OpenProjectAssetOriginalOptions = {
  asset: ProjectAsset;
  getSignedUrl: (asset: ProjectAsset, force?: boolean) => Promise<ProjectAssetSignedUrl>;
  invalidateSignedUrl: (assetId: string) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string | null) => void;
  openUrl: (url: string) => Promise<unknown>;
};

export function isProjectAssetSignedUrlFresh(
  value: ProjectAssetSignedUrl | undefined,
  now = Date.now(),
  refreshWindowMs = 30_000,
) {
  return Boolean(value && value.expiresAt > now + refreshWindowMs);
}

export async function openProjectAssetOriginal(options: OpenProjectAssetOriginalOptions) {
  options.onBusyChange(true);
  options.onError(null);
  try {
    const signed = await options.getSignedUrl(options.asset);
    try {
      await options.openUrl(signed.url);
    } catch {
      options.invalidateSignedUrl(options.asset.id);
      const fresh = await options.getSignedUrl(options.asset, true);
      await options.openUrl(fresh.url);
    }
  } catch (cause) {
    options.onError(cause instanceof Error ? cause.message : 'The asset could not be opened.');
  } finally {
    options.onBusyChange(false);
  }
}

export async function openProjectAssetSignedUrl(options: {
  canOpenExternalUrl: (url: string) => Promise<boolean>;
  openExternalUrl: (url: string) => Promise<unknown>;
  openInAppBrowser: (url: string) => Promise<unknown>;
  platform: string;
  url: string;
}) {
  if (options.platform === 'ios') {
    await options.openInAppBrowser(options.url);
    return;
  }
  if (!await options.canOpenExternalUrl(options.url)) {
    throw new Error('No app is available to open this file.');
  }
  await options.openExternalUrl(options.url);
}

export async function runProjectAssetUploadFlow<T>(options: {
  choose: () => Promise<PickedProjectAsset | null>;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onSuccess: (value: T) => void;
  perform: (selection: PickedProjectAsset) => Promise<T>;
}) {
  options.onBusyChange(true);
  options.onError(null);
  try {
    const selection = await options.choose();
    if (!selection) return 'canceled' as const;
    options.onSuccess(await options.perform(selection));
    return 'completed' as const;
  } catch (cause) {
    options.onError(cause instanceof Error ? cause.message : 'The file was not added.');
    return 'failed' as const;
  } finally {
    options.onBusyChange(false);
  }
}

type ProjectAssetServiceOptions = {
  createId?: () => string;
  loadBinary?: (selection: PickedProjectAsset) => Promise<ArrayBuffer>;
  now?: () => Date;
  storage: ProjectAssetStorage;
};

let fallbackSequence = 0;
function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `project-asset-${Date.now()}-${++fallbackSequence}`;
}

function extension(name: string) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLocaleLowerCase();
}

export function normalizeProjectAssetSelection(selection: PickedProjectAsset) {
  const filename = selection.name?.trim();
  if (!selection.uri?.trim() || !filename) throw new Error('The selected file is missing required picker metadata.');
  if (!Number.isFinite(selection.size) || (selection.size ?? 0) <= 0) {
    throw new Error('The selected file has an invalid or missing size.');
  }
  if ((selection.size ?? 0) > PROJECT_ASSET_MAX_BYTES) {
    throw new Error('Files must be 25 MB or smaller for this upload path.');
  }
  const reported = selection.mimeType?.trim().toLocaleLowerCase();
  const inferred = MIME_BY_EXTENSION[extension(filename)];
  const mimeType = !reported || reported === 'application/octet-stream' ? inferred : reported;
  if (!mimeType || !SUPPORTED_PROJECT_ASSET_MIME_TYPES.has(mimeType)) {
    throw new Error('That file type is not supported for Project uploads.');
  }
  if (reported && reported !== 'application/octet-stream' && inferred && reported !== inferred) {
    throw new Error('The file extension and MIME type do not match.');
  }
  if (mimeType.startsWith('image/')) {
    if (!Number.isFinite(selection.width) || !Number.isFinite(selection.height) ||
      (selection.width ?? 0) <= 0 || (selection.height ?? 0) <= 0) {
      throw new Error('The image picker could not provide safe preview dimensions.');
    }
    if ((selection.width ?? 0) > PROJECT_IMAGE_MAX_DIMENSION ||
      (selection.height ?? 0) > PROJECT_IMAGE_MAX_DIMENSION ||
      (selection.width ?? 0) * (selection.height ?? 0) > PROJECT_IMAGE_MAX_PIXELS) {
      throw new Error('That image is too large to preview safely on this device.');
    }
  }
  return { byteSize: selection.size as number, filename, mimeType };
}

export function isProjectAsset(resource: ProjectResource): resource is ProjectAsset {
  return Boolean(resource.resourceKind === 'uploaded_asset' && resource.storagePath &&
    resource.sectionId && resource.originalFilename &&
    resource.mimeType && typeof resource.byteSize === 'number' && resource.status);
}

export class ProjectAssetService {
  private readonly createId: () => string;
  private readonly loadBinary: (selection: PickedProjectAsset) => Promise<ArrayBuffer>;
  private readonly now: () => Date;
  private readonly uploads = new Map<string, Promise<ProjectAsset>>();

  constructor(private readonly repository: ProjectRepository, private readonly options: ProjectAssetServiceOptions) {
    this.createId = options.createId ?? defaultCreateId;
    this.loadBinary = options.loadBinary ?? (async (selection) => {
      const response = await fetch(selection.uri);
      if (!response.ok) throw new Error('The selected file could not be read.');
      return response.arrayBuffer();
    });
    this.now = options.now ?? (() => new Date());
  }

  async list(projectId: string, sectionId?: string, includeArchived = false) {
    await this.requireProject(projectId);
    if (sectionId) await this.repository.reconcileAssetUploads(projectId, sectionId);
    return (await this.repository.listResources(projectId)).filter((resource): resource is ProjectAsset =>
      isProjectAsset(resource) && (!sectionId || resource.sectionId === sectionId) &&
      (includeArchived || resource.status === 'current'));
  }

  async upload(projectId: string, sectionId: string, selection: PickedProjectAsset) {
    return this.uploadWithIdentity(projectId, sectionId, selection, this.createUploadIdentity());
  }

  createUploadIdentity(): ProjectAssetUploadIdentity {
    return { assetId: this.createId(), attemptId: this.createId(), objectId: this.createId() };
  }

  async uploadWithIdentity(projectId: string, sectionId: string, selection: PickedProjectAsset,
    identity: ProjectAssetUploadIdentity) {
    const running = this.uploads.get(identity.attemptId);
    if (running) return running;
    const operation = this.performUpload(projectId, sectionId, selection, identity);
    this.uploads.set(identity.attemptId, operation);
    try { return await operation; } finally { this.uploads.delete(identity.attemptId); }
  }

  async signedUrl(asset: ProjectAsset) {
    const authoritative = await this.requireAsset(asset.projectId, asset.id);
    if (authoritative.storagePath !== asset.storagePath) {
      throw new Error('The asset Storage identity no longer matches.');
    }
    return this.options.storage.createSignedUrl(authoritative.storagePath);
  }

  async rename(projectId: string, assetId: string, nameInput: string) {
    const asset = await this.requireAsset(projectId, assetId);
    const name = nameInput.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 180) throw new Error('Asset names must be between 1 and 180 characters.');
    if (asset.name === name) return asset;
    const updated = { ...asset, name, updatedAt: this.now().toISOString() };
    await this.repository.saveResource(updated);
    return updated;
  }

  async reassign(projectId: string, assetId: string, sectionId: string) {
    const asset = await this.requireAsset(projectId, assetId);
    await this.requireActiveSection(projectId, sectionId);
    if (asset.sectionId === sectionId) return asset;
    const updated = { ...asset, sectionId, updatedAt: this.now().toISOString() };
    await this.repository.saveResource(updated);
    return updated;
  }

  async archive(projectId: string, assetId: string) { return this.setStatus(projectId, assetId, 'archived'); }
  async restore(projectId: string, assetId: string) { return this.setStatus(projectId, assetId, 'current'); }

  private async setStatus(projectId: string, assetId: string, status: ProjectAsset['status']) {
    const asset = await this.requireAsset(projectId, assetId);
    if (asset.status === status) return asset;
    const updated = { ...asset, status, updatedAt: this.now().toISOString() };
    await this.repository.saveResource(updated);
    return updated;
  }

  private async requireProject(projectId: string) {
    if (!await this.repository.getProject(projectId)) throw new Error('Project was not found.');
  }

  private async requireActiveSection(projectId: string, sectionId: string) {
    await this.requireProject(projectId);
    const section = await this.repository.getSection(sectionId);
    if (!section || section.projectId !== projectId || section.status !== 'active') {
      throw new Error('The selected section does not belong to this active Project.');
    }
  }

  private async requireAsset(projectId: string, assetId: string) {
    const resource = await this.repository.getResource(assetId);
    if (!resource || !isProjectAsset(resource)) throw new Error('Project asset was not found.');
    if (resource.projectId !== projectId) throw new Error('The asset does not belong to that Project.');
    return resource;
  }

  private async performUpload(projectId: string, sectionId: string, selection: PickedProjectAsset,
    identity: ProjectAssetUploadIdentity) {
    await this.requireActiveSection(projectId, sectionId);
    const normalized = normalizeProjectAssetSelection(selection);
    let reservation = await this.repository.beginAssetUpload({
      ...identity, byteSize: normalized.byteSize,
      ...(selection.height ? { height: selection.height } : {}), mimeType: normalized.mimeType,
      originalFilename: normalized.filename, picker: selection.source, projectId, sectionId,
      ...(selection.width ? { width: selection.width } : {}),
    });
    if (reservation.status === 'finalized') return this.repository.finalizeAssetUpload(identity.attemptId);

    if (!reservation.objectExists) {
      const contents = await this.loadBinary(selection);
      if (contents.byteLength !== normalized.byteSize) {
        throw new Error('The selected file changed before it could be uploaded.');
      }
      try {
        await this.options.storage.upload(reservation.storagePath, contents, normalized.mimeType);
        this.observeInMemoryObject(identity.attemptId, true);
      } catch (uploadError) {
        reservation = await this.repository.beginAssetUpload({
          ...identity, byteSize: normalized.byteSize,
          ...(selection.height ? { height: selection.height } : {}), mimeType: normalized.mimeType,
          originalFilename: normalized.filename, picker: selection.source, projectId, sectionId,
          ...(selection.width ? { width: selection.width } : {}),
        });
        if (!reservation.objectExists) throw uploadError;
      }
    }

    try {
      return await this.repository.finalizeAssetUpload(identity.attemptId);
    } catch (firstFailure) {
      try {
        return await this.repository.finalizeAssetUpload(identity.attemptId);
      } catch {
        await this.cleanupUnfinalized(reservation).catch(() => undefined);
        throw firstFailure;
      }
    }
  }

  private async cleanupUnfinalized(reservation: ProjectAssetUploadReservation) {
    await this.options.storage.remove(reservation.storagePath);
    this.observeInMemoryObject(reservation.attemptId, false);
    await this.repository.markAssetUploadCleaned(reservation.attemptId);
  }

  private observeInMemoryObject(attemptId: string, exists: boolean) {
    const repository = this.repository as ProjectRepository & {
      setAssetUploadObjectExists?: (id: string, value: boolean) => void;
    };
    repository.setAssetUploadObjectExists?.(attemptId, exists);
  }
}

export function createSupabaseProjectAssetStorage(): ProjectAssetStorage {
  return {
    async createSignedUrl(path) {
      const { data, error } = await getSupabaseClient().storage
        .from(PROJECT_ASSET_BUCKET).createSignedUrl(path, PROJECT_ASSET_SIGNED_URL_SECONDS);
      if (error || !data?.signedUrl) throw error ?? new Error('The asset could not be opened.');
      return { expiresAt: Date.now() + PROJECT_ASSET_SIGNED_URL_SECONDS * 1000,
        url: data.signedUrl };
    },
    async remove(path) {
      const { error } = await getSupabaseClient().storage.from(PROJECT_ASSET_BUCKET).remove([path]);
      if (error) throw error;
    },
    async upload(path, contents, mimeType) {
      const { error } = await getSupabaseClient().storage.from(PROJECT_ASSET_BUCKET)
        .upload(path, contents, { cacheControl: '3600', contentType: mimeType, upsert: false });
      if (error) throw error;
    },
  };
}
