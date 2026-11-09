import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync,
  renameSync, copyFileSync, rmSync, statSync,
} from 'node:fs';
import { join, relative, resolve, isAbsolute, sep, dirname } from 'node:path';
import { applyDelta, deltaTemplate, parseSpec, renderSpec } from './specs.js';
import { locales } from './i18n.js';
import { verifySnapshot } from './importer.js';
import { createNarrativeMap, evaluateNarrative, narrativeAfter } from './narrative.js';
import { loadSchema, customArtifacts, schemaPath } from './schema.js';

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const types = new Set(['chapter', 'revision', 'world', 'character', 'plot']);
const profiles = new Set(['generic', 'novel', 'light-novel']);
const claimTypes = new Set(['fact', 'knowledge', 'clue', 'event']);
const reviewPasses = ['dramaturgy', 'continuity', 'prose'];
const claimStatuses = new Set(['CANON', 'PLANNED', 'DRAFT', 'OPEN', 'DEPRECATED']);
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const timestamp = () => new Date().toISOString();

function ensureId(value, label = 'ID') {
  if (!idPattern.test(value || '')) throw new Error(label + ' must use lowercase letters, digits, and hyphens.');
}
function changeDir(root, id) { ensureId(id); return join(root, 'changes', id); }
function pathInside(cwd, ref, mustExist = true) {
  if (!ref || isAbsolute(ref) || ref.includes('\\') || /(^|\/)\.\.?($|\/)/.test(ref)) throw new Error('Invalid project path: ' + ref);
  const path = resolve(cwd, ref);
  if (mustExist && !existsSync(path)) throw new Error('Reference not found: ' + ref);
  let ancestor = mustExist ? path : dirname(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const relativePath = relative(realpathSync(cwd), realpathSync(ancestor));
  if (relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) throw new Error('Path escapes project: ' + ref);
  return path;
}
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in controlled files: ' + path);
    return entry.isDirectory() ? listFiles(path) : [path];
  }).sort();
}
function fileHash(path) { return existsSync(path) ? hash(readFileSync(path)) : null; }
function artifactHashes(cwd, dir) {
  const paths = [join(dir, 'tasks.md'), ...planFiles(dir), ...listFiles(join(dir, 'extras')), ...listFiles(join(dir, 'reviews')),
    ...listFiles(join(dir, 'evidence')),
    ...(existsSync(join(dir, 'narrative-map.json')) ? [join(dir, 'narrative-map.json')] : []),
    ...(existsSync(join(dir, 'verification.json')) ? [join(dir, 'verification.json')] : []),
    ...(existsSync(join(dir, 'draft.md')) ? [join(dir, 'draft.md')] : []),
    ...listFiles(join(dir, 'decisions'))];
  return Object.fromEntries([...new Set(paths)].sort().map(path => [relative(cwd, path), fileHash(path)]));
}
function canonical(path, value) {
  const temporary = path + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, path);
}
function requiredText(path, headings) {
  const body = read(path);
  for (const heading of headings) {
    const start = body.indexOf('## ' + heading + '\n');
    const section = start < 0 ? '' : body.slice(start + heading.length + 4).split('\n## ')[0].trim();
    if (!section || ['<fill in>', '<preencher>'].includes(section)) {
      throw new Error(relative(dirname(path), path) + ' requires ' + heading);
    }
  }
}
function requiredCustom(path, item) {
  if (!existsSync(path) || !read(path).trim() || read(path).includes('<fill in>') || read(path).includes('<preencher>')) throw new Error('Custom artifact incomplete: ' + path);
  requiredText(path, item.requiredHeadings || []);
}

