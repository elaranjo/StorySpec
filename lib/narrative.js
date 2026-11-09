import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseSpec } from './specs.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const epistemic = new Set(['UNAWARE', 'SUSPECTS', 'BELIEVES', 'KNOWS']);
const serial = value => JSON.stringify(value, null, 2) + '\n';
const portugueseIssues = {
  'scene-id': 'ID da cena ausente ou duplicado.',
  'narrative-order': 'A ordem de apresentação precisa ser um inteiro positivo e único.',
  'story-time': 'O tempo da história deve ser um inteiro não negativo.',
  'story-time-order': 'O tempo da história antecede uma cena declarada como anterior.',
  'scene-place': 'O lugar deve apontar para um arquivo existente do projeto.',
  'scene-presence': 'A presença deve apontar para personagens existentes.',
  'co-presence': 'Um personagem está em lugares distintos no mesmo momento da história.',
  'scene-field': 'Campo da cena deve ser uma lista.',
  'scene-file': 'Arquivo da cena do capítulo não encontrado.',
  'scene-reference': 'Cena referenciada não encontrada.',
  'scene-cycle': 'A relação entre cenas forma um ciclo.',
  'branch-ambiguity': 'Caminhos anteriores discordam ao se encontrarem nesta cena.',
  'causal-origin': 'Informe uma causa ou justifique a origem narrativa.',
  'causal-order': 'A causa não precede a cena na ordem dos acontecimentos.',
  'state-transition': 'Transição de estado incompleta, duplicada ou com entidade ausente.',
  'state-ambiguity': 'Caminhos anteriores discordam sobre o estado.',
  'state-conflict': 'O estado anterior declarado diverge do último estado conhecido.',
  'knowledge-transition': 'Transição de conhecimento incompleta, duplicada ou com referência ausente.',
  'knowledge-ambiguity': 'Caminhos anteriores discordam sobre o conhecimento.',
  'knowledge-conflict': 'O conhecimento anterior declarado diverge do último estado conhecido.',
  'scene-map': 'Cena do capítulo ausente do mapa narrativo.',
  'coverage-reference': 'A cobertura deve apontar para um requisito alterado exatamente uma vez.',
  'coverage-status': 'Estado de cobertura inválido.',
  'deferral': 'O adiamento exige alvo e justificativa.',
  'coverage-manuscript': 'Esta mudança não tem manuscrito para cobertura realizada.',
  'coverage-scene': 'A cobertura exige uma cena desta mudança.',
  'coverage-passage': 'A cobertura exige uma passagem do manuscrito aceito.',
  'passage-reference': 'A passagem deve citar arquivo, hash e linhas válidas do manuscrito aceito.',
  'passage-content': 'A passagem está fora do manuscrito aceito ou está vazia.',
  'coverage-missing': 'Requisito alterado sem cobertura ou adiamento justificado.',
  waiver: 'A dispensa exige achado narrativo atual, nome do autor e justificativa.',
};

