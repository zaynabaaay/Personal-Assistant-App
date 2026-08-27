import { useEffect, useRef, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { Image, Linking, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ProjectAsset, ProjectSection } from '@/domain/projects';
import { pickProjectDocument, pickProjectImage } from '@/services/projects/project-asset-picker';
import { projectAssetService } from '@/services/projects/project-client';
import {
  isProjectAssetSignedUrlFresh,
  openProjectAssetSignedUrl,
  openProjectAssetOriginal,
  runProjectDocumentPickerFlow,
  runProjectAssetUploadFlow,
} from '@/services/projects/project-asset-service';
import type { PickedProjectAsset, ProjectAssetSignedUrl } from '@/services/projects/project-asset-service';
import type { ProjectAssetUploadIdentity } from '@/services/projects/project-repository';

type SignedAssetUrl = ProjectAssetSignedUrl;
type PendingUpload = { identity: ProjectAssetUploadIdentity; selection: PickedProjectAsset };

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function typeLabel(asset: ProjectAsset) {
  if (asset.type === 'image') return 'Image';
  if (asset.type === 'pdf') return 'PDF';
  if (asset.type === 'spreadsheet') return 'Spreadsheet';
  return 'Document';
}

function AssetDetail({ asset, getSignedUrl, invalidateSignedUrl, onChanged, onClose, onError,
  projectId, sections, url }: {
  asset: ProjectAsset;
  getSignedUrl: (asset: ProjectAsset, force?: boolean) => Promise<SignedAssetUrl>;
  invalidateSignedUrl: (assetId: string) => void;
  onChanged: (asset: ProjectAsset) => void;
  onClose: () => void;
  onError: (message: string | null) => void;
  projectId: string;
  sections: readonly ProjectSection[];
  url?: SignedAssetUrl;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(asset.name);
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const act = async (operation: () => Promise<ProjectAsset>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setActionError(null);
    onError(null);
    try { onChanged(await operation()); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The asset could not be updated.';
      setActionError(message);
      onError(message);
    }
    finally { actionInFlight.current = false; setBusy(false); }
  };
  const open = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      await openProjectAssetOriginal({
        asset,
        getSignedUrl,
        invalidateSignedUrl,
        onBusyChange: setBusy,
        onError: (message) => { setActionError(message); onError(message); },
        openUrl: (signedUrl) => openProjectAssetSignedUrl({
          canOpenExternalUrl: Linking.canOpenURL,
          openExternalUrl: Linking.openURL,
          openInAppBrowser: (urlToOpen) => WebBrowser.openBrowserAsync(urlToOpen, {
            dismissButtonStyle: 'done', presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
          }),
          platform: Platform.OS,
          url: signedUrl,
        }),
      });
    } finally { actionInFlight.current = false; }
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.backdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.detail} testID="project-asset-detail">
          {asset.type === 'image' && url ? <Image resizeMode="contain" source={{ uri: url.url }} style={styles.detailImage} /> : (
            <View style={styles.documentHero}><Text style={styles.documentHeroType}>{typeLabel(asset)}</Text></View>
          )}
          {editing ? <>
            <TextInput autoFocus maxLength={180} onChangeText={setName} style={styles.input} value={name} />
            <Pressable disabled={busy || !name.trim()} onPress={() => void act(async () => {
              const updated = await projectAssetService.rename(projectId, asset.id, name);
              setEditing(false);
              return updated;
            })} style={styles.primary}><Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save name'}</Text></Pressable>
          </> : <>
            <Text style={styles.detailName}>{asset.name}</Text>
            {asset.name !== asset.originalFilename ? <Text style={styles.originalName}>Original: {asset.originalFilename}</Text> : null}
            <Text style={styles.metadata}>{typeLabel(asset)} · {readableSize(asset.byteSize)} · Added {new Date(asset.createdAt).toLocaleDateString()}</Text>
            <Pressable disabled={busy} onPress={() => void open()} style={styles.primary} testID="open-project-asset"><Text style={styles.primaryText}>{busy ? 'Opening…' : 'Open original'}</Text></Pressable>
            <Pressable onPress={() => setEditing(true)} style={styles.row}><Text style={styles.rowText}>Rename display name</Text></Pressable>
            <Pressable onPress={() => setMoving((value) => !value)} style={styles.row}><Text style={styles.rowText}>Move to section</Text></Pressable>
            {moving ? <View style={styles.sectionChoices}>
              {sections.filter((section) => section.status === 'active' && section.id !== asset.sectionId).map((section) => (
                <Pressable disabled={busy} key={section.id} onPress={() => void act(async () => {
                  const updated = await projectAssetService.reassign(projectId, asset.id, section.id);
                  setMoving(false);
                  return updated;
                })} style={styles.sectionChoice}><Text style={styles.sectionChoiceText}>{section.title}</Text></Pressable>
              ))}
            </View> : null}
            <Pressable disabled={busy} onPress={() => void act(() => asset.status === 'current'
              ? projectAssetService.archive(projectId, asset.id)
              : projectAssetService.restore(projectId, asset.id))} style={styles.row}>
              <Text style={asset.status === 'current' ? styles.archiveText : styles.rowText}>{asset.status === 'current' ? 'Archive' : 'Restore'}</Text>
            </Pressable>
          </>}
          {actionError ? <Text accessibilityLiveRegion="assertive" style={styles.actionError}>{actionError}</Text> : null}
          <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>Done</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function ProjectSectionAssets({ onError, projectId, section, sections }: {
  onError: (message: string | null) => void;
  projectId: string;
  section: ProjectSection;
  sections: readonly ProjectSection[];
}) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [urls, setUrls] = useState<Record<string, SignedAssetUrl>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<ProjectAsset | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const documentPickerAfterDismiss = useRef(false);
  const uploadInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    projectAssetService.list(projectId, section.id, true).then(
      (values) => active && setAssets(values),
      () => active && onError('Project material could not be loaded.'),
    );
    return () => { active = false; };
  }, [onError, projectId, section.id]);

  useEffect(() => {
    let active = true;
    const missing = assets.filter((asset) => asset.type === 'image' &&
      !isProjectAssetSignedUrlFresh(urls[asset.id]));
    if (missing.length) Promise.all(missing.map(async (asset) => [asset.id, await projectAssetService.signedUrl(asset)] as const))
      .then((pairs) => active && setUrls((current) => ({ ...current, ...Object.fromEntries(pairs) })))
      .catch(() => active && onError('An image preview could not be loaded.'));
    return () => { active = false; };
  }, [assets, onError, urls]);

  const getSignedUrl = async (asset: ProjectAsset, force = false) => {
    const current = urls[asset.id];
    if (!force && isProjectAssetSignedUrlFresh(current)) return current as SignedAssetUrl;
    const fresh = await projectAssetService.signedUrl(asset);
    setUrls((values) => ({ ...values, [asset.id]: fresh }));
    return fresh;
  };

  const invalidateSignedUrl = (assetId: string) => setUrls((current) => {
    const next = { ...current };
    delete next[assetId];
    return next;
  });

  const upload = async (pick?: () => Promise<PickedProjectAsset | null>, retry?: PendingUpload,
    selectedFile?: PickedProjectAsset) => {
    if (uploadInFlight.current) return;
    uploadInFlight.current = true;
    setAddOpen(false);
    try {
      await runProjectAssetUploadFlow<ProjectAsset>({
        choose: async () => selectedFile ?? retry?.selection ?? await pick?.() ?? null,
        onBusyChange: setUploading,
        onError,
        onSuccess: (asset) => {
          setAssets((current) => [asset, ...current]);
          setPendingUpload(null);
        },
        perform: async (selection) => {
          const identity = retry?.identity ?? projectAssetService.createUploadIdentity();
          setPendingUpload({ identity, selection });
          return projectAssetService.uploadWithIdentity(projectId, section.id, selection, identity);
        },
      });
    } finally { uploadInFlight.current = false; }
  };

  const pickAndUploadDocument = async () => {
    await runProjectDocumentPickerFlow({
      onError,
      pick: pickProjectDocument,
      upload: (selection) => upload(undefined, undefined, selection),
    });
  };

  const requestDocumentPicker = () => {
    onError(null);
    setAddOpen(false);
    if (Platform.OS === 'ios') {
      documentPickerAfterDismiss.current = true;
      return;
    }
    void pickAndUploadDocument();
  };

  const addSheetDismissed = () => {
    if (!documentPickerAfterDismiss.current) return;
    documentPickerAfterDismiss.current = false;
    void pickAndUploadDocument();
  };

  const changed = (asset: ProjectAsset) => {
    setAssets((current) => asset.sectionId === section.id
      ? current.map((value) => value.id === asset.id ? asset : value)
      : current.filter((value) => value.id !== asset.id));
    setSelected(asset.sectionId === section.id ? asset : null);
  };
  const current = assets.filter((asset) => asset.status === 'current');
  const archived = assets.filter((asset) => asset.status === 'archived');
  const visible = showArchived ? archived : current;

  return <View style={styles.surface} testID="project-section-assets">
    <View style={styles.header}>
      <View><Text style={styles.heading}>{section.title}</Text><Text style={styles.subheading}>{current.length ? `${current.length} source item${current.length === 1 ? '' : 's'}` : 'Source material lives here'}</Text></View>
      <Pressable disabled={uploading} onPress={() => setAddOpen(true)} style={styles.add} testID="add-project-asset"><Text style={styles.addText}>{uploading ? 'Adding…' : '+ Add'}</Text></Pressable>
    </View>
    {visible.length ? <View style={styles.collection}>
      {visible.map((asset) => asset.type === 'image' ? (
        <Pressable key={asset.id} onPress={() => setSelected(asset)} style={styles.imageCard} testID="project-image-asset">
          {urls[asset.id] ? <Image onError={() => void getSignedUrl(asset, true).catch(() => onError('An image preview could not be refreshed.'))} resizeMode="cover" source={{ uri: urls[asset.id].url }} style={[styles.imagePreview, asset.width && asset.height ? { aspectRatio: asset.width / asset.height } : null]} /> : <View style={styles.imagePlaceholder} />}
          <Text numberOfLines={2} style={styles.assetName}>{asset.name}</Text>
          <Text style={styles.assetMeta}>{readableSize(asset.byteSize)}</Text>
        </Pressable>
      ) : (
        <Pressable key={asset.id} onPress={() => setSelected(asset)} style={styles.documentRow} testID="project-document-asset">
          <View style={styles.fileType}><Text style={styles.fileTypeText}>{asset.type === 'pdf' ? 'PDF' : asset.type === 'spreadsheet' ? 'XLS' : 'DOC'}</Text></View>
          <View style={styles.fileCopy}><Text numberOfLines={2} style={styles.assetName}>{asset.name}</Text><Text style={styles.assetMeta}>{typeLabel(asset)} · {readableSize(asset.byteSize)}</Text></View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}
    </View> : <Text style={styles.empty}>{showArchived ? 'No archived material.' : 'Add an image, PDF, or supported document. Originals stay preserved.'}</Text>}
    {archived.length ? <Pressable onPress={() => setShowArchived((value) => !value)} style={styles.archivedToggle} testID="toggle-archived-project-assets"><Text style={styles.archivedText}>{showArchived ? 'Show current material' : `Archived (${archived.length})`}</Text></Pressable> : null}
    {pendingUpload && !uploading ? <Pressable onPress={() => void upload(undefined, pendingUpload)} style={styles.retry} testID="retry-project-asset-upload"><Text style={styles.archivedText}>Retry last upload</Text></Pressable> : null}

    <Modal animationType="fade" onDismiss={addSheetDismissed} onRequestClose={() => setAddOpen(false)} transparent visible={addOpen}>
      <Pressable onPress={() => setAddOpen(false)} style={styles.backdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.addSheet}>
          <Text style={styles.sheetTitle}>Add to {section.title}</Text>
          <Pressable onPress={() => void upload(pickProjectImage)} style={styles.addChoice}><Text style={styles.choiceTitle}>Photo or image</Text><Text style={styles.choiceDetail}>JPEG, PNG, WebP, GIF, HEIC, or HEIF</Text></Pressable>
          <Pressable onPress={requestDocumentPicker} style={styles.addChoice}><Text style={styles.choiceTitle}>File or document</Text><Text style={styles.choiceDetail}>PDF, Word, text, RTF, Excel, or PowerPoint · up to 25 MB</Text></Pressable>
          <Pressable onPress={() => setAddOpen(false)} style={styles.close}><Text style={styles.closeText}>Cancel</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
    {selected ? <AssetDetail asset={selected} getSignedUrl={getSignedUrl} invalidateSignedUrl={invalidateSignedUrl} onChanged={changed} onClose={() => setSelected(null)} onError={onError} projectId={projectId} sections={sections} url={urls[selected.id]} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  surface: { borderTopColor: '#18181B', borderTopWidth: StyleSheet.hairlineWidth, marginHorizontal: 20, minHeight: 260, paddingBottom: 42, paddingTop: 24 },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  heading: { color: '#EDEDEF', fontSize: 18, fontWeight: '600' },
  subheading: { color: '#717177', fontSize: 12, marginTop: 4 },
  add: { backgroundColor: '#1A2331', borderRadius: 16, minHeight: 34, justifyContent: 'center', paddingHorizontal: 13 },
  addText: { color: '#AFC6E8', fontSize: 13, fontWeight: '600' },
  collection: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  imageCard: { backgroundColor: '#101012', borderColor: '#242428', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, flexBasis: 190, flexGrow: 1, maxWidth: 360, minWidth: 145, overflow: 'hidden', paddingBottom: 11 },
  imagePreview: { backgroundColor: '#18181B', maxHeight: 260, minHeight: 110, width: '100%' },
  imagePlaceholder: { backgroundColor: '#18181B', height: 130 },
  documentRow: { alignItems: 'center', backgroundColor: '#101012', borderColor: '#242428', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, flexBasis: 300, flexDirection: 'row', flexGrow: 1, minHeight: 74, padding: 11 },
  fileType: { alignItems: 'center', backgroundColor: '#20242B', borderRadius: 9, height: 44, justifyContent: 'center', width: 44 },
  fileTypeText: { color: '#A9B8CE', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  fileCopy: { flex: 1, marginLeft: 12 }, assetName: { color: '#E0E0E3', fontSize: 14, fontWeight: '500', lineHeight: 19, marginHorizontal: 11, marginTop: 10 },
  assetMeta: { color: '#6F6F75', fontSize: 11, marginHorizontal: 11, marginTop: 4 },
  chevron: { color: '#66666C', fontSize: 25 }, empty: { color: '#68686E', fontSize: 13, lineHeight: 20, maxWidth: 420, paddingVertical: 12 },
  archivedToggle: { alignSelf: 'flex-start', marginTop: 20, minHeight: 36, justifyContent: 'center' }, archivedText: { color: '#7F8EA5', fontSize: 12, fontWeight: '600' },
  retry: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 36, marginTop: 8 },
  actionError: { color: '#E39A8E', fontSize: 12, lineHeight: 17, marginTop: 10 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.72)', flex: 1, justifyContent: 'flex-end' },
  addSheet: { backgroundColor: '#111113', borderColor: '#29292D', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingBottom: 26, paddingHorizontal: 16, paddingTop: 18 },
  sheetTitle: { color: '#F2F2F4', fontSize: 18, fontWeight: '600', marginBottom: 12 },
  addChoice: { borderBottomColor: '#29292D', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 67, justifyContent: 'center' },
  choiceTitle: { color: '#ECECEF', fontSize: 15, fontWeight: '500' }, choiceDetail: { color: '#707076', fontSize: 11, marginTop: 4 },
  detail: { backgroundColor: '#111113', borderColor: '#29292D', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, maxHeight: '92%', paddingBottom: 24, paddingHorizontal: 16, paddingTop: 16 },
  detailImage: { backgroundColor: '#080809', borderRadius: 12, height: 280, marginBottom: 16, width: '100%' },
  documentHero: { alignItems: 'center', backgroundColor: '#1A1D23', borderRadius: 13, height: 120, justifyContent: 'center', marginBottom: 16 },
  documentHeroType: { color: '#A9B8CE', fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  detailName: { color: '#F0F0F2', fontSize: 19, fontWeight: '600' }, originalName: { color: '#828288', fontSize: 12, marginTop: 6 }, metadata: { color: '#6F6F75', fontSize: 12, marginBottom: 16, marginTop: 7 },
  input: { backgroundColor: '#1B1B1E', borderColor: '#343438', borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, color: '#F4F4F5', fontSize: 15, marginBottom: 11, minHeight: 47, paddingHorizontal: 13 },
  primary: { alignItems: 'center', backgroundColor: '#8AB4F8', borderRadius: 11, justifyContent: 'center', minHeight: 45, marginBottom: 7 }, primaryText: { color: '#08111F', fontSize: 14, fontWeight: '700' },
  row: { borderBottomColor: '#29292D', borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 48 }, rowText: { color: '#E2E2E5', fontSize: 14 }, archiveText: { color: '#D58F86', fontSize: 14 },
  sectionChoices: { backgroundColor: '#18181B', borderRadius: 10, padding: 6 }, sectionChoice: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 9 }, sectionChoiceText: { color: '#C9C9CD', fontSize: 13 },
  close: { justifyContent: 'center', minHeight: 47, marginTop: 6 }, closeText: { color: '#8C8C92', fontSize: 14, textAlign: 'center' },
});
