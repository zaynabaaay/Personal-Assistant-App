import { useEffect, useRef, useState } from 'react';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  Alert,
  Animated,
  Keyboard,
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
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Project, ProjectSection, ProjectWorkSession, ProjectWorkSessionEntry } from '@/domain/projects';
import { useReducedMotion } from '@/features/accessibility/use-reduced-motion';
import { MessageComposer } from '@/features/home/message-composer';
import {
  MESSAGE_INPUT_MIN_HEIGHT,
  messageInputHeight,
  messageSendEnabled,
} from '@/features/home/message-composer-layout';
import { useVisibleViewport } from '@/features/home/use-visible-viewport';
import { assistantService } from '@/services/assistant/assistant-service';
import { projectChatService, projectRepository, projectService } from '@/services/projects/project-client';

import { projectFallbackInitial } from './project-presentation';
import { ProjectSectionAssets } from './project-section-assets';
import { ProjectSectionNavigation } from './project-section-navigation';
import { ProjectSectionsManager } from './project-sections-manager';

const KEYBOARD_AVOIDING_BEHAVIOR = Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined;

function ThinkingIndicator() {
  const reducedMotion = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reducedMotion) { progress.setValue(0.5); return; }
    const animation = Animated.loop(Animated.timing(progress, { duration: 1050, toValue: 1, useNativeDriver: true }));
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion]);
  return (
    <View accessibilityLabel="Tina is thinking" style={styles.thinking} testID="project-thinking-indicator">
      {[0, 1, 2].map((index) => <Animated.View key={index} style={[styles.dot, { opacity: reducedMotion ? 0.55 : progress.interpolate({ inputRange: [0, 0.08 + index * 0.18, 0.38 + index * 0.18, 1], outputRange: [0.25, 0.25, 0.9, 0.25] }) }]} />)}
    </View>
  );
}

function Transcript({ entries, responding }: { entries: ProjectWorkSessionEntry[]; responding: boolean }) {
  const scroll = useRef<ScrollView>(null);
  return (
    <ScrollView
      contentContainerStyle={styles.transcriptContent}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      ref={scroll}
      showsVerticalScrollIndicator={false}
      style={styles.transcript}
      testID="project-conversation-scroll"
    >
      {entries.length === 0 && !responding ? <Text style={styles.tinaEmpty}>Ask about anything in this Project.</Text> : null}
      {entries.map((entry) => {
        const user = entry.kind === 'user_message';
        return <View key={entry.id} style={user ? styles.userMessage : styles.assistantMessage}><Text style={user ? styles.userText : styles.assistantText}>{entry.content}</Text></View>;
      })}
      {responding ? <ThinkingIndicator /> : null}
    </ScrollView>
  );
}

