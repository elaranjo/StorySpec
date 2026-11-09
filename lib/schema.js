import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';

const ids = new Set(['proposal', 'specs', 'design', 'tasks', 'chapter-contract', 'scenes', 'draft', 'map', 'manuscript', 'verification', 'dramaturgy', 'continuity', 'prose', 'final', 'apply', 'archive']);
const types = new Set(['chapter', 'revision', 'world', 'character', 'plot']);
const stages = new Set(['plan', 'final']);
const safeId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function defaultSchema(profile = 'generic') {
  return { version: 1, profile, artifacts: [
    { id: 'proposal', requires: [] }, { id: 'specs', requires: ['proposal'] },
    { id: 'design', requires: ['proposal'] }, { id: 'tasks', requires: ['specs', 'design'] },
    { id: 'map', requires: ['specs'] }, { id: 'manuscript', requires: ['design', 'specs'], types: ['chapter', 'revision'] },
    { id: 'verification', requires: ['map', 'manuscript'] },
    { id: 'dramaturgy', requires: ['verification'] }, { id: 'continuity', requires: ['verification'] },
    { id: 'prose', requires: ['verification'], types: ['chapter', 'revision'] },
    { id: 'final', requires: ['tasks', 'dramaturgy', 'continuity', 'prose'] },
    { id: 'apply', requires: ['final'] }, { id: 'archive', requires: ['apply'] },
  ] };
}
export function schemaPath(root) { return join(root, 'schema.json'); }
export function loadSchema(root, profile = 'generic') {
  const path = schemaPath(root);
  const schema = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : defaultSchema(profile);
  validateSchema(schema);
  return schema;
}
export function writeDefaultSchema(root, profile) { writeFileSync(schemaPath(root), JSON.stringify(defaultSchema(profile), null, 2) + '\n'); }
export function customArtifacts(schema, type, stage) {
  return schema.artifacts.filter(item => item.path && item.stage === stage && (!item.types || item.types.includes(type)));
}
export function validateSchema(schema) {
  if (schema?.version !== 1 || !Array.isArray(schema.artifacts) || !schema.artifacts.length) throw new Error('Invalid workflow schema version or artifacts.');
  const found = new Map();
  for (const item of schema.artifacts) {
    if (!safeId.test(item.id || '') || found.has(item.id) || !Array.isArray(item.requires)) throw new Error('Invalid or duplicate schema artifact: ' + item.id);
    if (item.types && (!Array.isArray(item.types) || item.types.some(type => !types.has(type)))) throw new Error('Invalid schema artifact types: ' + item.id);
    if (item.path) {
      if (ids.has(item.id) || !stages.has(item.stage) || isAbsolute(item.path) || item.path.includes('\\') || !/^extras\/[a-z0-9][a-z0-9/-]*\.md$/.test(item.path) || /(^|\/)\.\.?($|\/)/.test(item.path) || typeof item.template !== 'string' || !item.template.trim() || !Array.isArray(item.requiredHeadings || []) || (item.requiredHeadings || []).some(heading => typeof heading !== 'string' || !heading.trim())) throw new Error('Invalid custom schema artifact: ' + item.id);
    } else if (!ids.has(item.id)) throw new Error('Custom schema artifact requires path: ' + item.id);
    found.set(item.id, item);
  }
  for (const id of ids) if (!found.has(id) && id !== 'chapter-contract' && id !== 'scenes' && id !== 'draft') throw new Error('Required core schema artifact missing: ' + id);
  const visiting = new Set(), done = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error('Schema dependency cycle: ' + id);
    if (done.has(id)) return;
    const item = found.get(id);
    if (!item) throw new Error('Unknown schema dependency: ' + id);
    visiting.add(id);
    for (const dep of item.requires) visit(dep);
    visiting.delete(id); done.add(id);
  };
  for (const id of found.keys()) visit(id);
  for (const item of schema.artifacts.filter(item => item.path)) {
    if (item.stage === 'plan' && item.requires.some(dep => ['manuscript', 'verification', 'dramaturgy', 'continuity', 'prose', 'final', 'apply', 'archive'].includes(dep))) throw new Error('Plan artifact depends on a later stage: ' + item.id);
    const target = resolve('/tmp/storyspec-schema', item.path);
    if (relative('/tmp/storyspec-schema', target).startsWith('..' + sep)) throw new Error('Schema path escapes change: ' + item.path);
  }
  return schema;
}