export function setupWorkflow(root, profile = 'generic') {
  if (!profiles.has(profile)) throw new Error('Unknown profile: ' + profile);
  for (const dir of ['specs', 'decisions', 'changes/archive']) mkdirSync(join(root, dir), { recursive: true });
  save(join(root, 'state.json'), { formatVersion: 4, revision: 0, files: {}, lastChange: null });
}
export function upgradeWorkflow(root, config, dryRun = false) {
  if (config.formatVersion === 4) return { action: 'unchanged', from: 4, to: 4 };
  if (![1, 2, 3].includes(config.formatVersion)) throw new Error('Unsupported format version.');
  if (dryRun) return { action: 'would-migrate', from: config.formatVersion, to: 4 };
  const archive = join(root, 'archive', 'migrations');
  mkdirSync(archive, { recursive: true });
  const backup = join(archive, 'config-v' + config.formatVersion + '-' + Date.now() + '.json');
  copyFileSync(join(root, 'config.json'), backup);
  for (const dir of ['specs', 'decisions', 'changes/archive', 'claims/fact', 'claims/knowledge', 'claims/clue', 'claims/event', 'sources']) mkdirSync(join(root, dir), { recursive: true });
  canonical(join(root, 'config.json'), { ...config, formatVersion: 4, profile: config.profile || 'generic', requiresBaseline: true });
  return { action: 'migrated', from: config.formatVersion, to: 4, backup };
}
export function createChange({ root, id, type, language, profile, chapterContract }) {
  ensureId(id);
  if (!types.has(type)) throw new Error('Unknown change type: ' + type);
  const schema = loadSchema(root, profile);
  const dir = changeDir(root, id);
  if (existsSync(dir)) throw new Error('Change already exists: ' + id);
  const older = join(root, 'changes', 'archive');
  if (existsSync(older) && readdirSync(older, { withFileTypes: true }).some(entry => entry.isDirectory() && entry.name.endsWith('-' + id) && existsSync(join(older, entry.name, 'change.json')) && json(join(older, entry.name, 'change.json')).id === id)) {
    throw new Error('Change ID already exists in the archive: ' + id);
  }
  mkdirSync(join(dir, 'specs'), { recursive: true });
  mkdirSync(join(dir, 'claims'), { recursive: true });
  mkdirSync(join(dir, 'reviews'), { recursive: true });
  save(join(dir, 'change.json'), { formatVersion: 4, workflowVersion: 3, id, type, profile, language });
  createNarrativeMap(dir);
  save(join(dir, 'claims.json'), { operations: [] });
  const marker = locales[language].placeholder;
  const pt = language === 'pt-BR';
  writeFileSync(join(dir, 'proposal.md'), '# ' + (pt ? 'Proposta' : 'Proposal') + ': ' + id +
    '\n\n## ' + (pt ? 'Intenção' : 'Intent') + '\n\n' + marker +
    '\n\n## ' + (pt ? 'Escopo' : 'Scope') + '\n\n' + marker +
    '\n\n## ' + (pt ? 'Fontes' : 'Sources') + '\n\n');
  let design = '# ' + (pt ? 'Plano narrativo' : 'Narrative design') + ': ' + id +
    '\n\n## ' + (pt ? 'Abordagem' : 'Approach') + '\n\n' + marker +
    '\n\n## ' + (pt ? 'Fontes' : 'Sources') + '\n\n';
  if (profile === 'novel' || profile === 'light-novel') design += '\n## ' + (pt ? 'Ritmo do volume (opcional)' : 'Volume pacing (optional)') + '\n\n';
  if (profile === 'light-novel') design += '\n## ' + (pt ? 'Momentos visuais (opcional)' : 'Visual beats (optional)') +
    '\n\n## ' + (pt ? 'Ilustrações possíveis (opcional)' : 'Possible illustrations (optional)') + '\n\n';
  writeFileSync(join(dir, 'design.md'), design);
  writeFileSync(join(dir, 'tasks.md'), locales[language].workflowTasks[type]);
  if (type === 'chapter' || type === 'revision') {
    writeFileSync(join(dir, 'draft.md'), '# ' + (pt ? 'Rascunho' : 'Draft') + ': ' + id + '\n\n');
  }
  if (type === 'chapter') {
    mkdirSync(join(dir, 'scenes'));
    writeFileSync(join(dir, 'chapter-contract.md'), chapterContract);
  }
  for (const item of [...customArtifacts(schema, type, 'plan'), ...customArtifacts(schema, type, 'final')]) {
    const target = join(dir, item.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.template);
  }
  return dir;
}
export function createDelta(root, id, domain) {
  ensureId(domain, 'Domain');
  const { dir } = activeChange(root, id);
  const target = join(dir, 'specs', domain, 'spec.md');
  if (existsSync(target)) throw new Error('Delta already exists: ' + domain);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, deltaTemplate(domain));
  return target;
}
export function createClaimDelta(root, id, type, claimId, operation, subject = 'world', epistemic = null, language = 'en') {
  ensureId(claimId);
  if (!claimTypes.has(type) || !['ADDED', 'MODIFIED', 'REMOVED'].includes(operation)) throw new Error('Invalid claim delta.');
  const { dir } = activeChange(root, id), manifestPath = join(dir, 'claims.json');
  const manifest = json(manifestPath);
  if (manifest.operations.some(item => item.type === type && item.id === claimId)) throw new Error('Claim already staged.');
  const current = join(root, 'claims', type, claimId + '.md');
  if (operation === 'ADDED' && existsSync(current)) throw new Error('Claim already exists.');
  if (operation !== 'ADDED' && !existsSync(current)) throw new Error('Claim does not exist.');
  const staged = join(dir, 'claims', type, claimId + '.md');
  if (operation !== 'REMOVED') {
    mkdirSync(dirname(staged), { recursive: true });
    if (operation === 'MODIFIED') copyFileSync(current, staged);
    else writeFileSync(staged, '---\nstoryspec: 3\nid: ' + claimId + '\nkind: claim\nclaimType: ' + type +
      '\nstatus: DRAFT\nsubject: ' + subject + (epistemic ? '\nepistemic: ' + epistemic : '') +
      '\nlanguage: ' + language + '\n---\n\n## ' + locales[language].headings.statement + '\n\n' + locales[language].placeholder +
      (type === 'event' ? '\n\n## ' + locales[language].headings.moment + '\n\n' + locales[language].placeholder : '') +
      '\n\n## ' + locales[language].headings.sources + '\n\n- ' + locales[language].placeholder + '\n');
  }
  manifest.operations.push({ operation, type, id: claimId });
  canonical(manifestPath, manifest);
  return operation === 'REMOVED' ? manifestPath : staged;
}
function changeInfo(root, id) {
  const dir = changeDir(root, id), path = join(dir, 'change.json');
  if (!existsSync(path)) throw new Error('Workflow change not found: ' + id);
  const info = json(path);
  if (info.formatVersion !== 4 || (info.workflowVersion !== undefined && ![2, 3].includes(info.workflowVersion)) || info.id !== id || !types.has(info.type) || !profiles.has(info.profile)) throw new Error('Invalid change metadata.');
  return { dir, info };
}
function activeChange(root, id) {
  const result = changeInfo(root, id);
  if (existsSync(join(result.dir, 'archive.json'))) throw new Error('Change is archived: ' + id);
  if (existsSync(join(result.dir, 'applied.json'))) throw new Error('Change is already applied: ' + id);
  return result;
}
function planFiles(dir) {
  const info = json(join(dir, 'change.json'));
  const extras = info.workflowVersion === 3 ? customArtifacts(loadSchema(dirname(dirname(dir)), info.profile), info.type, 'plan').map(item => join(dir, item.path)) : [];
  return [join(dir, 'change.json'), join(dir, 'proposal.md'), join(dir, 'design.md'), join(dir, 'claims.json'), ...extras,
    ...listFiles(join(dir, 'specs')), ...listFiles(join(dir, 'claims')),
    ...(existsSync(join(dir, 'chapter-contract.md')) ? [join(dir, 'chapter-contract.md')] : []),
    ...listFiles(join(dir, 'scenes'))];
}
export function planHash(cwd, root, id) {
  return planInputs(cwd, root, id).hash;
}
function currentSpec(root, domain) {
  const path = join(root, 'specs', domain, 'spec.md');
  return { path, items: existsSync(path) ? parseSpec(read(path), domain) : [] };
}
function validateSpecRefs(cwd, root, item, stagedClaims = new Set()) {
  for (const source of item.sources) {
    if (!/^(storyspec|manuscript)\/.+\.md$/.test(source)) throw new Error('Invalid source reference: ' + source);
    verifySnapshot({ cwd, root, path: pathInside(cwd, source) });
  }
  for (const claim of item.claims) {
    if (!/^storyspec\/claims\/(fact|knowledge|clue|event)\/[a-z0-9-]+\.md$/.test(claim)) throw new Error('Claim reference must point to storyspec/claims/: ' + claim);
    if (!stagedClaims.has(claim)) pathInside(cwd, claim);
  }
}
function validateStagedClaim(cwd, root, path, type, id) {
  const body = read(path);
  const header = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (!header) throw new Error('Staged claim needs metadata: ' + path);
  const meta = Object.fromEntries(header[1].split('\n').map(line => /^([A-Za-z]+):\s*(.*)$/.exec(line)).filter(Boolean).map(m => [m[1], m[2]]));
  if (meta.id !== id || meta.kind !== 'claim' || meta.claimType !== type || !claimStatuses.has(meta.status)) throw new Error('Invalid staged claim metadata: ' + path);
  if (body.includes('<fill in>') || body.includes('<preencher>')) throw new Error('Staged claim contains placeholders: ' + path);
  if (!/^## (Statement|Enunciado)\n\n\S/m.test(body)) throw new Error('Staged claim needs a statement: ' + path);
  if (meta.status !== 'CANON') throw new Error('Applied claim must have CANON status: ' + path);
  if (!/^## (Sources|Fontes)\n\n- (?!<fill in>|<preencher>)\S/m.test(body)) throw new Error('CANON claim needs a source: ' + path);
  const subject = meta.subject;
  if (!idPattern.test(subject || '')) throw new Error('Invalid claim subject: ' + path);
  if (type === 'knowledge' && !['KNOWS', 'SUSPECTS', 'BELIEVES', 'UNAWARE'].includes(meta.epistemic)) throw new Error('Invalid epistemic state: ' + path);
  if (type === 'knowledge' && !existsSync(join(root, 'characters', subject + '.md'))) throw new Error('Knowledge subject not found: ' + subject);
  if (type === 'clue' && !existsSync(join(root, 'mysteries', subject + '.md'))) throw new Error('Clue subject not found: ' + subject);
  if (type === 'event' && !/^## (When|Momento)\n\n\S/m.test(body)) throw new Error('Event claim needs a moment: ' + path);
  const sources = body.split(/## (?:Sources|Fontes)\n/)[1]?.split('\n## ')[0] || '';
  for (const source of sources.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim())) {
    if (!/^(storyspec|manuscript)\/.+\.md$/.test(source)) throw new Error('Invalid claim source: ' + source);
    verifySnapshot({ cwd, root, path: pathInside(cwd, source) });
  }
}
export function preview(cwd, root, id) {
  const { dir, info } = changeInfo(root, id), operations = [];
  const manifest = json(join(dir, 'claims.json'));
  if (!Array.isArray(manifest.operations)) throw new Error('Invalid claims manifest.');
  const stagedClaims = new Set(manifest.operations.filter(item => item.operation !== 'REMOVED').map(item => 'storyspec/claims/' + item.type + '/' + item.id + '.md'));
  const deltas = listFiles(join(dir, 'specs')).filter(path => path.endsWith('/spec.md'));
  if (!deltas.length) throw new Error('Change needs at least one spec delta.');
  for (const deltaPath of deltas) {
    const domain = deltaPath.split(sep).at(-2);
    ensureId(domain, 'Domain');
    const delta = parseSpec(read(deltaPath), domain, true);
    for (const item of [...delta.ADDED, ...delta.MODIFIED]) validateSpecRefs(cwd, root, item, stagedClaims);
    const current = currentSpec(root, domain);
    const after = renderSpec(domain, applyDelta(current.items, delta, id));
    operations.push({ target: current.path, before: fileHash(current.path), after, afterHash: hash(after), kind: 'spec' });
  }
  const seen = new Set();
  for (const item of manifest.operations) {
    if (!claimTypes.has(item.type) || !idPattern.test(item.id || '') || !['ADDED', 'MODIFIED', 'REMOVED'].includes(item.operation)) throw new Error('Invalid claim operation.');
    const key = item.type + '/' + item.id;
    if (seen.has(key)) throw new Error('Duplicate claim operation: ' + key);
    seen.add(key);
    const target = join(root, 'claims', item.type, item.id + '.md');
    const before = fileHash(target);
    if (item.operation === 'ADDED' && before !== null) throw new Error('Claim already exists: ' + key);
    if (item.operation !== 'ADDED' && before === null) throw new Error('Claim missing: ' + key);
    const staged = join(dir, 'claims', item.type, item.id + '.md');
    let after = item.operation === 'REMOVED' ? null : read(staged);
    if (after !== null) {
      validateStagedClaim(cwd, root, staged, item.type, item.id);
      after = after.replace(/^originChange:.*\n/m, '').replace('\n---\n', '\noriginChange: ' + id + '\n---\n');
    }
    operations.push({ target, before, after, afterHash: after === null ? null : hash(after), kind: 'claim' });
  }
  const removedClaims = new Set(manifest.operations.filter(item => item.operation === 'REMOVED').map(item =>
    'storyspec/claims/' + item.type + '/' + item.id + '.md'));
  if (removedClaims.size) {
    const changed = new Map(operations.filter(op => op.kind === 'spec').map(op => [op.target, op.after]));
    for (const path of listFiles(join(root, 'specs')).filter(path => path.endsWith('/spec.md'))) {
      if (!changed.has(path)) changed.set(path, read(path));
    }
    for (const [path, body] of changed) {
      const domain = path.split(sep).at(-2);
      for (const item of parseSpec(body, domain)) for (const ref of item.claims) {
        if (removedClaims.has(ref)) throw new Error('REMOVED claim is still referenced by ' + domain + '/' + item.id + ': ' + ref);
      }
    }
  }
  if (info.workflowVersion >= 2) {
    const target = join(root, 'narrative-state.json'), after = narrativeAfter(root, id, dir);
    operations.push({ target, before: fileHash(target), after, afterHash: hash(after), kind: 'narrative' });
  }
  return operations;
}

function sortedEntries(entries) { return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))); }
function structuredRefs(body) {
  const refs = [];
  let collecting = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:## (?:Sources|Fontes|Claims)|(?:Sources|Claims):)$/.test(line)) collecting = true;
    else if (/^(?:#{1,6} |[A-Za-z]+:)/.test(line)) collecting = false;
    else if (collecting && line.startsWith('- ')) {
      const ref = line.slice(2).trim().replace(/^`|`$/g, '');
      if (ref && !['<fill in>', '<preencher>'].includes(ref)) refs.push(ref);
    }
  }
  return refs;
}
function sourceHashes(cwd, root, refs, stagedAdditions = new Set(), allowAny = false) {
  const values = new Map();
  for (const ref of refs) {
    if (!allowAny && !/^(storyspec|manuscript)\/.+\.md$/.test(ref)) throw new Error('Invalid source reference: ' + ref);
    if (stagedAdditions.has(ref)) continue;
    const path = pathInside(cwd, ref);
    verifySnapshot({ cwd, root, path });
    values.set(ref, fileHash(path));
  }
  return sortedEntries(values);
}
function planInputs(cwd, root, id) {
  const { dir, info } = changeInfo(root, id);
  const operations = preview(cwd, root, id);
  const artifacts = sortedEntries(planFiles(dir).map(path => [relative(cwd, path), fileHash(path)]));
  const base = sortedEntries(operations.filter(op => op.kind !== 'narrative').map(op => [relative(cwd, op.target), op.before]));
  const stagedAdditions = new Set(operations.filter(op => op.kind === 'claim' && op.before === null).map(op => relative(cwd, op.target)));
  const refs = planFiles(dir).filter(path => path.endsWith('.md')).flatMap(path => structuredRefs(read(path)));
  const sources = sourceHashes(cwd, root, refs, stagedAdditions);
  if (info.workflowVersion === 3) artifacts[relative(cwd, schemaPath(root))] = fileHash(schemaPath(root));
  const inputs = { artifacts, base, sources };
  return { inputs, hash: hash(JSON.stringify(inputs)) };
}
function currentHash(cwd, ref) {
  const path = resolve(cwd, ref);
  return existsSync(path) ? fileHash(pathInside(cwd, ref)) : null;
}
function compareHashes(expected, actual, label) {
  for (const group of Object.keys(expected)) {
    const previous = expected[group] || {}, next = actual[group] || {};
    for (const ref of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[ref] !== next[ref]) throw new Error(label + ': ' + ref + ' (' + group + ')');
    }
  }
}
function snapshotEvidence(cwd, dir, sources) {
  const snapshots = {};
  const storage = join(dir, 'evidence', 'sha256');
  mkdirSync(storage, { recursive: true });
  for (const [ref, digest] of Object.entries(sources)) {
    const path = pathInside(cwd, ref), target = join(storage, digest);
    if (!existsSync(target)) {
      const temp = target + '.tmp-' + process.pid;
      try {
        writeFileSync(temp, readFileSync(path), { flag: 'wx' });
        if (fileHash(temp) !== digest) throw new Error('Evidence changed during snapshot: ' + ref);
        renameSync(temp, target);
      } catch (error) { rmSync(temp, { force: true }); throw error; }
    }
    if (fileHash(target) !== digest) throw new Error('Evidence snapshot differs: ' + ref);
    snapshots[ref] = relative(cwd, target);
  }
  return sortedEntries(Object.entries(snapshots));
}
function verifyEvidence(cwd, sources, snapshots, label) {
  if (Object.keys(sources).length !== Object.keys(snapshots || {}).length) throw new Error(label + ': snapshot manifest is incomplete');
  for (const [ref, digest] of Object.entries(sources)) {
    const snapshot = snapshots[ref];
    if (!snapshot || !/^storyspec\/changes\/[a-z0-9-]+\/evidence\/sha256\/[a-f0-9]{64}$/.test(snapshot) || currentHash(cwd, snapshot) !== digest) {
      throw new Error(label + ': evidence snapshot for ' + ref);
    }
  }
}