function ProjectActions({ onClose, onManageSections, onUpdated, project, visible }: {
  onClose: () => void;
  onManageSections: () => void;
  onUpdated: (project: Project) => void;
  project: Project;
  visible: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const update = async (input: Parameters<typeof projectService.updateProject>[1]) => {
    setSaving(true);
    try {
      const result = await projectService.updateProject(project.id, input);
      onUpdated(result.value);
      setEditing(false);
      onClose();
    } finally { setSaving(false); }
  };
  const archive = () => Alert.alert('Archive this Project?', 'It will remain available in the Archived collection.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Archive', style: 'destructive', onPress: () => void update({ status: 'archived' }) },
  ]);
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable onPress={onClose} style={styles.modalBackdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.actionSheet}>
          {editing ? <>
            <Text style={styles.sheetTitle}>Edit Project</Text>
            <TextInput keyboardAppearance="dark" maxLength={300} onChangeText={setName} style={styles.sheetInput} value={name} />
            <TextInput keyboardAppearance="dark" maxLength={600} multiline onChangeText={setDescription} placeholder="Short description" placeholderTextColor="#55555B" style={[styles.sheetInput, styles.sheetDescription]} value={description} />
            <Pressable disabled={saving || !name.trim()} onPress={() => update({ ...(description.trim() ? { description: description.trim() } : {}), name: name.trim() })} style={styles.primaryAction}><Text style={styles.primaryActionText}>{saving ? 'Saving…' : 'Save changes'}</Text></Pressable>
          </> : <>
            <Pressable onPress={() => setEditing(true)} style={styles.actionRow}><Text style={styles.actionText}>Edit Project</Text></Pressable>
            <Pressable onPress={() => { onClose(); onManageSections(); }} style={styles.actionRow} testID="manage-project-sections"><Text style={styles.actionText}>Manage sections</Text></Pressable>
            {project.status === 'active' ? <Pressable onPress={() => void update({ status: 'paused' })} style={styles.actionRow}><Text style={styles.actionText}>Pause</Text></Pressable> : null}
            {project.status === 'paused' ? <Pressable onPress={() => void update({ status: 'active' })} style={styles.actionRow}><Text style={styles.actionText}>Resume</Text></Pressable> : null}
            {project.status !== 'archived' ? <Pressable onPress={archive} style={styles.actionRow}><Text style={styles.destructiveText}>Archive</Text></Pressable> : null}
          </>}
          <Pressable onPress={onClose} style={[styles.actionRow, styles.cancelRow]}><Text style={styles.cancelText}>Cancel</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const visibleViewport = useVisibleViewport();
  const [project, setProject] = useState<Project | null>(null);
  const [sections, setSections] = useState<ProjectSection[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [session, setSession] = useState<ProjectWorkSession | null>(null);
  const [entries, setEntries] = useState<ProjectWorkSessionEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [inputHeight, setInputHeight] = useState(MESSAGE_INPUT_MIN_HEIGHT);
  const [listening, setListening] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [saving, setSaving] = useState(false);
  const [responding, setResponding] = useState(false);
  const [startingNewChat, setStartingNewChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [tinaOpen, setTinaOpen] = useState(false);
  const requestId = useRef(0);
  const canSend = messageSendEnabled(draft, { isFinishing: startingNewChat, isResponding: responding, isRestoring: restoring, isSavingMessage: saving });
  const canStartNewChat = Boolean(session) && !responding && !saving && !restoring && !startingNewChat;

  useEffect(() => {
    let active = true;
    requestId.current += 1;
    assistantService.resetSession();
    Promise.resolve().then(() => {
      if (!active) throw new Error('cancelled');
      setRestoring(true);
      setError(null);
      setDraft('');
      setTinaOpen(false);
      return Promise.all([
        projectRepository.getProject(id),
        projectChatService.load(id),
        projectService.listSections(id),
      ]);
    }).then(
      ([value, chat, persistedSections]) => {
        if (!active) return;
        if (!value) { setError('Project was not found.'); return; }
        setProject(value);
        setSession(chat.session);
        setEntries(chat.entries.filter((entry) => entry.kind === 'user_message' || entry.kind === 'assistant_message'));
        setSections(persistedSections);
        setSelectedSectionId(
          persistedSections.find((section) => section.isDefault)?.id ??
          persistedSections.find((section) => section.status === 'active')?.id ?? null,
        );
      },
      () => active && setError('The Project could not be loaded.'),
    ).finally(() => active && setRestoring(false));
    return () => { active = false; requestId.current += 1; assistantService.cancelRequest(); };
  }, [id]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !session || !project || !canSend) return;
    setSaving(true);
    setError(null);
    let userEntry: ProjectWorkSessionEntry;
    try {
      userEntry = await projectChatService.append(session, 'user_message', content, entries.length);
      setEntries((current) => [...current, userEntry]);
      setDraft('');
      setInputHeight(MESSAGE_INPUT_MIN_HEIGHT);
      setListening(false);
    } catch {
      setError('Message was not saved. Your draft is still here.');
      setSaving(false);
      return;
    }
    setSaving(false);
    setResponding(true);
    const currentRequest = ++requestId.current;
    const transcript = [...entries, userEntry].slice(-50).map((entry) => ({ content: entry.content, role: entry.kind === 'user_message' ? 'user' as const : 'assistant' as const }));
    const result = await assistantService.respond(transcript, {
      projectId: project.id,
      projectName: project.name,
    });
    if (requestId.current !== currentRequest) return;
    if (result.status === 'success') {
      try {
        const assistantEntry = await projectChatService.append(session, 'assistant_message', result.message.content, entries.length + 1);
        setEntries((current) => [...current, assistantEntry]);
      } catch { setError('Tina replied, but the reply could not be saved.'); }
    } else if (result.status === 'error') setError(result.error.message);
    setResponding(false);
  };

  const startNewChat = async () => {
    if (!session || !project || !canStartNewChat) return;
    Keyboard.dismiss();
    setStartingNewChat(true);
    setError(null);
    assistantService.cancelRequest();
    const currentRequest = ++requestId.current;
    try {
      const freshSession = await projectChatService.startNewSession(session);
      if (requestId.current !== currentRequest) return;
      assistantService.resetSession();
      setSession(freshSession);
      setEntries([]);
      setDraft('');
      setInputHeight(MESSAGE_INPUT_MIN_HEIGHT);
      setListening(false);
    } catch {
      if (requestId.current === currentRequest) {
        setError('A new Project chat could not be started. Nothing was cleared.');
      }
    } finally {
      if (requestId.current === currentRequest) setStartingNewChat(false);
    }
  };

  const activeSections = sections.filter((section) => section.status === 'active');
  const selectedSection = activeSections.find(
    (section) => section.id === selectedSectionId,
  ) ?? activeSections.find((section) => section.isDefault) ?? null;

  const sectionsChanged = (nextSections: ProjectSection[]) => {
    setSections(nextSections);
    if (!nextSections.some(
      (section) => section.id === selectedSectionId && section.status === 'active',
    )) {
      setSelectedSectionId(
        nextSections.find((section) => section.isDefault)?.id ?? null,
      );
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, visibleViewport && styles.safeAreaWeb, visibleViewport && { height: visibleViewport.height, top: visibleViewport.top }]} testID="project-screen">
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior={KEYBOARD_AVOIDING_BEHAVIOR} keyboardVerticalOffset={0} style={styles.keyboardView} testID="project-keyboard-layout">
        <View style={styles.workspace}>
          <ScrollView contentContainerStyle={[styles.workspaceContent, tinaOpen && styles.workspaceContentWithTina]} showsVerticalScrollIndicator={false} testID="project-home-scroll">
            <View style={styles.topBar}>
              <Pressable accessibilityLabel="Back to Projects" onPress={() => router.replace('/projects' as Href)} style={styles.headerButton}><Text style={styles.back}>‹</Text></Pressable>
              <Text style={styles.projectsLabel}>Projects</Text>
              <Pressable accessibilityLabel="Project actions" disabled={!project} onPress={() => setActionsOpen(true)} style={styles.headerButton} testID="project-actions-button"><Text style={styles.more}>•••</Text></Pressable>
            </View>

            {restoring ? <Text style={styles.notice}>Opening Project…</Text> : project ? <>
              <View style={styles.identity} testID="project-identity">
                <View style={styles.coverFallback} testID="project-home-cover-fallback">
                  <View style={styles.coverGlow} />
                  <Text style={styles.coverInitial}>{projectFallbackInitial(project)}</Text>
                </View>
                <View style={styles.identityCopy}>
                  <Text style={styles.projectName}>{project.name}</Text>
                  <Text numberOfLines={2} style={styles.projectDescription}>{project.description ?? 'No description yet.'}</Text>
                </View>
              </View>

              <ProjectSectionNavigation onSelect={(section) => setSelectedSectionId(section.id)} sections={activeSections} selectedId={selectedSection?.id ?? ''} />
              {selectedSection?.isDefault ? (
                <>
                  <View style={styles.overview} testID="project-overview-section">
                    <Text style={styles.overviewLabel}>About this Project</Text>
                    <Text style={styles.overviewText}>{project.description ?? 'Add a short description to give this Project its purpose.'}</Text>
                    {project.goal ? <View style={styles.purpose}><Text style={styles.purposeLabel}>Purpose</Text><Text style={styles.purposeText}>{project.goal}</Text></View> : null}
                  </View>
                  <ProjectSectionAssets key={selectedSection.id} onError={setError} projectId={project.id} section={selectedSection} sections={activeSections} />
                </>
              ) : selectedSection ? (
                <View accessibilityLabel={`${selectedSection.title} section`} style={styles.customSectionSurface} testID="project-custom-section-surface">
                  <ProjectSectionAssets key={selectedSection.id} onError={setError} projectId={project.id} section={selectedSection} sections={activeSections} />
                </View>
              ) : null}
            </> : null}
          </ScrollView>

          {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}
          <View style={[styles.tinaPanel, tinaOpen && styles.tinaPanelOpen]} testID="project-tina-control">
            {tinaOpen ? <>
              <View style={styles.tinaHeader}>
                <View><Text style={styles.tinaTitle}>Tina</Text><Text style={styles.tinaScope}>Working in {project?.name ?? 'this Project'}</Text></View>
                <View style={styles.tinaHeaderActions}>
                  <Pressable accessibilityLabel="Start a new Project chat" accessibilityRole="button" disabled={!canStartNewChat} onPress={startNewChat} style={({ pressed }) => [styles.projectNewChatButton, pressed && canStartNewChat && styles.pressed]} testID="project-new-chat-button">
                    <Text style={[styles.projectNewChatText, !canStartNewChat && styles.projectNewChatTextDisabled]}>{startingNewChat ? 'Starting…' : 'New Chat'}</Text>
                  </Pressable>
                  <Pressable accessibilityLabel="Minimize Tina" onPress={() => { Keyboard.dismiss(); setTinaOpen(false); }} style={styles.minimizeButton}><Text style={styles.minimizeText}>⌄</Text></Pressable>
                </View>
              </View>
              <Transcript entries={entries} responding={responding} />
              <MessageComposer canSend={canSend} draft={draft} inputHeight={inputHeight} isBusy={saving || responding} isListening={listening} onChangeText={setDraft} onInputHeightChange={(height) => setInputHeight(messageInputHeight(height))} onSend={send} onToggleListening={() => { Keyboard.dismiss(); setListening((value) => !value); }} />
            </> : (
              <Pressable accessibilityRole="button" onPress={() => setTinaOpen(true)} style={({ pressed }) => [styles.askTina, pressed && styles.pressed]} testID="open-project-tina">
                <View style={styles.tinaMark}><Text style={styles.tinaMarkText}>✦</Text></View>
                <View style={styles.askCopy}><Text style={styles.askTitle}>Ask Tina</Text><Text style={styles.askScope}>This Project is already in context</Text></View>
                <Text style={styles.askArrow}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
        {project ? <>
          <ProjectActions key={`${project.id}:${project.updatedAt}`} onClose={() => setActionsOpen(false)} onManageSections={() => setSectionsOpen(true)} onUpdated={setProject} project={project} visible={actionsOpen} />
          <ProjectSectionsManager onChanged={sectionsChanged} onClose={() => setSectionsOpen(false)} projectId={project.id} sections={sections} visible={sectionsOpen} />
        </> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#050505', flex: 1 },
  safeAreaWeb: { left: 0, overflow: 'hidden', position: 'absolute', right: 0 },
  keyboardView: { flex: 1, position: 'relative' },
  workspace: { flex: 1, position: 'relative' },
  workspaceContent: { paddingBottom: 102 },
  workspaceContentWithTina: { paddingBottom: 460 },
  topBar: { alignItems: 'center', flexDirection: 'row', minHeight: 52, paddingHorizontal: 8 },
  headerButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  back: { color: '#E5E5E7', fontSize: 35, fontWeight: '200', lineHeight: 37 },
  projectsLabel: { color: '#77777D', flex: 1, fontSize: 13, fontWeight: '500' },
  more: { color: '#C8C8CC', fontSize: 16, letterSpacing: 1 },
  identity: { paddingBottom: 6 },
  coverFallback: { alignItems: 'center', backgroundColor: '#111720', height: 150, justifyContent: 'center', overflow: 'hidden', position: 'relative' },
  coverGlow: { backgroundColor: '#24324A', borderRadius: 160, height: 240, opacity: 0.46, position: 'absolute', right: -70, top: -120, width: 240 },
  coverInitial: { color: '#B2C3DF', fontSize: 48, fontWeight: '200', opacity: 0.9 },
  identityCopy: { paddingBottom: 22, paddingHorizontal: 20, paddingTop: 22 },
  projectName: { color: '#F5F5F7', fontSize: 30, fontWeight: '600', letterSpacing: -0.8, lineHeight: 35 },
  projectDescription: { color: '#929298', fontSize: 15, lineHeight: 21, marginTop: 8, maxWidth: 560 },
  overview: { borderTopColor: '#18181B', borderTopWidth: StyleSheet.hairlineWidth, marginHorizontal: 20, paddingBottom: 40, paddingTop: 28 },
  overviewLabel: { color: '#74747A', fontSize: 12, fontWeight: '600', letterSpacing: 0.2, textTransform: 'uppercase' },
  overviewText: { color: '#D5D5D8', fontSize: 16, lineHeight: 24, marginTop: 12, maxWidth: 620 },
  customSectionSurface: { minHeight: 300 },
  purpose: { borderLeftColor: '#343B49', borderLeftWidth: 2, marginTop: 26, paddingLeft: 15 },
  purposeLabel: { color: '#77777D', fontSize: 12, fontWeight: '600' },
  purposeText: { color: '#BCBCC1', fontSize: 15, lineHeight: 22, marginTop: 6 },
  tinaPanel: { backgroundColor: '#0C0C0E', borderColor: '#29292D', borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, bottom: 10, left: 12, overflow: 'hidden', position: 'absolute', right: 12 },
  tinaPanelOpen: { borderBottomLeftRadius: 18, borderBottomRightRadius: 18, height: '62%' },
  askTina: { alignItems: 'center', flexDirection: 'row', minHeight: 58, paddingHorizontal: 12 },
  tinaMark: { alignItems: 'center', backgroundColor: '#182131', borderRadius: 15, height: 34, justifyContent: 'center', width: 34 },
  tinaMarkText: { color: '#9DB9E6', fontSize: 16 },
  askCopy: { flex: 1, marginLeft: 11 },
  askTitle: { color: '#EDEDEF', fontSize: 14, fontWeight: '600' },
  askScope: { color: '#69696F', fontSize: 11, marginTop: 2 },
  askArrow: { color: '#77777D', fontSize: 18, marginRight: 5 },
  tinaHeader: { alignItems: 'center', borderBottomColor: '#242427', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 57, paddingHorizontal: 16 },
  tinaHeaderActions: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  tinaTitle: { color: '#F1F1F3', fontSize: 15, fontWeight: '600' },
  tinaScope: { color: '#68686E', fontSize: 11, marginTop: 2 },
  projectNewChatButton: { alignItems: 'center', minHeight: 36, justifyContent: 'center', paddingHorizontal: 9 },
  projectNewChatText: { color: '#A8B9D4', fontSize: 12, fontWeight: '600' },
  projectNewChatTextDisabled: { color: '#4F5055' },
  minimizeButton: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  minimizeText: { color: '#99999F', fontSize: 23 },
  transcript: { flex: 1 },
  transcriptContent: { flexGrow: 1, justifyContent: 'flex-end', paddingBottom: 12, paddingHorizontal: 14, paddingTop: 12 },
  tinaEmpty: { color: '#74747A', fontSize: 13, lineHeight: 19, marginBottom: 8, textAlign: 'center' },
  userMessage: { alignSelf: 'flex-end', backgroundColor: '#202023', borderRadius: 17, borderTopRightRadius: 6, marginBottom: 10, maxWidth: '84%', paddingHorizontal: 13, paddingVertical: 9 },
  assistantMessage: { alignSelf: 'flex-start', marginBottom: 13, maxWidth: '90%', paddingHorizontal: 2, paddingVertical: 2 },
  userText: { color: '#F7F7F8', fontSize: 15, lineHeight: 21 },
  assistantText: { color: '#E8E8EA', fontSize: 15, lineHeight: 22 },
  thinking: { alignItems: 'center', flexDirection: 'row', gap: 5, height: 24, paddingLeft: 3 },
  dot: { backgroundColor: '#8A8A90', borderRadius: 3, height: 5, width: 5 },
  error: { backgroundColor: '#0C0C0E', bottom: 76, color: '#E39A8E', fontSize: 12, left: 18, paddingVertical: 6, position: 'absolute', right: 18, textAlign: 'center' },
  notice: { color: '#77777D', fontSize: 13, padding: 40, textAlign: 'center' },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.68)', flex: 1, justifyContent: 'flex-end' },
  actionSheet: { backgroundColor: '#111113', borderColor: '#29292D', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingBottom: 24, paddingHorizontal: 16, paddingTop: 17 },
  sheetTitle: { color: '#F3F3F5', fontSize: 18, fontWeight: '600', marginBottom: 15 },
  sheetInput: { backgroundColor: '#1B1B1E', borderColor: '#343438', borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, color: '#F4F4F5', fontSize: 15, marginBottom: 11, minHeight: 47, paddingHorizontal: 13, paddingVertical: 11 },
  sheetDescription: { minHeight: 82, textAlignVertical: 'top' },
  primaryAction: { alignItems: 'center', backgroundColor: '#8AB4F8', borderRadius: 12, justifyContent: 'center', minHeight: 46 },
  primaryActionText: { color: '#08111F', fontSize: 15, fontWeight: '600' },
  actionRow: { borderBottomColor: '#29292D', borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 50 },
  actionText: { color: '#F1F1F3', fontSize: 16 },
  destructiveText: { color: '#E5988E', fontSize: 16 },
  cancelRow: { borderBottomWidth: 0, marginTop: 7 },
  cancelText: { color: '#98989E', fontSize: 16, textAlign: 'center' },
  pressed: { opacity: 0.58 },
});
