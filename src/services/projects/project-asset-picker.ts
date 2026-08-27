import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import type { PickedProjectAsset } from './project-asset-service';

export async function pickProjectDocument(): Promise<PickedProjectAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true, multiple: false,
    type: [
      'application/pdf', 'application/msword', 'application/rtf', 'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain',
    ],
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return { mimeType: asset.mimeType, name: asset.name, size: asset.size,
    source: Platform.OS === 'web' ? 'web-file-picker' : 'document-picker', uri: asset.uri };
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
