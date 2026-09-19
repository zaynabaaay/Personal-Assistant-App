import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Project home uses a neutral editorial cover field instead of an initial badge', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');
  const identity = screen.slice(screen.indexOf('testID="project-identity"'), screen.indexOf('<ProjectSectionNavigation'));

  assert.match(identity, /testID="project-home-cover-fallback"/);
  assert.match(identity, /styles\.coverPlane/);
  assert.match(identity, /styles\.coverRulePrimary/);
  assert.doesNotMatch(identity, /projectFallbackInitial|coverInitial|project\.name\.charAt/i);
  assert.match(screen, /coverFallback: \{[^}]*height: 112[^}]*marginHorizontal: 20/);
});

test('Project description appears once in the header and no-description Projects stay quiet', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');

  assert.match(screen, /project\.description \? <Text numberOfLines=\{3\} style=\{styles\.projectDescription\}>\{project\.description\}<\/Text> : null/);
  assert.equal((screen.match(/\{project\.description\}/g) ?? []).length, 1);
  assert.doesNotMatch(screen, /About this Project|Add a short description|No description yet/);
  assert.doesNotMatch(screen, /<Text[^>]*>Purpose<\/Text>/);
});

test('Overview uses only a persisted Project goal and never restores the file library', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');
  const start = screen.indexOf('{selectedSection?.isDefault ? (');
  const end = screen.indexOf(') : selectedSection ? (', start);
  const overview = screen.slice(start, end);

  assert.match(overview, /accessibilityLabel="Project Overview"/);
  assert.match(overview, /testID="project-overview-section"/);
  assert.match(screen, /const overviewAnchor = project\?\.goal\?\.trim\(\);/);
  assert.match(overview, /overviewAnchor \?/);
  assert.match(overview, /Current focus/);
  assert.match(overview, /\{overviewAnchor\}/);
  assert.doesNotMatch(overview, />Overview<\/Text>|ProjectSectionAssets|asset|file|source material/i);
  assert.doesNotMatch(overview, /task|progress|milestone|next step|where you left off/i);
});

test('Overview has an intentional no-content state without instructional copy', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');
  const start = screen.indexOf('{selectedSection?.isDefault ? (');
  const end = screen.indexOf(') : selectedSection ? (', start);
  const overview = screen.slice(start, end);

  assert.match(overview, /This space is intentionally open\./);
  assert.doesNotMatch(overview, /add|upload|start|create|description|purpose/i);
});

test('Overview keeps a centered readable measure across phone and iPad widths', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');

  assert.match(screen, /overview: \{[^}]*alignItems: 'center'[^}]*paddingHorizontal: 20[^}]*paddingTop: 28/);
  assert.match(screen, /overviewContent: \{[^}]*maxWidth: 640[^}]*width: '100%'/);
  assert.match(screen, /overviewText: \{[^}]*maxWidth: 560/);
  assert.match(screen, /overviewEmpty: \{[^}]*maxWidth: 360/);
});

test('multiple persisted sections remain horizontally usable and custom sections keep assets', async () => {
  const [screen, navigation] = await Promise.all([
    read('../src/features/projects/project-screen.tsx'),
    read('../src/features/projects/project-section-navigation.tsx'),
  ]);

  assert.match(navigation, /horizontal/);
  assert.match(navigation, /showsHorizontalScrollIndicator=\{false\}/);
  assert.match(navigation, /sections\.map/);
  assert.match(navigation, /content: \{ paddingHorizontal: 20 \}/);
  assert.match(screen, /sections=\{activeSections\}/);
  assert.match(screen, /testID="project-custom-section-surface"[\s\S]*<ProjectSectionAssets/);
});

test('Overview files leave the page but retain upload and original access through Project actions', async () => {
  const [screen, assets] = await Promise.all([
    read('../src/features/projects/project-screen.tsx'),
    read('../src/features/projects/project-section-assets.tsx'),
  ]);

  assert.match(screen, /testID="open-project-overview-files"/);
  assert.match(screen, /testID="project-overview-files-access"/);
  assert.match(screen, /function OverviewFiles[\s\S]*<ProjectSectionAssets/);
  assert.match(assets, /testID="add-project-asset"/);
  assert.match(assets, /testID="open-project-asset"/);
  assert.match(assets, /openProjectAssetOriginal/);
});

test('narrow iPhone layout keeps navigation scrollable and Ask Tina compact', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');

  assert.match(screen, /tinaPanel: \{[^}]*right: 12[^}]*width: 142/);
  assert.match(screen, /tinaPanelOpen: \{[^}]*left: 12[^}]*width: undefined/);
  assert.match(screen, /askTina: \{[^}]*minHeight: 48/);
  assert.doesNotMatch(screen, /This Project is already in context/);
});