export function emptyNarrativeMap(version = 2) { return { version, scenes: [], coverage: [], waivers: [] }; }
export function createNarrativeMap(dir, version = 2) {
  const path = join(dir, 'narrative-map.json');
  if (existsSync(path)) throw new Error('Narrative map already exists.');
  writeFileSync(path, serial(emptyNarrativeMap(version)));
  return path;
}
export function addNarrativeScene(dir, id) {
  const path = join(dir, 'narrative-map.json');
  if (!existsSync(path)) return;
  const map = json(path);
  if (!Array.isArray(map.scenes) || map.scenes.some(scene => scene.id === id)) throw new Error('Invalid or duplicate narrative scene: ' + id);
  map.scenes.push({ id, narrativeOrder: null, storyAfter: [], causedBy: [], originReason: '', stateChanges: [], knowledgeChanges: [] });
  writeFileSync(path, serial(map));
}
export function narrativeIndex(root) {
  const path = join(root, 'narrative-state.json');
  const index = existsSync(path) ? json(path) : { version: 1, scenes: [] };
  if (index.version !== 1 || !Array.isArray(index.scenes)) throw new Error('Invalid narrative state index.');
  return index;
}
export function narrativeMap(dir) {
  const path = join(dir, 'narrative-map.json');
  if (!existsSync(path)) throw new Error('Narrative map missing: ' + path);
  const map = json(path);
  if (![1, 2].includes(map.version) || !Array.isArray(map.scenes) || !Array.isArray(map.coverage) || !Array.isArray(map.waivers)) throw new Error('Invalid narrative map: ' + path);
  return map;
}
export function narrativeAfter(root, id, dir) {
  const index = narrativeIndex(root), map = narrativeMap(dir);
  return serial({ version: 1, scenes: [...index.scenes, ...map.scenes.map(scene => ({ ...scene, key: id + '/' + scene.id, origin: id }))] });
}
function issue(code, subject, message, path, waivable = false) {
  return { id: code + ':' + subject, severity: 'BLOCKER', waivable, message, path };
}
function projectFile(cwd, ref) {
  if (!ref || isAbsolute(ref) || ref.includes('\\') || /(^|\/)\.\.?($|\/)/.test(ref)) return null;
  const path = resolve(cwd, ref);
  if (!existsSync(path)) return null;
  const real = realpathSync(path);
  const rel = relative(realpathSync(cwd), real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return path;
}
function changedKey(entry) { return entry.entity + '/' + entry.field; }
function valueFor(scene, key) {
  if (key.startsWith('knowledge/')) {
    const suffix = key.slice('knowledge/'.length);
    return (Array.isArray(scene.knowledgeChanges) ? scene.knowledgeChanges : []).find(item => item.character + '/' + item.claim === suffix)?.to;
  }
  return (Array.isArray(scene.stateChanges) ? scene.stateChanges : []).find(item => changedKey(item) === key)?.to;
}
function priorValues(nodes, scene, key, visited = new Set()) {
  const values = new Set();
  for (const previous of Array.isArray(scene.storyAfter) ? scene.storyAfter : []) {
    if (visited.has(previous)) continue;
    const prior = nodes.get(previous);
    if (!prior) continue;
    const value = valueFor(prior, key);
    if (value !== undefined) values.add(value);
    else for (const inherited of priorValues(nodes, prior, key, new Set([...visited, previous]))) values.add(inherited);
  }
  return values;
}
function ancestorKeys(nodes, key, seen = new Set()) {
  if (seen.has(key)) return new Set();
  seen.add(key);
  const node = nodes.get(key), keys = new Set();
  if (!node) return keys;
  for (const item of Array.isArray(node.stateChanges) ? node.stateChanges : []) keys.add(changedKey(item));
  for (const item of Array.isArray(node.knowledgeChanges) ? node.knowledgeChanges : []) keys.add('knowledge/' + item.character + '/' + item.claim);
  for (const previous of Array.isArray(node.storyAfter) ? node.storyAfter : []) for (const inherited of ancestorKeys(nodes, previous, seen)) keys.add(inherited);
  return keys;
}
function reachable(nodes, start, target, field, visited = new Set()) {
  if (start === target) return true;
  if (visited.has(start)) return false;
  visited.add(start);
  const edges = nodes.get(start)?.[field];
  return (Array.isArray(edges) ? edges : []).some(previous => reachable(nodes, previous, target, field, visited));
}
function requirements(dir) {
  const base = join(dir, 'specs');
  if (!existsSync(base)) return [];
  const entries = [];
  for (const domain of readdirSync(base, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const path = join(base, domain.name, 'spec.md');
    if (!existsSync(path)) continue;
    const delta = parseSpec(read(path), domain.name, true);
    for (const item of [...delta.ADDED, ...delta.MODIFIED]) entries.push({ domain: domain.name, requirement: item.id });
  }
  return entries;
}
export function evaluateNarrative(cwd, root, id, info) {
  const dir = join(root, 'changes', id), mapPath = join(dir, 'narrative-map.json');
  const map = narrativeMap(dir), current = narrativeIndex(root), issues = [];
  const currentKeys = new Set(current.scenes.map(scene => scene.key));
  const proposed = map.scenes.map(scene => ({ ...scene, key: id + '/' + scene.id, origin: id }));
  const nodes = new Map([...current.scenes, ...proposed].map(scene => [scene.key, scene]));
  const manifest = existsSync(join(dir, 'claims.json')) ? json(join(dir, 'claims.json')) : { operations: [] };
  const removedClaims = new Set((manifest.operations || []).filter(item => item.operation === 'REMOVED').map(item => 'storyspec/claims/' + item.type + '/' + item.id + '.md'));
  const orders = new Set(), seenScenes = new Set();
  for (const scene of proposed) {
    const ref = relative(cwd, mapPath) + '#scenes/' + scene.id;
    if (!idPattern.test(scene.id || '') || seenScenes.has(scene.id) || currentKeys.has(scene.key)) issues.push(issue('scene-id', scene.key, 'Scene ID is missing or duplicated.', ref));
    seenScenes.add(scene.id);
    if (!Number.isInteger(scene.narrativeOrder) || scene.narrativeOrder < 1 || orders.has(scene.narrativeOrder)) issues.push(issue('narrative-order', scene.key, 'Narrative order must be a unique positive integer.', ref));
    if (scene.storyTime !== undefined && (!Number.isInteger(scene.storyTime) || scene.storyTime < 0)) issues.push(issue('story-time', scene.key, 'Story time must be a nonnegative integer.', ref));
    if (scene.place !== undefined && !projectFile(cwd, scene.place)) issues.push(issue('scene-place', scene.key, 'Scene place must reference an existing project file.', ref));
    if (scene.presence !== undefined && (!Array.isArray(scene.presence) || scene.presence.some(person => !idPattern.test(person) || !existsSync(join(root, 'characters', person + '.md'))))) issues.push(issue('scene-presence', scene.key, 'Scene presence must reference existing characters.', ref));
    orders.add(scene.narrativeOrder);
    for (const field of ['storyAfter', 'causedBy', 'stateChanges', 'knowledgeChanges']) if (!Array.isArray(scene[field])) issues.push(issue('scene-field', scene.key + '-' + field, field + ' must be a list.', ref));
    if (info.type === 'chapter' && !existsSync(join(dir, 'scenes', scene.id + '.md'))) issues.push(issue('scene-file', scene.key, 'Chapter scene file is missing.', ref));
    for (const field of ['storyAfter', 'causedBy']) for (const key of Array.isArray(scene[field]) ? scene[field] : []) {
      if (!nodes.has(key)) issues.push(issue('scene-reference', scene.key + '-' + key, 'Referenced scene does not exist: ' + key, ref));
      else if (key === scene.key || reachable(nodes, key, scene.key, field)) issues.push(issue('scene-cycle', scene.key + '-' + field, 'Scene relation forms a cycle.', ref));
      if (field === 'storyAfter' && Number.isInteger(scene.storyTime) && Number.isInteger(nodes.get(key)?.storyTime) && scene.storyTime < nodes.get(key).storyTime) issues.push(issue('story-time-order', scene.key + '-' + key, 'Story time precedes a declared predecessor.', ref, true));
    }
    if (Number.isInteger(scene.storyTime) && Array.isArray(scene.presence)) for (const other of [...current.scenes, ...proposed]) {
      if (other.key === scene.key || (other.origin === id && other.key >= scene.key) || other.storyTime !== scene.storyTime || !Array.isArray(other.presence) || !scene.place || !other.place || scene.place === other.place) continue;
      const shared = scene.presence.filter(person => other.presence.includes(person));
      if (shared.length) issues.push(issue('co-presence', scene.key + '-' + other.key, 'A character is declared in different places at the same story time: ' + shared.join(', '), ref, true));
    }
    const inheritedKeys = new Set((Array.isArray(scene.storyAfter) ? scene.storyAfter : []).flatMap(previous => [...ancestorKeys(nodes, previous)]));
    for (const key of inheritedKeys) if (priorValues(nodes, scene, key).size > 1) issues.push(issue('branch-ambiguity', scene.key + '-' + key, 'Earlier story paths disagree when they meet here.', ref, true));
    if (!(Array.isArray(scene.causedBy) ? scene.causedBy : []).length && !scene.originReason?.trim()) issues.push(issue('causal-origin', scene.key, 'Give a cause or explain this narrative origin.', ref, true));
    for (const cause of Array.isArray(scene.causedBy) ? scene.causedBy : []) if (nodes.has(cause) && !reachable(nodes, scene.key, cause, 'storyAfter')) issues.push(issue('causal-order', scene.key + '-' + cause, 'Cause is not earlier in declared story order.', ref, true));
    const transitionKeys = new Set();
    for (const change of Array.isArray(scene.stateChanges) ? scene.stateChanges : []) {
      const key = changedKey(change);
      if (!change.entity || !idPattern.test(change.field || '') || !change.from?.trim() || !change.to?.trim() || transitionKeys.has(key) || !projectFile(cwd, change.entity)) issues.push(issue('state-transition', scene.key + '-' + key, 'State transition is incomplete, duplicated, or its entity is missing.', ref));
      transitionKeys.add(key);
      const prior = priorValues(nodes, scene, key);
      if (prior.size > 1) issues.push(issue('state-ambiguity', scene.key + '-' + key, 'Earlier story paths disagree on this state.', ref, true));
      else if (prior.size === 1 && !prior.has(change.from)) issues.push(issue('state-conflict', scene.key + '-' + key, 'Declared prior state differs from the last story state.', ref, true));
    }
    for (const change of Array.isArray(scene.knowledgeChanges) ? scene.knowledgeChanges : []) {
      const key = 'knowledge/' + change.character + '/' + change.claim;
      if (!idPattern.test(change.character || '') || !/^storyspec\/claims\/(fact|knowledge|clue|event)\/[a-z0-9-]+\.md$/.test(change.claim || '') ||
          !epistemic.has(change.from) || !epistemic.has(change.to) || transitionKeys.has(key) || !existsSync(join(root, 'characters', change.character + '.md')) ||
          removedClaims.has(change.claim) || (!projectFile(cwd, change.claim) && !existsSync(join(dir, 'claims', change.claim?.split('/')[2], change.claim?.split('/')[3] || '')))) {
        issues.push(issue('knowledge-transition', scene.key + '-' + key, 'Knowledge transition is incomplete, duplicated, or references a missing character or claim.', ref));
      }
      transitionKeys.add(key);
      const prior = priorValues(nodes, scene, key);
      if (prior.size > 1) issues.push(issue('knowledge-ambiguity', scene.key + '-' + key, 'Earlier story paths disagree on this knowledge state.', ref, true));
      else if (prior.size === 1 && !prior.has(change.from)) issues.push(issue('knowledge-conflict', scene.key + '-' + key, 'Declared prior knowledge differs from the last story state.', ref, true));
    }
  }
  if (info.type === 'chapter') for (const file of readdirSync(join(dir, 'scenes')).filter(name => name.endsWith('.md'))) {
    const sceneId = file.slice(0, -3);
    if (!seenScenes.has(sceneId)) issues.push(issue('scene-map', sceneId, 'Chapter scene is absent from the narrative map.', relative(cwd, mapPath)));
  }

  const expected = requirements(dir), covered = new Set(), acceptedPath = join(dir, 'decisions', 'manuscript.json');
  const accepted = existsSync(acceptedPath) ? json(acceptedPath) : null;
  for (const entry of map.coverage) {
    const key = entry.domain + '/' + entry.requirement, ref = relative(cwd, mapPath) + '#coverage/' + key;
    if (!expected.some(item => item.domain === entry.domain && item.requirement === entry.requirement) || covered.has(key)) issues.push(issue('coverage-reference', key, 'Coverage must refer to one changed requirement exactly once.', ref));
    covered.add(key);
    if (!['realized', 'partial', 'deferred'].includes(entry.status)) issues.push(issue('coverage-status', key, 'Coverage status is invalid.', ref));
    if (entry.status === 'deferred' || entry.status === 'partial') {
      if (!entry.defer?.target?.trim() || !entry.defer?.reason?.trim()) issues.push(issue('deferral', key, 'Deferral needs a target and reason.', ref));
    }
    if (entry.status === 'realized' || entry.status === 'partial') {
      if (!['chapter', 'revision'].includes(info.type)) issues.push(issue('coverage-manuscript', key, 'This change has no manuscript for realized coverage.', ref));
      if (map.version === 2 && (!Array.isArray(entry.links) || !entry.links.length || entry.links.some(link => !seenScenes.has(link.scene)))) issues.push(issue('coverage-scene', key, 'Coverage needs a linked scene from this change.', ref));
      if (map.version === 1 && (!Array.isArray(entry.scenes) || !entry.scenes.length || entry.scenes.some(sceneId => !seenScenes.has(sceneId)))) issues.push(issue('coverage-scene', key, 'Coverage needs a scene from this change.', ref));
      const passages = map.version === 2 ? (Array.isArray(entry.links) ? entry.links.map(link => link.passage) : []) : entry.passages;
      if (!Array.isArray(passages) || !passages.length || passages.some(passage => !passage)) issues.push(issue('coverage-passage', key, 'Coverage needs a passage from the accepted manuscript.', ref));
      for (const passage of Array.isArray(passages) ? passages.filter(Boolean) : []) {
        const file = accepted && projectFile(cwd, accepted.path);
        if (!accepted || !file || passage.path !== accepted.path || passage.hash !== accepted.hash || !Number.isInteger(passage.startLine) || !Number.isInteger(passage.endLine) || passage.startLine < 1 || passage.endLine < passage.startLine) {
          issues.push(issue('passage-reference', key, 'Passage must cite the accepted file, hash, and valid line range.', ref));
          continue;
        }
        const lines = read(file).replace(/\r\n/g, '\n').split('\n');
        if (hash(readFileSync(file)) !== accepted.hash || passage.endLine > lines.length || !lines.slice(passage.startLine - 1, passage.endLine).some(line => line.trim())) issues.push(issue('passage-content', key, 'Passage is outside or empty in the accepted manuscript.', ref));
      }
    }
  }
  for (const entry of expected) {
    const key = entry.domain + '/' + entry.requirement;
    if (!covered.has(key)) issues.push(issue('coverage-missing', key, 'Changed requirement has no coverage or justified deferral.', relative(cwd, mapPath)));
  }
  const waiverIds = new Set();
  for (const waiver of map.waivers) {
    if (!waiver.issueId || !waiver.author?.trim() || !waiver.reason?.trim() || waiverIds.has(waiver.issueId) || !issues.some(item => item.id === waiver.issueId && item.waivable)) issues.push(issue('waiver', waiver.issueId || 'unknown', 'Waiver must name one current narrative finding, author, and reason.', relative(cwd, mapPath)));
    waiverIds.add(waiver.issueId);
  }
  for (const item of issues) item.waived = item.waivable && waiverIds.has(item.id);
  if (info.language === 'pt-BR') for (const item of issues) item.message = portugueseIssues[item.id.split(':')[0]] || item.message;
  const report = { change: id, version: map.version, issues, summary: { scenes: proposed.length, requirements: expected.length, blockers: issues.filter(item => item.severity === 'BLOCKER' && !item.waived).length } };
  const deltaFiles = existsSync(join(dir, 'specs')) ? readdirSync(join(dir, 'specs'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, 'specs', entry.name, 'spec.md')).filter(existsSync) : [];
  const inputs = { map: hash(readFileSync(mapPath)), index: existsSync(join(root, 'narrative-state.json')) ? hash(readFileSync(join(root, 'narrative-state.json'))) : null,
    manuscript: accepted ? hash(readFileSync(acceptedPath)) : null,
    deltas: Object.fromEntries(deltaFiles.sort().map(path => [relative(cwd, path), hash(readFileSync(path))])) };
  return { report, inputs, after: narrativeAfter(root, id, dir) };
}
