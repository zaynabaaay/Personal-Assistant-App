import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ProjectSection } from '@/domain/projects';
import { projectService } from '@/services/projects/project-client';
import { PROJECT_SECTION_TITLE_MAX_LENGTH } from '@/services/projects/project-service';

export function ProjectSectionsManager({
  onChanged,
  onClose,
  projectId,
  sections,
  visible,
}: {
  onChanged: (sections: ProjectSection[]) => void;
  onClose: () => void;
  projectId: string;
  sections: readonly ProjectSection[];
  visible: boolean;
}) {
  const [title, setTitle] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useMemo(
    () => sections.filter((section) => section.status === 'active'),
    [sections],
  );
  const archived = useMemo(
    () => sections.filter((section) => section.status === 'archived'),
    [sections],
  );

  const close = () => {
    setTitle('');
    setEditingId(null);
    setError(null);
    onClose();
  };

  const refresh = async () => {
    onChanged(await projectService.listSections(projectId));
  };

  const perform = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The section could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const value = title.trim();
    if (!value) return;
    void perform(async () => {
      if (editingId) await projectService.renameSection(projectId, editingId, value);
      else await projectService.addSection(projectId, value);
      setTitle('');
      setEditingId(null);
    });
  };

  const beginRename = (section: ProjectSection) => {
    setEditingId(section.id);
    setTitle(section.title);
    setError(null);
  };

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (index < 1 || target < 1 || target >= active.length) return;
    const ids = active.map((section) => section.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void perform(() => projectService.reorderSections(projectId, ids));
  };

  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <View style={styles.sheet} testID="project-sections-manager">
          <View style={styles.header}>
            <Text style={styles.title}>Project sections</Text>
            <Pressable accessibilityRole="button" onPress={close} style={styles.closeButton}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>

          <View style={styles.editor}>
            <TextInput
              autoCapitalize="words"
              editable={!busy}
              keyboardAppearance="dark"
              maxLength={PROJECT_SECTION_TITLE_MAX_LENGTH}
              onChangeText={setTitle}
              placeholder={editingId ? 'Section title' : 'Add a section'}
              placeholderTextColor="#5C5C62"
              style={styles.input}
              testID="project-section-title-input"
              value={title}
            />
            <Pressable
              accessibilityRole="button"
              disabled={busy || !title.trim()}
              onPress={submit}
              style={styles.saveButton}
              testID="save-project-section"
            >
              <Text style={[styles.saveText, (busy || !title.trim()) && styles.disabledText]}>
                {editingId ? 'Rename' : 'Add'}
              </Text>
            </Pressable>
          </View>
          {editingId ? (
            <Pressable onPress={() => { setEditingId(null); setTitle(''); }}>
              <Text style={styles.cancelRename}>Cancel rename</Text>
            </Pressable>
          ) : null}
          {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={styles.label}>Active</Text>
            {active.map((section, index) => (
              <View key={section.id} style={styles.row}>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>{section.title}</Text>
                  {section.isDefault ? <Text style={styles.defaultLabel}>Default</Text> : null}
                </View>
                {!section.isDefault ? (
                  <View style={styles.rowActions}>
                    <Pressable accessibilityLabel={`Move ${section.title} left`} disabled={busy || index <= 1} onPress={() => move(index, -1)} style={styles.smallButton}><Text style={[styles.smallText, index <= 1 && styles.disabledText]}>‹</Text></Pressable>
                    <Pressable accessibilityLabel={`Move ${section.title} right`} disabled={busy || index >= active.length - 1} onPress={() => move(index, 1)} style={styles.smallButton}><Text style={[styles.smallText, index >= active.length - 1 && styles.disabledText]}>›</Text></Pressable>
                    <Pressable disabled={busy} onPress={() => beginRename(section)} style={styles.textButton}><Text style={styles.actionText}>Rename</Text></Pressable>
                    <Pressable disabled={busy} onPress={() => void perform(() => projectService.archiveSection(projectId, section.id))} style={styles.textButton}><Text style={styles.archiveText}>Archive</Text></Pressable>
                  </View>
                ) : null}
              </View>
            ))}

            {archived.length > 0 ? (
              <View style={styles.archivedGroup} testID="archived-project-sections">
                <Text style={styles.label}>Archived</Text>
                {archived.map((section) => (
                  <View key={section.id} style={styles.row}>
                    <Text style={[styles.rowTitle, styles.archivedTitle]}>{section.title}</Text>
                    <Pressable disabled={busy} onPress={() => void perform(() => projectService.restoreSection(projectId, section.id))} style={styles.textButton}><Text style={styles.actionText}>Restore</Text></Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.68)', flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0D0D0F', borderColor: '#29292D', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, maxHeight: '78%', minHeight: '48%', paddingBottom: 20 },
  header: { alignItems: 'center', borderBottomColor: '#242427', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 56, paddingHorizontal: 18 },
  title: { color: '#F1F1F3', fontSize: 17, fontWeight: '600' },
  closeButton: { justifyContent: 'center', minHeight: 40, paddingLeft: 16 },
  closeText: { color: '#A8B9D4', fontSize: 14, fontWeight: '600' },
  editor: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 16 },
  input: { backgroundColor: '#18181B', borderColor: '#303034', borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, color: '#F2F2F4', flex: 1, fontSize: 15, minHeight: 44, paddingHorizontal: 12 },
  saveButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 10 },
  saveText: { color: '#A8B9D4', fontSize: 14, fontWeight: '600' },
  cancelRename: { color: '#77777D', fontSize: 12, paddingHorizontal: 18, paddingTop: 9 },
  error: { color: '#E39A8E', fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 10 },
  content: { paddingBottom: 22, paddingHorizontal: 16, paddingTop: 20 },
  label: { color: '#66666C', fontSize: 11, fontWeight: '600', letterSpacing: 0.4, marginBottom: 8, textTransform: 'uppercase' },
  row: { alignItems: 'center', borderBottomColor: '#232326', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 54, paddingVertical: 7 },
  rowCopy: { flex: 1 },
  rowTitle: { color: '#E6E6E8', flex: 1, fontSize: 14 },
  defaultLabel: { color: '#5F6066', fontSize: 10, marginTop: 3 },
  rowActions: { alignItems: 'center', flexDirection: 'row' },
  smallButton: { alignItems: 'center', height: 36, justifyContent: 'center', width: 30 },
  smallText: { color: '#A7A7AC', fontSize: 21 },
  textButton: { justifyContent: 'center', minHeight: 36, paddingHorizontal: 7 },
  actionText: { color: '#929FAF', fontSize: 12 },
  archiveText: { color: '#9B7773', fontSize: 12 },
  disabledText: { color: '#424247' },
  archivedGroup: { marginTop: 24 },
  archivedTitle: { color: '#77777D' },
});
