import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/repository-integrity.yml';
const checkout = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
const setupNode = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const actionComments = new Map([[checkout, 'v4.2.2'], [setupNode, 'v4.4.0']]);
const governance = [
  'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'NOTICE',
  'docs/decisions/0001-incubator-repository.md', 'docs/release.md', 'docs/roadmap.md',
  'docs/github-admin-handoff.md', '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_proposal.yml',
  '.github/ISSUE_TEMPLATE/config.yml'
];

function stepBlocks(text) {
  const starts = [...text.matchAll(/^      - uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/gm)];
  return starts.map((match, index) => {
    const end = starts[index + 1]?.index ?? text.length;
    return { action: match[1], comment: match[2] ?? null, text: text.slice(match.index, end) };
  });
}
function topLevelPermissions(text) {
  const lines = text.split('\n');
  const index = lines.findIndex(line => /^permissions:\s*$/.test(line));
  if (index < 0) return null;
  const values = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (/^  [^ \t]/.test(line)) values.push(line.trim());
    else if (line.trim() !== '') break;
  }
  return values;
}
function workflowFiles(root) {
  const directory = path.join(root, '.github/workflows');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(file => /\.ya?ml$/i.test(file)).sort();
}
export function validateWorkflow(root = rootDefault) {
  const files = workflowFiles(root);
  if (!files.includes('repository-integrity.yml')) throw new Error('workflow: missing repository-integrity.yml');
  if (files.length !== 1) throw new Error('workflow: unexpected workflow file');
  for (const required of governance) if (!fs.existsSync(path.join(root, required))) throw new Error(`workflow: missing governance ${required}`);
  const text = fs.readFileSync(path.join(root, workflowPath), 'utf8');
  if (!/^on:\s*$/m.test(text) || !/^  pull_request:\s*$/m.test(text) || !/^  push:\s*\n    branches:\s*\[?main\]?\s*$/m.test(text) || !/^  workflow_dispatch:\s*$/m.test(text)) throw new Error('workflow: required triggers');
  if (/pull_request_target/.test(text)) throw new Error('workflow: pull_request_target');
  const permissions = topLevelPermissions(text);
  if (!permissions || permissions.length !== 1 || permissions[0] !== 'contents: read') throw new Error('workflow: permissions');
  if (!/^  repository-integrity:\s*$/m.test(text) || !/^    name:\s*Repository integrity\s*$/m.test(text)) throw new Error('workflow: stable job');
  if (!/^    runs-on:\s*ubuntu-latest\s*$/m.test(text)) throw new Error('workflow: runner');
  const blocks = stepBlocks(text);
  const checkoutBlocks = blocks.filter(block => block.action === checkout);
  const setupBlocks = blocks.filter(block => block.action === setupNode);
  if (blocks.length !== 2 || blocks.some(block => ![checkout, setupNode].includes(block.action)) || blocks.some(block => actionComments.get(block.action) !== block.comment)) throw new Error('workflow: actions must be official pinned actions with release comments');
  if (checkoutBlocks.length !== 1 || !/^        with:\s*\n(?:^          [^\n]*\n?)*?^          persist-credentials:\s*false\s*$/m.test(checkoutBlocks[0].text) || /persist-credentials:\s+(?!false\b)/.test(checkoutBlocks[0].text)) throw new Error('workflow: checkout credentials');
  if (setupBlocks.length !== 1 || !/^        with:\s*\n(?:^          [^\n]*\n?)*?^          node-version:\s*22\.19\.0\s*$/m.test(setupBlocks[0].text) || /\b(?:cache|registry-url|scope|always-auth|token)\s*:/.test(setupBlocks[0].text)) throw new Error('workflow: setup-node configuration');
  if (!/^concurrency:\s*\n\s+group:\s*repository-integrity-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\s*\n\s+cancel-in-progress:\s*true\s*$/m.test(text)) throw new Error('workflow: concurrency');
  const runs = [...text.matchAll(/^\s+- run:\s*(.*)$/gm)].map(match => match[1].trim());
  const clean = 'test -z "$(git status --porcelain=v1 --untracked-files=all)"';
  if (!runs.includes('npm run check') || !runs.includes(clean) || runs.some(run => !['npm run check', clean].includes(run))) throw new Error('workflow: run policy');
  if (/secrets\.|npm\s+(?:install|test|publish|pack)|curl[^|\n]*\|\s*(?:sh|bash)/i.test(text)) throw new Error('workflow: prohibited command');
  return true;
}
if (import.meta.url === `file://${process.argv[1]}`) { try { validateWorkflow(process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : rootDefault); console.log('workflow: ok'); } catch (error) { console.error(error.message); process.exitCode = 1; } }
