import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { createProjectDocumentPicker } from './project-asset-service';
import type { PickedProjectAsset, ProjectDocumentPickerOutcome, ProjectDocumentPickerState } from './project-asset-service';

const pickerGlobal = globalThis as typeof globalThis & {
  __tinaProjectDocumentPickerState?: ProjectDocumentPickerState;
};
const documentPickerState = pickerGlobal.__tinaProjectDocumentPickerState ??= { nativePickerActive: false };

const pickProjectDocumentSingleFlight = createProjectDocumentPicker({
  getDocument: (configuration) => DocumentPicker.getDocumentAsync(configuration),
  onDiagnostic: (cause) => {
    if (__DEV__) console.warn('Project document picker failed.', cause);
  },
  platform: Platform.OS,
}, documentPickerState);

export async function pickProjectDocument(): Promise<ProjectDocumentPickerOutcome> {
  return pickProjectDocumentSingleFlight();
}

export async function pickProjectImage(): Promise<PickedProjectAsset | null> {
  if (Platform.OS !== 'web') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('Photo access is needed to select an image.');
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: false, mediaTypes: ['images'], quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const uriFilename = decodeURIComponent(asset.uri.split('/').pop()?.split('?')[0] ?? '').trim();
  return { height: asset.height, mimeType: asset.mimeType, name: (asset.fileName ?? uriFilename) || null,
    size: asset.fileSize, source: Platform.OS === 'web' ? 'web-file-picker' : 'photo-library',
    uri: asset.uri, width: asset.width };
}
