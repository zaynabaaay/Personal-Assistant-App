import { useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { projectService } from '@/services/projects/project-client';

function currentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export default function NewProjectScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = name.trim().length > 0 && !saving;

  const create = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      const result = await projectService.createProject({
        ...(description.trim() ? { description: description.trim() } : {}),
        name: name.trim(),
        status: 'active',
        timezone: currentTimezone(),
      });
      router.replace({
        pathname: '/projects/[id]',
        params: { id: result.value.id },
      } as unknown as Href);
    } catch {
      setError('The Project could not be created. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} testID="new-project-screen">
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerButton}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>New Project</Text>
          <Pressable disabled={!canCreate} onPress={create} style={styles.headerButton} testID="create-project-button">
            {saving ? <ActivityIndicator color="#8AB4F8" size="small" /> : (
              <Text style={[styles.create, !canCreate && styles.disabled]}>Create</Text>
            )}
          </Pressable>
        </View>
        <View style={styles.form}>
          <Text style={styles.label}>Project name</Text>
          <TextInput
            autoFocus
            keyboardAppearance="dark"
            maxLength={300}
            onChangeText={setName}
            placeholder="What are you working on?"
            placeholderTextColor="#55555B"
            style={styles.input}
            testID="project-name-input"
            value={name}
          />
          <Text style={[styles.label, styles.descriptionLabel]}>Short description</Text>
          <TextInput
            keyboardAppearance="dark"
            maxLength={600}
            multiline
            onChangeText={setDescription}
            placeholder="What is this Project?"
            placeholderTextColor="#55555B"
            style={[styles.input, styles.descriptionInput]}
            testID="project-description-input"
            value={description}
          />
          <Text style={styles.hint}>That’s enough to begin. You can shape the rest with Tina inside the Project.</Text>
          {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#050505', flex: 1 },
  flex: { flex: 1 },
  header: { alignItems: 'center', borderBottomColor: '#171719', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 54, paddingHorizontal: 12 },
  headerButton: { justifyContent: 'center', minHeight: 44, minWidth: 66 },
  cancel: { color: '#9A9AA0', fontSize: 15 },
  title: { color: '#F5F5F7', fontSize: 17, fontWeight: '600' },
  create: { color: '#8AB4F8', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  disabled: { color: '#444449' },
  form: { padding: 22 },
  label: { color: '#A1A1A7', fontSize: 13, fontWeight: '500', marginBottom: 8 },
  descriptionLabel: { marginTop: 22 },
  input: { backgroundColor: '#111113', borderColor: '#29292D', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, color: '#F4F4F6', fontSize: 16, minHeight: 50, paddingHorizontal: 15, paddingVertical: 13 },
  descriptionInput: { lineHeight: 21, minHeight: 100, textAlignVertical: 'top' },
  hint: { color: '#6F6F75', fontSize: 13, lineHeight: 19, marginTop: 14 },
  error: { color: '#E39A8E', fontSize: 13, marginTop: 16 },
});
