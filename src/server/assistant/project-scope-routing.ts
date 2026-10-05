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

const ASSET_NOUN =
  /\b(?:documents?|images?|pdfs?|photos?|presentations?|spreadsheets?)\b/;
const STRONG_ASSET_REFERENCE =
  /\b(?:assets?|files?|uploads?)\b|\buploaded (?:documents?|images?|pdfs?|photos?|presentations?|spreadsheets?)\b|\b(?:dsc|img|pxl)[_-]?\d+\b|\b[a-z0-9][a-z0-9_-]*\.(?:docx?|gif|heic|heif|jpe?g|pdf|png|pptx?|rtf|txt|webp|xlsx?)\b/;
const WHERE_LOCATION = /\bwhere(?:'s|’s| (?:is|are|was|were)| (?:can|could) (?:i|we) find)\b/;
const WHERE_PLACED = /\bwhere did (?:i|we) (?:add|put|save|upload|place)\b/;
const SECTION_MEMBERSHIP =
  /\b(?:what|which) (?:project )?sections?\b(?!\s+of\b).*\b(?:contains?|has|holds?|includes?|is|are|was|were)\b/;

function asksForAssetLocation(message: string) {
  const hasStrongReference = STRONG_ASSET_REFERENCE.test(message);
  const hasAssetNoun = ASSET_NOUN.test(message);
  if (!hasStrongReference && !hasAssetNoun) return false;
  if (WHERE_PLACED.test(message)) return true;
  if (hasStrongReference && WHERE_LOCATION.test(message)) return true;
  if (SECTION_MEMBERSHIP.test(message)) return true;
  if (/\b(?:surfaced|placed|attached) in (?:a |the |what |which )?sections?\b/.test(message)) {
    return true;
  }
  if (hasStrongReference && /^(?:is|are|was|were)\b.*\bin\b/.test(message)) return true;
  const containment = message.match(/\b(?:contain|contains|has|have|include|includes|hold|holds)\b/);
  if (hasStrongReference && containment) {
    return STRONG_ASSET_REFERENCE.test(message.slice((containment.index ?? 0) + containment[0].length));
  }
  return hasAssetNoun && WHERE_LOCATION.test(message) &&
    /\b(?:project|sections?)\b/.test(message);
}

export function routeScopedProjectRequest(
  request: AssistantApiRequest,
): ScopedProjectRoute | null {
  if (!request.projectScope) return null;
  const message = normalized(latestUserMessage(request));
  if (!message || BROADER_SCOPE.some((pattern) => pattern.test(message))) return null;

  if (asksForAssetLocation(message)) {
    return { focus: 'knowledge', mode: 'project_default' };
  }
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