function inventory(cwd, root) {
  const files = {};
  const narrative = join(root, 'narrative-state.json');
  if (existsSync(narrative)) files[relative(cwd, narrative)] = fileHash(narrative);
  for (const path of listFiles(join(root, 'specs')).filter(path => path.endsWith('.md'))) files[relative(cwd, path)] = fileHash(path);
  for (const folder of ['canon', 'characters', 'mysteries', 'continuity', 'architecture', 'style', 'claims']) {
    for (const path of listFiles(join(root, folder)).filter(path => path.endsWith('.md'))) {
      if (/^status: CANON$/m.test(read(path))) files[relative(cwd, path)] = fileHash(path);
    }
  }
  return files;
}
function state(cwd, root) {
  const path = join(root, 'state.json');
  if (!existsSync(path)) throw new Error('Baseline ratification required before apply.');
  const current = json(path), actual = inventory(cwd, root);
  if (current.formatVersion !== 4 || JSON.stringify(current.files) !== JSON.stringify(actual)) {
    throw new Error('Controlled state differs from its recorded baseline. Ratify or restore the files.');
  }
  return current;
}
export function ratifyBaseline(cwd, root, author) {
  if (!author?.trim()) throw new Error('Author name is required.');
  if (existsSync(join(root, 'state.json'))) throw new Error('Baseline already exists.');
  const files = inventory(cwd, root), digest = hash(JSON.stringify(files));
  mkdirSync(join(root, 'decisions'), { recursive: true });
  const record = { kind: 'baseline', author, at: timestamp(), hash: digest, files };
  save(join(root, 'decisions', 'baseline.json'), record);
  save(join(root, 'state.json'), { formatVersion: 4, revision: 0, files, lastChange: null });
  return record;
}
function validateChange(cwd, root, id, validateChapter) {
  const { dir, info } = changeInfo(root, id);
  const pt = info.language === 'pt-BR';
  requiredText(join(dir, 'proposal.md'), [pt ? 'Intenção' : 'Intent', pt ? 'Escopo' : 'Scope']);
  requiredText(join(dir, 'design.md'), [pt ? 'Abordagem' : 'Approach']);
  if (info.workflowVersion === 3) for (const item of customArtifacts(loadSchema(root, info.profile), info.type, 'plan')) requiredCustom(join(dir, item.path), item);
  if (info.type === 'chapter') {
    if (!existsSync(join(dir, 'chapter-contract.md'))) throw new Error('Chapter contract missing.');
    if (!listFiles(join(dir, 'scenes')).some(path => path.endsWith('.md'))) throw new Error('Chapter needs at least one scene.');
    const issues = validateChapter(id);
    if (issues.length) throw new Error('Chapter invalid: ' + issues.join('; '));
  }
  return preview(cwd, root, id);
}
export function validateWorkflowChange(cwd, root, id, validateChapter) {
  validateChange(cwd, root, id, validateChapter);
  return true;
}
function approvalPath(dir, stage) { return join(dir, 'decisions', stage + '.json'); }
function planReceipt(cwd, root, id) {
  const { dir } = changeInfo(root, id), path = approvalPath(dir, 'plan');
  if (!existsSync(path)) throw new Error('Plan approval required.');
  const receipt = json(path);
  if (!receipt.inputs) throw new Error('Plan approval is stale: approve the plan again with source snapshots.');
  for (const [group, entries] of Object.entries(receipt.inputs)) {
    for (const [ref, expected] of Object.entries(entries)) {
      if (currentHash(cwd, ref) !== expected) throw new Error('Plan approval is stale: ' + ref + ' (' + group + ')');
    }
  }
  const current = planInputs(cwd, root, id);
  compareHashes(receipt.inputs, current.inputs, 'Plan approval is stale');
  if (receipt.hash !== current.hash) throw new Error('Plan approval is stale.');
  verifyEvidence(cwd, receipt.inputs.sources, receipt.snapshots, 'Plan approval is stale');
  return receipt;
}
export function assertPlanApproved(cwd, root, id) { return planReceipt(cwd, root, id); }
export function initMap(root, id) {
  const { dir, info } = activeChange(root, id);
  if (info.workflowVersion >= 2) throw new Error('Narrative map already enabled.');
  const path = createNarrativeMap(dir, 1);
  canonical(join(dir, 'change.json'), { ...info, workflowVersion: 2 });
  return path;
}
export function verifyNarrative(cwd, root, id, record = false) {
  const { dir, info } = activeChange(root, id);
  if (!info.workflowVersion) throw new Error('Run storyspec map init ' + id + ' to enable narrative verification.');
  if (record) {
    planReceipt(cwd, root, id);
    if (['chapter', 'revision'].includes(info.type)) checkManuscript(cwd, root, id);
  }
  const result = evaluateNarrative(cwd, root, id, info);
  if (record) {
    const receipt = { at: timestamp(), inputs: result.inputs, report: result.report,
      hash: hash(JSON.stringify({ inputs: result.inputs, report: result.report })) };
    save(join(dir, 'verification.json'), receipt);
  }
  return result.report;
}
function verifiedNarrative(cwd, root, id) {
  const { dir, info } = changeInfo(root, id);
  if (!info.workflowVersion) return null;
  const path = join(dir, 'verification.json');
  if (!existsSync(path)) throw new Error('Recorded narrative verification required.');
  const receipt = json(path), result = evaluateNarrative(cwd, root, id, info);
  if (result.report.summary.blockers) throw new Error('Narrative verification has blocking findings: ' + result.report.issues.filter(item => !item.waived).map(item => item.path).join(', '));
  if (JSON.stringify(receipt.inputs) !== JSON.stringify(result.inputs) || JSON.stringify(receipt.report) !== JSON.stringify(result.report) ||
      receipt.hash !== hash(JSON.stringify({ inputs: receipt.inputs, report: receipt.report }))) throw new Error('Narrative verification is stale: ' + relative(cwd, path));
  return receipt;
}
function reviewPath(dir, pass) { return join(dir, 'reviews', pass + '.json'); }
function reviewReceiptPath(dir, pass) { return join(dir, 'reviews', pass + '.receipt.json'); }
function requiredPasses(type) { return type === 'chapter' || type === 'revision' ? reviewPasses : reviewPasses.slice(0, 2); }
function validateAssessments(dir, info, pass, report) {
  if (info.workflowVersion !== 3 || pass !== 'dramaturgy') return;
  const map = json(join(dir, 'narrative-map.json'));
  const expected = map.coverage.filter(entry => ['realized', 'partial'].includes(entry.status));
  if (!expected.length && report.requirementAssessments === undefined) return;
  if (!Array.isArray(report.requirementAssessments) || report.requirementAssessments.length !== expected.length) throw new Error('Human requirement assessments are incomplete.');
  const seen = new Set();
  for (const item of report.requirementAssessments) {
    const key = item.domain + '/' + item.requirement;
    const coverage = expected.find(entry => entry.domain === item.domain && entry.requirement === item.requirement);
    if (!coverage || seen.has(key) || !item.rationale?.trim() || item.verdict !== (coverage.status === 'realized' ? 'SATISFIED' : 'PARTIAL')) throw new Error('Human requirement assessment is invalid: ' + key);
    seen.add(key);
  }
}
export function review(cwd, root, id, pass, author, record = false) {
  const { dir, info } = activeChange(root, id);
  if (!reviewPasses.includes(pass)) throw new Error('Unknown review pass: ' + pass);
  const path = reviewPath(dir, pass);
  if (!record) {
    if (existsSync(path)) return path;
    save(path, { pass, verdict: 'PENDING', summary: '', evidence: [], findings: [], waivers: [], ...(info.workflowVersion === 3 && pass === 'dramaturgy' ? { requirementAssessments: [] } : {}) });
    return path;
  }
  planReceipt(cwd, root, id);
  if (!author?.trim()) throw new Error('Reviewer name is required.');
  const report = json(path);
  validateAssessments(dir, info, pass, report);
  if (report.pass !== pass || !['PASS', 'BLOCK'].includes(report.verdict) || !report.summary?.trim() ||
      !Array.isArray(report.evidence) || !report.evidence.length ||
      !Array.isArray(report.findings) || !Array.isArray(report.waivers)) throw new Error('Review report is incomplete.');
  for (const source of report.evidence) pathInside(cwd, source);
  const findingIds = new Set();
  for (const finding of report.findings) {
    ensureId(finding.id, 'Finding');
    if (findingIds.has(finding.id) || !['BLOCKER', 'NOTE'].includes(finding.severity) || !finding.text?.trim()) throw new Error('Invalid finding.');
    findingIds.add(finding.id);
    for (const source of finding.evidence || []) pathInside(cwd, source);
  }
  for (const waiver of report.waivers) {
    if (!findingIds.has(waiver.findingId) || !waiver.author?.trim() || !waiver.reason?.trim()) throw new Error('Invalid waiver.');
  }
  if (report.verdict === 'BLOCK' && !report.findings.some(finding => finding.severity === 'BLOCKER')) throw new Error('BLOCK verdict needs a blocking finding.');
  const receipt = { pass, author, at: timestamp(), hash: fileHash(path), change: id, type: info.type };
  const evidence = sourceHashes(cwd, root, [...report.evidence, ...report.findings.flatMap(finding => finding.evidence || [])], new Set(), true);
  const inputs = { report: fileHash(path), evidence };
  receipt.hash = hash(JSON.stringify(inputs));
  receipt.inputs = inputs;
  receipt.snapshots = snapshotEvidence(cwd, dir, evidence);
  save(reviewReceiptPath(dir, pass), receipt);
  return receipt;
}
function verifiedReviews(cwd, root, id) {
  const { dir, info } = changeInfo(root, id), hashes = {};
  for (const pass of requiredPasses(info.type)) {
    const path = reviewPath(dir, pass), receiptPath = reviewReceiptPath(dir, pass);
    if (!existsSync(path) || !existsSync(receiptPath)) throw new Error('Missing recorded review: ' + pass);
    const report = json(path), receipt = json(receiptPath);
    validateAssessments(dir, info, pass, report);
    if (!receipt.inputs || receipt.inputs.report !== fileHash(path)) throw new Error('Review changed after recording: ' + pass + ' (' + relative(cwd, path) + ')');
    for (const [ref, expected] of Object.entries(receipt.inputs.evidence || {})) {
      if (currentHash(cwd, ref) !== expected) throw new Error('Review evidence changed after recording: ' + pass + ' (' + ref + ')');
    }
    const evidence = sourceHashes(cwd, root, [...report.evidence, ...report.findings.flatMap(finding => finding.evidence || [])], new Set(), true);
    compareHashes({ evidence: receipt.inputs.evidence }, { evidence }, 'Review evidence changed after recording: ' + pass);
    if (receipt.hash !== hash(JSON.stringify({ report: receipt.inputs.report, evidence }))) throw new Error('Review changed after recording: ' + pass);
    verifyEvidence(cwd, receipt.inputs.evidence, receipt.snapshots, 'Review changed after recording: ' + pass);
    const blockers = report.findings.filter(finding => finding.severity === 'BLOCKER');
    for (const blocker of blockers) {
      if (!report.waivers.some(item => item.findingId === blocker.id && item.author?.trim() && item.reason?.trim())) {
        throw new Error('Unresolved blocking finding: ' + blocker.id);
      }
    }
    if (report.verdict === 'BLOCK' && !blockers.length) throw new Error('Invalid BLOCK review: ' + pass);
    hashes[pass] = receipt.hash;
  }
  return hashes;
}
function finalDigest(cwd, root, id) {
  const { dir, info } = changeInfo(root, id), operations = preview(cwd, root, id);
  const tasks = read(join(dir, 'tasks.md'));
  if (!tasks.includes('- [x]') && !tasks.includes('- [X]')) throw new Error('No tasks completed.');
  if (/- \[ \]/.test(tasks)) throw new Error('Tasks remain unchecked.');
  if (info.workflowVersion === 3) for (const item of customArtifacts(loadSchema(root, info.profile), info.type, 'final')) requiredCustom(join(dir, item.path), item);
  return hash(JSON.stringify({
    plan: planReceipt(cwd, root, id).hash,
    tasks: fileHash(join(dir, 'tasks.md')),
    operations: operations.map(op => [relative(cwd, op.target), op.before, op.afterHash]),
    reviews: verifiedReviews(cwd, root, id),
    draft: existsSync(join(dir, 'draft.md')) ? fileHash(join(dir, 'draft.md')) : null,
    verification: info.workflowVersion >= 2 ? verifiedNarrative(cwd, root, id).hash : null,
    manuscript: info.workflowVersion >= 2 && ['chapter', 'revision'].includes(info.type) ? (checkManuscript(cwd, root, id), fileHash(approvalPath(dir, 'manuscript'))) : null,
    custom: info.workflowVersion === 3 ? customArtifacts(loadSchema(root, info.profile), info.type, 'final').map(item => [item.id, fileHash(join(dir, item.path))]) : null,
  }));
}
export function approve(cwd, root, id, stage, author, validateChapter) {
  if (!author?.trim()) throw new Error('Author name is required.');
  if (!['plan', 'final'].includes(stage)) throw new Error('Approval stage must be plan or final.');
  const { dir } = activeChange(root, id);
  let digest;
  if (stage === 'plan') {
    validateChange(cwd, root, id, validateChapter);
    digest = planInputs(cwd, root, id);
  } else digest = finalDigest(cwd, root, id);
  mkdirSync(join(dir, 'decisions'), { recursive: true });
  const receipt = stage === 'plan'
    ? { stage, author, at: timestamp(), hash: digest.hash, inputs: digest.inputs, snapshots: snapshotEvidence(cwd, dir, digest.inputs.sources) }
    : { stage, author, at: timestamp(), hash: digest };
  save(approvalPath(dir, stage), receipt);
  return receipt;
}
export function acceptManuscript(cwd, root, id, ref, author) {
  const { dir, info } = activeChange(root, id);
  if (!['chapter', 'revision'].includes(info.type)) throw new Error('This change does not require a manuscript.');
  if (!author?.trim()) throw new Error('Author name is required.');
  if (!ref?.startsWith('manuscript/') || !ref.endsWith('.md')) throw new Error('Accepted manuscript must be a Markdown file under manuscript/.');
  const path = pathInside(cwd, ref);
  if (!statSync(path).isFile() || !read(path).trim()) throw new Error('Accepted manuscript is empty.');
  const receipt = { author, at: timestamp(), path: ref, hash: fileHash(path) };
  mkdirSync(join(dir, 'decisions'), { recursive: true });
  save(approvalPath(dir, 'manuscript'), receipt);
  return receipt;
}
function checkManuscript(cwd, root, id) {
  const { dir, info } = changeInfo(root, id);
  if (!['chapter', 'revision'].includes(info.type)) return;
  const path = approvalPath(dir, 'manuscript');
  if (!existsSync(path)) throw new Error('Manuscript acceptance required.');
  const receipt = json(path);
  if (fileHash(pathInside(cwd, receipt.path)) !== receipt.hash) throw new Error('Accepted manuscript changed.');
}
function finalReceipt(cwd, root, id) {
  const { dir } = changeInfo(root, id), path = approvalPath(dir, 'final');
  if (!existsSync(path)) throw new Error('Final approval required.');
  const receipt = json(path);
  if (receipt.hash !== finalDigest(cwd, root, id)) throw new Error('Final approval is stale.');
  return receipt;
}
export function workflowStatus(cwd, root, id) {
  const { dir } = changeInfo(root, id);
  if (existsSync(join(dir, 'archive.json'))) return 'ARCHIVED';
  if (existsSync(join(dir, 'applied.json'))) return 'APPLIED';
  if (existsSync(approvalPath(dir, 'final'))) {
    try { finalReceipt(cwd, root, id); return 'FINAL_APPROVED'; }
    catch { return 'STALE_FINAL_APPROVAL'; }
  }
  if (existsSync(approvalPath(dir, 'plan'))) {
    try { planReceipt(cwd, root, id); return 'PLAN_APPROVED'; }
    catch { return 'STALE_PLAN_APPROVAL'; }
  }
  return 'DRAFT';
}
export function workflowProgress(cwd, root, id, validateChapter) {
  const { dir, info } = changeInfo(root, id), phase = workflowStatus(cwd, root, id);
  if (phase === 'ARCHIVED' || phase === 'APPLIED') {
    const record = json(join(dir, phase === 'ARCHIVED' ? 'archive.json' : 'applied.json'));
    const artifacts = [join(dir, 'change.json'), join(dir, 'proposal.md'), join(dir, 'design.md'), join(dir, 'tasks.md'), join(dir, 'narrative-map.json'), join(dir, 'verification.json'), ...listFiles(join(dir, 'specs')), ...listFiles(join(dir, 'claims')), ...listFiles(join(dir, 'reviews')), ...listFiles(join(dir, 'decisions')), join(dir, 'applied.json'), join(dir, 'archive.json')]
      .filter(existsSync).map(path => ({ name: relative(dir, path), path: relative(cwd, path), complete: !(relative(cwd, path) in record.artifacts) || record.artifacts[relative(cwd, path)] === fileHash(path) }));
    const blockers = artifacts.filter(item => !item.complete).map(item => 'Archived artifact changed: ' + item.path);
    return { change: id, type: info.type, workflowVersion: info.workflowVersion || 1, phase, artifacts, blockers,
      next: blockers.length ? { action: 'inspect history ' + id, path: blockers[0].split(': ')[1], reason: blockers[0] } : phase === 'APPLIED' ? { action: 'archive ' + id, path: relative(cwd, join(dir, 'archive.json')), reason: 'Application complete.' } : null };
  }
  const artifacts = [], blockers = [];
  const check = (name, path, fn) => {
    try { fn(); artifacts.push({ name, path: relative(cwd, path), complete: true }); return true; }
    catch (error) { artifacts.push({ name, path: relative(cwd, path), complete: false, reason: error.message }); blockers.push(error.message); return false; }
  };
  const first = (name, path, action, fn) => ({ name, path: relative(cwd, path), action, fn });
  const stages = [first('plan', join(dir, 'decisions', 'plan.json'), 'approve ' + id + ' plan --author <name>', () => planReceipt(cwd, root, id))];
  const schema = info.workflowVersion === 3 ? loadSchema(root, info.profile) : null;
  if (schema) stages.unshift(...customArtifacts(schema, info.type, 'plan').map(item => first(item.id, join(dir, item.path), 'edit ' + relative(cwd, join(dir, item.path)), () => requiredCustom(join(dir, item.path), item))));
  if (['chapter', 'revision'].includes(info.type)) stages.push(first('manuscript', join(dir, 'decisions', 'manuscript.json'), 'write manuscript; manuscript accept ' + id + ' manuscript/<file>.md --author <name>', () => checkManuscript(cwd, root, id)));
  if (info.workflowVersion >= 2) stages.push(first('narrative verification', join(dir, 'verification.json'), 'verify ' + id + ' --record', () => verifiedNarrative(cwd, root, id)));
  for (const pass of requiredPasses(info.type)) stages.push(first(pass + ' review', reviewPath(dir, pass), 'review ' + id + ' ' + pass + ' --record --author <name>', () => {
    const receipt = reviewReceiptPath(dir, pass);
    if (!existsSync(receipt)) throw new Error('Missing recorded review: ' + pass);
    if (fileHash(reviewPath(dir, pass)) !== json(receipt).inputs?.report) throw new Error('Review changed after recording: ' + pass);
  }));
  if (schema) stages.push(...customArtifacts(schema, info.type, 'final').map(item => first(item.id, join(dir, item.path), 'edit ' + relative(cwd, join(dir, item.path)), () => requiredCustom(join(dir, item.path), item))));
  stages.push(first('final approval', approvalPath(dir, 'final'), 'approve ' + id + ' final --author <name>', () => finalReceipt(cwd, root, id)));
  stages.push(first('application', join(dir, 'applied.json'), 'apply ' + id + ' --dry-run; storyspec apply ' + id, () => { if (!existsSync(join(dir, 'applied.json'))) throw new Error('Change has not been applied.'); }));
  stages.push(first('archive', join(dir, 'archive.json'), 'archive ' + id, () => { if (!existsSync(join(dir, 'archive.json'))) throw new Error('Change has not been archived.'); }));
  let next = null;
  for (const stage of stages) {
    const okay = check(stage.name, stage.path, stage.fn);
    if (!okay && !next) next = { action: stage.action, path: stage.path, reason: artifacts.at(-1).reason };
  }
  const planning = [join(dir, 'proposal.md'), join(dir, 'design.md'), ...listFiles(join(dir, 'specs'))];
  for (const path of planning) artifacts.unshift({ name: relative(dir, path), path: relative(cwd, path), complete: existsSync(path) && !read(path).includes(info.language === 'pt-BR' ? '<preencher>' : '<fill in>') });
  if (info.workflowVersion >= 2) {
    let complete = false;
    try { complete = evaluateNarrative(cwd, root, id, info).report.summary.blockers === 0; } catch { /* Other artifact checks report malformed inputs. */ }
    artifacts.unshift({ name: 'narrative map', path: relative(cwd, join(dir, 'narrative-map.json')), complete });
  }
  const tasks = join(dir, 'tasks.md');
  artifacts.unshift({ name: 'tasks', path: relative(cwd, tasks), complete: existsSync(tasks) && !/- \[ \]/.test(read(tasks)) });
  if (existsSync(join(dir, 'draft.md'))) artifacts.unshift({ name: 'draft', path: relative(cwd, join(dir, 'draft.md')), complete: Boolean(read(join(dir, 'draft.md')).split('\n').slice(2).join('\n').trim()) });
  const schemaArtifacts = schema ? schema.artifacts.filter(item => !item.types || item.types.includes(info.type)).map(item => {
    const names = { proposal: 'proposal.md', design: 'design.md', tasks: 'tasks', map: 'narrative map', manuscript: 'manuscript', verification: 'narrative verification', dramaturgy: 'dramaturgy review', continuity: 'continuity review', prose: 'prose review', final: 'final approval', apply: 'application', archive: 'archive' };
    const matched = item.id === 'specs' ? artifacts.filter(artifact => artifact.name.startsWith('specs/')) : artifacts.filter(artifact => artifact.name === (names[item.id] || item.id));
    return { id: item.id, path: item.path ? relative(cwd, join(dir, item.path)) : matched[0]?.path || null, complete: Boolean(matched.length) && matched.every(artifact => artifact.complete), requires: item.requires };
  }) : [];
  for (const item of schemaArtifacts) item.ready = item.requires.every(dep => schemaArtifacts.find(other => other.id === dep)?.complete !== false);
  if (schema && next) {
    const custom = schemaArtifacts.find(item => item.path === next.path && schema.artifacts.find(def => def.id === item.id)?.path);
    if (custom && !custom.ready) {
      const dependency = custom.requires.map(dep => schemaArtifacts.find(item => item.id === dep)).find(item => item && !item.complete);
      if (dependency) next = { action: 'complete ' + dependency.id, path: dependency.path || relative(cwd, dir), reason: dependency.id + ' is required before ' + custom.id };
    }
  }
  if (phase === 'DRAFT' && next?.action.startsWith('approve')) {
    try { validateChange(cwd, root, id, validateChapter); } catch (error) { next = { action: 'complete plan artifacts', path: relative(cwd, dir), reason: error.message }; blockers.unshift(error.message); }
  }
  return { change: id, type: info.type, workflowVersion: info.workflowVersion || 1, phase, artifacts, schemaArtifacts, blockers, next };
}
export function reconcileChange(cwd, root, id) {
  const { dir, info } = changeInfo(root, id);
  if (existsSync(join(dir, 'archive.json')) || existsSync(join(dir, 'applied.json'))) {
    const record = existsSync(join(dir, 'archive.json')) ? json(join(dir, 'archive.json')) : json(join(dir, 'applied.json'));
    const actual = artifactHashes(cwd, dir), current = JSON.stringify(actual) === JSON.stringify(record.artifacts);
    return { change: id, state: workflowStatus(cwd, root, id), stages: [{ stage: 'historical artifacts', current, ...(current ? {} : { reason: 'Preserved artifact hashes differ from the application receipt.' }) }], next: current ? null : 'inspect history' };
  }
  const checks = [
    ['plan', () => planReceipt(cwd, root, id)],
    ...(info.workflowVersion >= 2 ? [['verification', () => verifiedNarrative(cwd, root, id)]] : []),
    ...requiredPasses(info.type).map(pass => [pass, () => {
      const path = reviewReceiptPath(dir, pass);
      if (!existsSync(path)) throw new Error('Missing recorded review: ' + pass);
      const report = reviewPath(dir, pass), receipt = json(path);
      if (fileHash(report) !== receipt.inputs?.report) throw new Error('Review changed after recording: ' + relative(cwd, report));
      const data = json(report);
      validateAssessments(dir, info, pass, data);
      for (const [ref, expected] of Object.entries(receipt.inputs?.evidence || {})) if (currentHash(cwd, ref) !== expected) throw new Error('Review evidence changed after recording: ' + ref);
      verifyEvidence(cwd, receipt.inputs?.evidence || {}, receipt.snapshots, 'Review evidence changed after recording: ' + pass);
      for (const finding of data.findings || []) if (finding.severity === 'BLOCKER' && !(data.waivers || []).some(waiver => waiver.findingId === finding.id && waiver.author?.trim() && waiver.reason?.trim())) throw new Error('Unresolved blocking finding: ' + finding.id);
    }]),
    ['final', () => finalReceipt(cwd, root, id)],
  ];
  const stages = checks.map(([name, check]) => { try { check(); return { stage: name, current: true }; } catch (error) { return { stage: name, current: false, reason: error.message }; } });
  return { change: id, state: workflowStatus(cwd, root, id), stages, next: stages.find(item => !item.current)?.stage || null };
}
export function applyPreview(cwd, root, id) {
  return preview(cwd, root, id).map(op => ({
    target: relative(cwd, op.target), beforeHash: op.before, afterHash: op.afterHash,
    before: existsSync(op.target) ? read(op.target) : null, after: op.after,
  }));
}

