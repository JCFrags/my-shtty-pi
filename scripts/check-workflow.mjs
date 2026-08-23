import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/repository-integrity.yml';
const chronoWorkflowPath = '.github/workflows/chrono-compact.yml';
const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNode = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const actionComments = new Map([[checkout, 'v7.0.1'], [setupNode, 'v7.0.0']]);
const governance = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'NOTICE', 'docs/decisions/0001-incubator-repository.md', 'docs/release.md', 'docs/roadmap.md', 'docs/github-admin-handoff.md', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_proposal.yml', '.github/ISSUE_TEMPLATE/config.yml'];
function stepBlocks(text) { const starts = [...text.matchAll(/^      - uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/gm)]; return starts.map((match, index) => ({ action: match[1], comment: match[2] ?? null, text: text.slice(match.index, starts[index + 1]?.index ?? text.length) })); }
function topLevelPermissions(text) { const lines = text.split('\n'); const index = lines.findIndex(line => /^permissions:\s*$/.test(line)); if (index < 0) return null; const values = []; for (let i = index + 1; i < lines.length; i += 1) { if (/^  [^ \t]/.test(lines[i])) values.push(lines[i].trim()); else if (lines[i].trim()) break; } return values; }
function workflowFiles(root) { const directory = path.join(root, '.github/workflows'); return fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => /\.ya?ml$/i.test(file)).sort() : []; }
function validateChronoWorkflow(root) {
  const text = fs.readFileSync(path.join(root, chronoWorkflowPath), 'utf8');
  if (!/^on:\s*$/m.test(text) || !/^  pull_request:\s*$/m.test(text) || !/^  push:\s*\n    branches:\s*\n      - main\s*$/m.test(text)) throw new Error('workflow: ChronoCompact required triggers');
  if (/pull_request_target|workflow_dispatch/.test(text)) throw new Error('workflow: ChronoCompact unsafe trigger');
  const permissions = topLevelPermissions(text); if (!permissions || permissions.length !== 1 || permissions[0] !== 'contents: read') throw new Error('workflow: ChronoCompact permissions');
  for (const required of ['packages/chrono-compact/**', 'docs/package-catalog.json', 'docs/package-status.md', 'docs/roadmap.md', 'CHANGELOG.md', '.github/workflows/chrono-compact.yml']) if (!text.includes(`- "${required}"`)) throw new Error(`workflow: ChronoCompact missing path ${required}`);
  if (!/^    runs-on:\s*ubuntu-latest\s*$/m.test(text) || !/^    timeout-minutes:\s*20\s*$/m.test(text) || !/^        working-directory:\s*packages\/chrono-compact\s*$/m.test(text)) throw new Error('workflow: ChronoCompact job boundary');
  const blocks = stepBlocks(text); const actionNames = [checkout, setupNode];
  if (blocks.length !== 2 || blocks.some(block => !actionNames.includes(block.action)) || blocks.some(block => actionComments.get(block.action) !== block.comment) || new Set(blocks.map(block => block.action)).size !== 2) throw new Error('workflow: ChronoCompact actions must be official pinned actions with release comments');
  const cb = blocks.find(block => block.action === checkout); const sb = blocks.find(block => block.action === setupNode);
  if (!cb.text.includes('persist-credentials: false')) throw new Error('workflow: ChronoCompact checkout credentials');
  for (const value of ['node-version-file: .node-version', 'cache: npm', 'cache-dependency-path: packages/chrono-compact/package-lock.json']) if (!sb.text.includes(value)) throw new Error(`workflow: ChronoCompact setup ${value}`);
  const runs = [...text.matchAll(/^\s+- run:\s*(.*)$/gm)].map(match => match[1].trim());
  if (JSON.stringify(runs) !== JSON.stringify(['npm ci --no-audit --no-fund', 'npm test', 'npm run pack:check'])) throw new Error('workflow: ChronoCompact exact run order');
  if (/secrets\.|npm\s+(?:install|publish)|(?:^|\s)(?:curl|wget)[^|\n]*\|\s*(?:sh|bash)|\b(?:deploy|upload)\b/i.test(text)) throw new Error('workflow: ChronoCompact prohibited command');
}
export function validateWorkflow(root = rootDefault) {
  const files = workflowFiles(root); if (files.length < 1 || files.length > 2 || files[0] !== 'chrono-compact.yml' && files[0] !== 'repository-integrity.yml' || !files.includes('repository-integrity.yml') || files.some(file => !['chrono-compact.yml', 'repository-integrity.yml'].includes(file))) throw new Error('workflow: exact workflow file set');
  for (const required of governance) if (!fs.existsSync(path.join(root, required))) throw new Error(`workflow: missing governance ${required}`);
  const text = fs.readFileSync(path.join(root, workflowPath), 'utf8');
  if (!/^on:\s*$/m.test(text) || !/^  pull_request:\s*$/m.test(text) || !/^  push:\s*\n    branches:\s*\[main\]\s*$/m.test(text) || !/^  workflow_dispatch:\s*$/m.test(text)) throw new Error('workflow: required triggers');
  if (/pull_request_target/.test(text)) throw new Error('workflow: pull_request_target');
  const permissions = topLevelPermissions(text); if (!permissions || permissions.length !== 1 || permissions[0] !== 'contents: read') throw new Error('workflow: permissions');
  if (!/^  repository-integrity:\s*$/m.test(text) || !/^    name:\s*Repository integrity\s*$/m.test(text) || !/^    runs-on:\s*ubuntu-latest\s*$/m.test(text) || !/^    timeout-minutes:\s*10\s*$/m.test(text)) throw new Error('workflow: stable job boundary');
  const blocks = stepBlocks(text); const actionNames = [checkout, setupNode];
  if (blocks.length !== 2 || blocks.some(block => !actionNames.includes(block.action)) || blocks.some(block => actionComments.get(block.action) !== block.comment) || new Set(blocks.map(block => block.action)).size !== 2) throw new Error('workflow: actions must be official pinned actions with release comments');
  const cb = blocks.find(block => block.action === checkout); const sb = blocks.find(block => block.action === setupNode);
  const checkoutLines = cb.text.split('\n').filter(line => line.trim()); if (checkoutLines.length !== 3 || checkoutLines[1] !== '        with:' || checkoutLines[2] !== '          persist-credentials: false') throw new Error('workflow: exact checkout configuration');
  const setupWith = sb.text.match(/^        with:\s*\n([\s\S]*?)(?=^      - )/m)?.[1] ?? ''; const setupLines = setupWith.split('\n').filter(line => line.trim()); if (setupLines.length !== 2 || !/^          node-version:\s*22\.19\.0\s*$/.test(setupLines[0]) || !/^          package-manager-cache:\s*false\s*$/.test(setupLines[1])) throw new Error('workflow: setup-node configuration');
  if (!/^concurrency:\s*\n\s+group:\s*repository-integrity-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\s*\n\s+cancel-in-progress:\s*true\s*$/m.test(text)) throw new Error('workflow: concurrency');
  const runs = [...text.matchAll(/^\s+- run:\s*(.*)$/gm)].map(match => match[1].trim());
  const assertion = 'test "$(node --version)" = "v22.19.0" && test "$(npm --version)" = "10.9.3"'; const clean = 'test -z "$(git status --porcelain=v1 --untracked-files=all)"';
  if (JSON.stringify(runs) !== JSON.stringify([assertion, 'npm run check', clean])) throw new Error('workflow: exact run order');
  if (/secrets\.|npm\s+(?:install|ci|test|publish|pack)|(?:^|\s)(?:curl|wget)[^|\n]*\|\s*(?:sh|bash)|\b(?:deploy|upload)\b/i.test(text)) throw new Error('workflow: prohibited command');
  if (files.includes('chrono-compact.yml')) validateChronoWorkflow(root);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { try { validateWorkflow(process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : rootDefault); console.log('workflow: ok'); } catch (error) { console.error(error.message); process.exitCode = 1; } }
