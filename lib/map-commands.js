import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, realpathSync, renameSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { narrativeMap } from './narrative.js';
import { parseSpec } from './specs.js';
import { loadSchema } from './schema.js';

const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, data) {
  const temp = path + '.tmp-' + process.pid;
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}
function opts(args, repeated = []) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Map options require --name value pairs.');
    if (repeated.includes(key)) (result[key] ||= []).push(value);
    else { if (key in result) throw new Error('Repeated map option: ' + key); result[key] = value; }
  }
  return result;
}
function allowed(options, keys) { for (const key of Object.keys(options)) if (!keys.includes(key)) throw new Error('Unknown map option: ' + key); }
function req(ref) { const parts = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(ref || ''); if (!parts) throw new Error('Requirement must be <domain>/<id>.'); return { domain: parts[1], requirement: parts[2] }; }
function integer(value, label, min = 1) { const number = Number(value); if (!Number.isInteger(number) || number < min) throw new Error(label + ' must be an integer >= ' + min); return number; }
function required(value, label) { if (!value?.trim()) throw new Error(label + ' is required.'); return value.trim(); }
function projectPath(cwd, ref) {
  if (!ref || isAbsolute(ref) || ref.includes('\\') || /(^|\/)\.\.?($|\/)/.test(ref)) throw new Error('Invalid project path: ' + ref);
  const path = resolve(cwd, ref), real = realpathSync(path), project = realpathSync(cwd), rel = relative(project, real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Path escapes project: ' + ref);
  return path;
}
function editable(root, changeId) {
  if (!id.test(changeId || '')) throw new Error('Invalid change ID.');
  const dir = join(root, 'changes', changeId), metaPath = join(dir, 'change.json');
  if (!existsSync(metaPath)) throw new Error('Change not found: ' + changeId);
  if (existsSync(join(dir, 'applied.json')) || existsSync(join(dir, 'archive.json'))) throw new Error('Applied or archived map cannot be edited.');
  const info = read(metaPath);
  if (info.workflowVersion < 2) throw new Error('Run storyspec map init ' + changeId + ' first.');
  return { dir, info, map: narrativeMap(dir) };
}
function ensureRequirement(dir, domain, requirement) {
  const file = join(dir, 'specs', domain, 'spec.md');
  if (!existsSync(file)) throw new Error('Delta domain not found: ' + domain);
  const delta = parseSpec(readFileSync(file, 'utf8'), domain, true);
  if (![...delta.ADDED, ...delta.MODIFIED].some(item => item.id === requirement)) throw new Error('Changed requirement not found: ' + domain + '/' + requirement);
}
export function mapCommand(cwd, root, action, changeId, target, args = []) {
  const { dir, info, map } = editable(root, changeId), path = join(dir, 'narrative-map.json');
  if (action === 'upgrade') {
    if (map.version !== 1 || info.workflowVersion !== 2) throw new Error('Only a version 1 map in an older change can be upgraded.');
    loadSchema(root, info.profile);
    for (const entry of map.coverage) {
      if (['realized', 'partial'].includes(entry.status)) {
        if (entry.scenes?.length !== 1 || entry.passages?.length !== 1) throw new Error('Pair scenes and passages manually before upgrading: ' + entry.domain + '/' + entry.requirement);
        entry.links = [{ scene: entry.scenes[0], passage: entry.passages[0] }];
      }
      delete entry.scenes; delete entry.passages;
    }
    map.version = 2;
    save(path, map); save(join(dir, 'change.json'), { ...info, workflowVersion: 3 });
    return { action, change: changeId, path: relative(cwd, path), version: 2 };
  }
  if (map.version !== 2) throw new Error('Run storyspec map upgrade ' + changeId + ' before guided edits.');
  const o = opts(args, ['--after', '--cause', '--presence']);
  if (action === 'scene') {
    allowed(o, ['--order', '--after', '--cause', '--origin', '--time', '--place', '--presence']);
    if (!id.test(target || '')) throw new Error('Invalid scene ID.');
    let scene = map.scenes.find(item => item.id === target);
    if (!scene) {
      if (info.type === 'chapter') throw new Error('Create the chapter scene first: storyspec new scene ' + changeId + ' ' + target);
      scene = { id: target, narrativeOrder: null, storyAfter: [], causedBy: [], originReason: '', stateChanges: [], knowledgeChanges: [] };
      map.scenes.push(scene);
    }
    if (o['--order']) scene.narrativeOrder = integer(o['--order'], 'order');
    if (o['--after']) scene.storyAfter = o['--after'];
    if (o['--cause']) scene.causedBy = o['--cause'];
    if (o['--origin']) scene.originReason = o['--origin'];
    if (o['--time']) scene.storyTime = integer(o['--time'], 'time', 0);
    if (o['--place']) { projectPath(cwd, o['--place']); scene.place = o['--place']; }
    if (o['--presence']) scene.presence = o['--presence'];
  } else if (action === 'coverage') {
    allowed(o, ['--status', '--target', '--reason']);
    const requirement = req(target); ensureRequirement(dir, requirement.domain, requirement.requirement);
    if (!['realized', 'partial', 'deferred'].includes(o['--status'])) throw new Error('Coverage status must be realized, partial, or deferred.');
    let entry = map.coverage.find(item => item.domain === requirement.domain && item.requirement === requirement.requirement);
    if (!entry) { entry = { ...requirement }; map.coverage.push(entry); }
    entry.status = o['--status'];
    if (entry.status === 'partial' || entry.status === 'deferred') entry.defer = { target: required(o['--target'], 'target'), reason: required(o['--reason'], 'reason') };
    else delete entry.defer;
    if (entry.status === 'deferred') delete entry.links;
  } else if (action === 'passage') {
    allowed(o, ['--scene', '--lines']);
    const requirement = req(target), entry = map.coverage.find(item => item.domain === requirement.domain && item.requirement === requirement.requirement);
    if (!entry || !['realized', 'partial'].includes(entry.status)) throw new Error('Set realized or partial coverage first.');
    if (!map.scenes.some(scene => scene.id === o['--scene'])) throw new Error('Scene is not in this map: ' + o['--scene']);
    const range = /^(\d+):(\d+)$/.exec(o['--lines'] || '');
    if (!range) throw new Error('Use --lines <start>:<end>.');
    const startLine = integer(range[1], 'startLine'), endLine = integer(range[2], 'endLine');
    if (endLine < startLine) throw new Error('Line range is reversed.');
    const acceptance = join(dir, 'decisions', 'manuscript.json');
    if (!existsSync(acceptance)) throw new Error('Accept a manuscript before adding passages.');
    const accepted = read(acceptance), file = projectPath(cwd, accepted.path), body = readFileSync(file);
    if (hash(body) !== accepted.hash) throw new Error('Accepted manuscript changed.');
    const lines = body.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (endLine > lines.length || !lines.slice(startLine - 1, endLine).some(line => line.trim())) throw new Error('Passage range is empty or outside the manuscript.');
    (entry.links ||= []).push({ scene: o['--scene'], passage: { path: accepted.path, hash: accepted.hash, startLine, endLine } });
  } else if (action === 'state') {
    allowed(o, ['--entity', '--field', '--from', '--to']);
    const scene = map.scenes.find(item => item.id === target);
    if (!scene) throw new Error('Scene is not in this map: ' + target);
    projectPath(cwd, o['--entity']);
    (scene.stateChanges ||= []).push({ entity: o['--entity'], field: required(o['--field'], 'field'), from: required(o['--from'], 'from'), to: required(o['--to'], 'to') });
  } else if (action === 'knowledge') {
    allowed(o, ['--character', '--claim', '--from', '--to']);
    const scene = map.scenes.find(item => item.id === target);
    if (!scene) throw new Error('Scene is not in this map: ' + target);
    if (!id.test(o['--character'] || '') || !['UNAWARE', 'SUSPECTS', 'BELIEVES', 'KNOWS'].includes(o['--from']) || !['UNAWARE', 'SUSPECTS', 'BELIEVES', 'KNOWS'].includes(o['--to'])) throw new Error('Invalid character or knowledge state.');
    (scene.knowledgeChanges ||= []).push({ character: o['--character'], claim: required(o['--claim'], 'claim'), from: o['--from'], to: o['--to'] });
  } else if (action === 'waive') {
    allowed(o, ['--author', '--reason']);
    if (map.waivers.some(item => item.issueId === target)) throw new Error('Finding already waived: ' + target);
    map.waivers.push({ issueId: required(target, 'issue ID'), author: required(o['--author'], 'author'), reason: required(o['--reason'], 'reason') });
  } else throw new Error('Unknown map command: ' + action);
  save(path, map);
  return { action, change: changeId, path: relative(cwd, path), target };
}