function journalPath(root, id) { return join(root, 'transactions', id + '.json'); }
function writeTarget(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (content === null) { rmSync(path, { force: true }); return; }
  const temp = path + '.tmp-' + process.pid;
  writeFileSync(temp, content, { flag: 'wx' });
  renameSync(temp, path);
}
function pendingTransactions(root) {
  return listFiles(join(root, 'transactions')).filter(path => path.endsWith('.json'));
}
export function recoverApply(cwd, root, id) {
  const path = journalPath(root, id);
  if (!existsSync(path)) throw new Error('No interrupted application for: ' + id);
  const journal = json(path), statePath = join(root, 'state.json');
  const current = json(statePath);
  if (journal.change !== id || !Array.isArray(journal.operations)) throw new Error('Invalid transaction journal.');
  if (current.revision === journal.revision + 1 && current.lastChange === id) {
    for (const op of journal.operations) if (fileHash(pathInside(cwd, op.target, false)) !== op.afterHash) throw new Error('Applied files differ from journal.');
    const { dir } = changeInfo(root, id);
    if (!existsSync(join(dir, 'applied.json'))) save(join(dir, 'applied.json'), { at: timestamp(), revision: current.revision, artifacts: journal.artifacts, operations: journal.operations.map(op => ({ target: op.target, beforeHash: op.beforeHash, afterHash: op.afterHash })) });
    rmSync(path);
    return { action: 'completed', change: id };
  }
  if (current.revision !== journal.revision) throw new Error('State changed since interrupted application.');
  for (const op of journal.operations) {
    const target = pathInside(cwd, op.target, false), actual = fileHash(target);
    if (![op.beforeHash, op.afterHash].includes(actual)) throw new Error('Controlled file changed after interruption: ' + op.target);
  }
  for (const op of journal.operations) writeTarget(pathInside(cwd, op.target, false), op.before);
  rmSync(path);
  return { action: 'rolled-back', change: id };
}
export function applyChange(cwd, root, id) {
  activeChange(root, id);
  if (pendingTransactions(root).length) throw new Error('Recover the interrupted application before continuing.');
  const current = state(cwd, root);
  finalReceipt(cwd, root, id);
  checkManuscript(cwd, root, id);
  const operations = applyPreview(cwd, root, id);
  for (const op of operations) if (fileHash(pathInside(cwd, op.target, false)) !== op.beforeHash) throw new Error('Base conflict: ' + op.target);
  const { dir } = changeInfo(root, id);
  const artifacts = artifactHashes(cwd, dir);
  const journal = { formatVersion: 4, change: id, revision: current.revision, at: timestamp(), artifacts, operations };
  mkdirSync(join(root, 'transactions'), { recursive: true });
  save(journalPath(root, id), journal);
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    writeTarget(pathInside(cwd, op.target, false), op.after);
    if (process.env.STORYSPEC_INTERRUPT_AFTER === String(i + 1)) throw new Error('Simulated interruption; run apply --recover ' + id);
  }
  const files = inventory(cwd, root);
  canonical(join(root, 'state.json'), { formatVersion: 4, revision: current.revision + 1, files, lastChange: id });
  if (process.env.STORYSPEC_INTERRUPT_AFTER === 'state') throw new Error('Simulated interruption; run apply --recover ' + id);
  save(join(dir, 'applied.json'), { at: timestamp(), revision: current.revision + 1, artifacts, operations: operations.map(op => ({ target: op.target, beforeHash: op.beforeHash, afterHash: op.afterHash })) });
  rmSync(journalPath(root, id));
  return { action: 'applied', change: id, revision: current.revision + 1, files: operations.length };
}
export function dryRunApply(cwd, root, id) {
  activeChange(root, id);
  if (pendingTransactions(root).length) throw new Error('Recover the interrupted application before continuing.');
  state(cwd, root);
  finalReceipt(cwd, root, id);
  checkManuscript(cwd, root, id);
  return applyPreview(cwd, root, id).map(({ target, beforeHash, afterHash }) => ({ target, beforeHash, afterHash }));
}
export function archiveChange(cwd, root, id) {
  const { dir, info } = changeInfo(root, id);
  state(cwd, root);
  if (existsSync(join(dir, 'archive.json'))) throw new Error('Change is already archived: ' + id);
  if (!existsSync(join(dir, 'applied.json'))) throw new Error('Apply the change before archiving.');
  checkManuscript(cwd, root, id);
  const applied = json(join(dir, 'applied.json'));
  if (!Array.isArray(applied.operations) || !applied.operations.length) throw new Error('Invalid application receipt.');
  const artifacts = artifactHashes(cwd, dir);
  if (JSON.stringify(applied.artifacts) !== JSON.stringify(artifacts)) throw new Error('Approved artifacts changed after application.');
  const archive = { state: 'ARCHIVED', at: timestamp(), revision: applied.revision, change: id, type: info.type, artifacts };
  canonical(join(dir, 'archive.json'), archive);
  return { action: 'archived', change: id, type: info.type, path: relative(cwd, dir) };
}

export function history(root, id) {
  ensureId(id);
  const current = changeDir(root, id);
  if (existsSync(join(current, 'change.json'))) {
    const archivePath = join(current, 'archive.json'), archived = existsSync(archivePath);
    const verified = archived ? JSON.stringify(json(archivePath).artifacts) === JSON.stringify(artifactHashes(dirname(root), current)) : null;
    return { change: id, path: relative(dirname(root), current), state: archived ? 'ARCHIVED' : existsSync(join(current, 'applied.json')) ? 'APPLIED' : 'ACTIVE', legacyMoved: false, verified };
  }
  const parent = join(root, 'changes', 'archive');
  const matches = existsSync(parent) ? readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('-' + id) && existsSync(join(parent, entry.name, 'change.json')) && json(join(parent, entry.name, 'change.json')).id === id) : [];
  if (matches.length !== 1) throw new Error(matches.length ? 'Multiple archived changes found: ' + id : 'Change not found: ' + id);
  return { change: id, path: relative(dirname(root), join(parent, matches[0].name)), state: 'ARCHIVED', legacyMoved: true, verified: null };
}
