import type {
  AssistantApiRequest,
  AssistantProjectContextFocus,
} from '../../contracts/assistant';

export type ScopedProjectRoute = {
  focus: AssistantProjectContextFocus;
  mode: 'project_default';
};

function latestUserMessage(request: AssistantApiRequest) {
  return [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function normalized(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');
}

const BROADER_SCOPE = [
  /\b(?:all|any|another|other) projects?\b/,
  /\bacross (?:all|my) projects?\b/,
  /\b(?:overall|everything|in general|globally)\b/,
  /\boutside (?:this|the|our) project\b/,
  /\bwhat (?:else|all) do i have going on\b/,
];

export function routeScopedProjectRequest(
  request: AssistantApiRequest,
): ScopedProjectRoute | null {
  if (!request.projectScope) return null;
  const message = normalized(latestUserMessage(request));
  if (!message || BROADER_SCOPE.some((pattern) => pattern.test(message))) return null;

  if (/\bwhat (?:have we|did we|have i|did i) decid(?:e|ed)\b|\bwhat are (?:our|the) decisions?\b/.test(message)) {
    return { focus: 'knowledge', mode: 'project_default' };
  }
  if (/\bwhat should (?:i|we) do next\b|\bwhat(?:'s| is) next\b|\bnext (?:step|task|thing)\b/.test(message)) {
    return { focus: 'work', mode: 'project_default' };
  }
  if (/\bwhat was i thinking about for (?:this|it)\b|\bwhat (?:did we|have we) (?:discuss|discussed) (?:for|about) (?:this|it)\b/.test(message)) {
    return { focus: 'history', mode: 'project_default' };
  }
  if (/\bwhat (?:are|were) (?:we|i) working on\b|\bwhere are we at\b|\bwhere (?:is|are) (?:this|the project|our work)\b|\bhow is (?:this|the project) going\b/.test(message)) {
    return { focus: 'comprehensive', mode: 'project_default' };
  }
  return null;
}

export const PROJECT_DEFAULT_DISABLED_TOOLS = [
  'list_projects',
  'search_completed_conversations',
  'search_general_memory',
] as const;
