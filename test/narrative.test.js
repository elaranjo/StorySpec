import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('bin/storyspec.js');
function fixture(t, lang = 'en') {
  const cwd = mkdtempSync(join(tmpdir(), 'storyspec-narrative-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return result; };
  const read = ref => readFileSync(join(cwd, ref), 'utf8');
  const put = (ref, body) => writeFileSync(join(cwd, ref), body);
  ok('init', 'Narrative', '--lang', lang);
  return { cwd, run, ok, read, put };
}
function prep(p, id, domain, type = 'world') {
  p.ok('new', 'change', id, '--type', type);
  const dir = 'storyspec/changes/' + id + '/';
  const marker = p.read(dir + 'proposal.md').includes('<preencher>') ? '<preencher>' : '<fill in>';
  for (const name of ['proposal.md', 'design.md']) p.put(dir + name, p.read(dir + name).replaceAll(marker, 'A specified change.'));
  p.ok('new', 'delta', id, domain);
  p.put(dir + 'specs/' + domain + '/spec.md', '# Delta: ' + domain + '\n\n## ADDED\n\n### Requirement: rule\nScope: volume\nStatus: PLANNED\nStatement: A consequential choice.\nVerification: Check the scene.\nSources:\nClaims:\n\n## MODIFIED\n\n## REMOVED\n');
  const map = JSON.parse(p.read(dir + 'narrative-map.json'));
  map.coverage = [{ domain, requirement: 'rule', status: 'deferred', defer: { target: 'next-volume', reason: 'Scheduled for a future chapter.' } }];
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  return dir;
}
function chapter(p, id, domain) {
  const dir = prep(p, id, domain, 'chapter');
  p.ok('new', 'scene', id, 'opening');
  for (const name of ['chapter-contract.md', 'scenes/opening.md']) p.put(dir + name, p.read(dir + name).replaceAll('<fill in>', 'Defined.').replaceAll('<preencher>', 'Definido.').replaceAll('- Defined.', '- storyspec/style/guide.md').replaceAll('- Definido.', '- storyspec/style/guide.md'));
  const map = JSON.parse(p.read(dir + 'narrative-map.json'));
  map.scenes[0].narrativeOrder = 1; map.scenes[0].originReason = 'Story opening.';
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  return dir;
}
function finish(p, id, type = 'world') {
  const dir = 'storyspec/changes/' + id + '/';
  p.put(dir + 'tasks.md', p.read(dir + 'tasks.md').replaceAll('- [ ]', '- [x]'));
  for (const pass of type === 'chapter' ? ['dramaturgy', 'continuity', 'prose'] : ['dramaturgy', 'continuity']) {
    p.ok('review', id, pass);
    p.put(dir + 'reviews/' + pass + '.json', JSON.stringify({ pass, verdict: 'PASS', summary: 'Human review.', evidence: [dir + 'proposal.md'], findings: [], waivers: [] }));
    p.ok('review', id, pass, '--record', '--author', 'Reviewer');
  }
  p.ok('verify', id, '--record');
  p.ok('approve', id, 'final', '--author', 'Author');
}

test('guided status, accepted passages, partial coverage, and non-linear scene order', t => {
  const p = fixture(t, 'pt-BR'), dir = chapter(p, 'capitulo', 'trama');
  assert.match(JSON.parse(p.ok('status', 'capitulo', '--json').stdout).next.action, /approve capitulo plan/);
  p.ok('new', 'scene', 'capitulo', 'passado');
  p.put(dir + 'scenes/passado.md', p.read(dir + 'scenes/passado.md').replaceAll('<preencher>', 'Definido.').replaceAll('- Definido.', '- storyspec/style/guide.md'));
  const map = JSON.parse(p.read(dir + 'narrative-map.json'));
  map.scenes[0].narrativeOrder = 2;
  map.scenes[0].storyAfter = ['capitulo/passado'];
  map.scenes[0].causedBy = ['capitulo/passado'];
  map.scenes[1].narrativeOrder = 1;
  map.scenes[1].originReason = 'Memória anterior.';
  p.ok('approve', 'capitulo', 'plan', '--author', 'Autora');
  assert.match(p.ok('next', 'capitulo').stdout, /manuscript accept/);
  p.put('manuscript/capitulo.md', '# Capítulo\n\nUma escolha causa perda.\n');
  p.ok('manuscript', 'accept', 'capitulo', 'manuscript/capitulo.md', '--author', 'Autora');
  const hash = createHash('sha256').update(p.read('manuscript/capitulo.md')).digest('hex');
  map.coverage[0] = { domain: 'trama', requirement: 'rule', status: 'partial', links: [{ scene: 'opening', passage: { path: 'manuscript/capitulo.md', hash, startLine: 3, endLine: 3 } }], defer: { target: 'chapter-two', reason: 'Remaining consequence comes later.' } };
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  assert.equal(JSON.parse(p.ok('verify', 'capitulo', '--json').stdout).summary.blockers, 0);
  map.coverage[0].status = 'realized'; delete map.coverage[0].defer;
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  assert.equal(JSON.parse(p.ok('verify', 'capitulo', '--json').stdout).summary.blockers, 0);
  map.coverage[0].status = 'partial'; map.coverage[0].defer = { target: 'chapter-two', reason: 'Remaining consequence comes later.' };
  map.coverage[0].links[0].passage.endLine = 30;
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  assert.match(p.run('verify', 'capitulo', '--json').stdout, /passage-content/);
  map.coverage[0].links[0].passage.endLine = 3;
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  p.ok('verify', 'capitulo', '--record');
  p.put('manuscript/capitulo.md', '# Capítulo\n\nTexto alterado.\n');
  assert.match(p.run('verify', 'capitulo', '--json').stdout, /passage-content/);
});

test('cross-chapter knowledge conflicts and missing causes require explicit resolution', t => {
  const p = fixture(t);
  p.ok('new', 'character', 'hero');
  p.ok('new', 'claim', 'fact', 'secret');
  const first = chapter(p, 'first', 'plot');
  let map = JSON.parse(p.read(first + 'narrative-map.json'));
  map.scenes[0].knowledgeChanges = [{ character: 'hero', claim: 'storyspec/claims/fact/secret.md', from: 'UNAWARE', to: 'KNOWS' }];
  p.put(first + 'narrative-map.json', JSON.stringify(map, null, 2));
  p.ok('approve', 'first', 'plan', '--author', 'Author');
  p.put('manuscript/first.md', '# First\n\nProse.\n');
  p.ok('manuscript', 'accept', 'first', 'manuscript/first.md', '--author', 'Author');
  finish(p, 'first', 'chapter'); p.ok('apply', 'first');
  const second = chapter(p, 'second', 'world');
  map = JSON.parse(p.read(second + 'narrative-map.json'));
  map.scenes[0].originReason = '';
  map.scenes[0].storyAfter = ['first/opening'];
  map.scenes[0].knowledgeChanges = [{ character: 'hero', claim: 'storyspec/claims/fact/secret.md', from: 'UNAWARE', to: 'SUSPECTS' }];
  p.put(second + 'narrative-map.json', JSON.stringify(map, null, 2));
  const report = JSON.parse(p.run('verify', 'second', '--json').stdout);
  assert.ok(report.issues.some(item => item.id === 'causal-origin:second/opening'));
  assert.ok(report.issues.some(item => item.id.startsWith('knowledge-conflict:second/opening')));
  map.waivers = [{ issueId: 'causal-origin:second/opening', author: 'Author', reason: 'Intentional mystery.' }];
  p.put(second + 'narrative-map.json', JSON.stringify(map, null, 2));
  const waived = JSON.parse(p.run('verify', 'second', '--json').stdout);
  assert.equal(waived.issues.find(item => item.id === 'causal-origin:second/opening').waived, true);
  assert.ok(waived.summary.blockers > 0);
  map.scenes[0].knowledgeChanges[0].from = 'KNOWS';
  p.put(second + 'narrative-map.json', JSON.stringify(map, null, 2));
  assert.equal(JSON.parse(p.ok('verify', 'second', '--json').stdout).summary.blockers, 0);
  map.scenes[0].causedBy = ['missing/scene'];
  map.waivers.push({ issueId: 'scene-reference:second/opening-missing/scene', author: 'Author', reason: 'Intentional gap.' });
  p.put(second + 'narrative-map.json', JSON.stringify(map, null, 2));
  const invalid = JSON.parse(p.run('verify', 'second', '--json').stdout);
  assert.ok(invalid.issues.some(item => item.id.startsWith('scene-reference:') && !item.waived));
  assert.ok(invalid.summary.blockers > 0);
});

test('joining story branches exposes ambiguous state without a resolving transition', t => {
  const p = fixture(t);
  p.ok('new', 'character', 'hero');
  const dir = chapter(p, 'branches', 'plot');
  for (const id of ['left', 'right', 'join']) {
    p.ok('new', 'scene', 'branches', id);
    p.put(dir + 'scenes/' + id + '.md', p.read(dir + 'scenes/' + id + '.md').replaceAll('<fill in>', 'Defined.').replaceAll('- Defined.', '- storyspec/style/guide.md'));
  }
  const map = JSON.parse(p.read(dir + 'narrative-map.json'));
  const [opening, left, right, meeting] = map.scenes;
  opening.narrativeOrder = 1;
  left.narrativeOrder = 2; left.storyAfter = ['branches/opening']; left.causedBy = ['branches/opening'];
  right.narrativeOrder = 3; right.storyAfter = ['branches/opening']; right.causedBy = ['branches/opening'];
  meeting.narrativeOrder = 4; meeting.storyAfter = ['branches/left', 'branches/right']; meeting.causedBy = ['branches/left', 'branches/right'];
  opening.stateChanges = [{ entity: 'storyspec/characters/hero.md', field: 'location', from: 'home', to: 'road' }];
  left.stateChanges = [{ entity: 'storyspec/characters/hero.md', field: 'location', from: 'road', to: 'forest' }];
  right.stateChanges = [{ entity: 'storyspec/characters/hero.md', field: 'location', from: 'road', to: 'castle' }];
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  const report = JSON.parse(p.run('verify', 'branches', '--json').stdout);
  assert.ok(report.issues.some(item => item.id.startsWith('branch-ambiguity:branches/join')));
});

test('parallel application stales narrative verification while leaving unrelated plan valid', t => {
  const p = fixture(t);
  prep(p, 'later', 'plot');
  p.ok('approve', 'later', 'plan', '--author', 'Author');
  p.ok('verify', 'later', '--record');
  prep(p, 'earlier', 'world');
  p.ok('approve', 'earlier', 'plan', '--author', 'Author');
  finish(p, 'earlier'); p.ok('apply', 'earlier');
  assert.match(p.ok('status').stdout, /later: PLAN_APPROVED/);
  p.put('storyspec/changes/later/tasks.md', p.read('storyspec/changes/later/tasks.md').replaceAll('- [ ]', '- [x]'));
  for (const pass of ['dramaturgy', 'continuity']) {
    p.ok('review', 'later', pass);
    const ref = 'storyspec/changes/later/';
    p.put(ref + 'reviews/' + pass + '.json', JSON.stringify({ pass, verdict: 'PASS', summary: 'Reviewed.', evidence: [ref + 'proposal.md'], findings: [], waivers: [] }));
    p.ok('review', 'later', pass, '--record', '--author', 'Reviewer');
  }
  assert.match(p.run('approve', 'later', 'final', '--author', 'Author').stderr, /Narrative verification is stale/);
  p.ok('verify', 'later', '--record');
  p.ok('approve', 'later', 'final', '--author', 'Author');
});

test('older active change opts into the map without rewriting narrative documents', t => {
  const p = fixture(t), dir = prep(p, 'legacy', 'world');
  const info = JSON.parse(p.read(dir + 'change.json'));
  delete info.workflowVersion;
  p.put(dir + 'change.json', JSON.stringify(info, null, 2));
  rmSync(join(p.cwd, dir, 'narrative-map.json'));
  const proposal = p.read(dir + 'proposal.md');
  p.ok('approve', 'legacy', 'plan', '--author', 'Author');
  assert.equal(JSON.parse(p.ok('status', 'legacy', '--json').stdout).workflowVersion, 1);
  p.ok('map', 'init', 'legacy');
  assert.equal(p.read(dir + 'proposal.md'), proposal);
  assert.equal(JSON.parse(p.read(dir + 'change.json')).workflowVersion, 2);
  assert.match(p.ok('status').stdout, /legacy: STALE_PLAN_APPROVAL/);
  p.ok('map', 'upgrade', 'legacy');
  assert.equal(JSON.parse(p.read(dir + 'narrative-map.json')).version, 2);
  assert.equal(JSON.parse(p.read(dir + 'change.json')).workflowVersion, 3);
});

test('guided map commands bind an accepted passage to its scene and require human assessment', t => {
  const p = fixture(t), dir = chapter(p, 'guided', 'plot');
  p.ok('map', 'scene', 'set', 'guided', 'opening', '--order', '1', '--origin', 'The story begins.');
  p.ok('approve', 'guided', 'plan', '--author', 'Author');
  p.put('manuscript/guided.md', '# Guided\n\nThe choice costs a friend.\n');
  p.ok('manuscript', 'accept', 'guided', 'manuscript/guided.md', '--author', 'Author');
  p.ok('map', 'coverage', 'set', 'guided', 'plot/rule', '--status', 'realized');
  p.ok('map', 'passage', 'add', 'guided', 'plot/rule', '--scene', 'opening', '--lines', '3:3');
  const map = JSON.parse(p.read(dir + 'narrative-map.json'));
  assert.equal(map.coverage[0].links[0].scene, 'opening');
  assert.equal(map.coverage[0].links[0].passage.hash, JSON.parse(p.read(dir + 'decisions/manuscript.json')).hash);
  p.ok('verify', 'guided', '--record');
  p.put(dir + 'tasks.md', p.read(dir + 'tasks.md').replaceAll('- [ ]', '- [x]'));
  for (const pass of ['dramaturgy', 'continuity', 'prose']) {
    p.ok('review', 'guided', pass);
    const path = dir + 'reviews/' + pass + '.json';
    const report = { pass, verdict: 'PASS', summary: 'Human review.', evidence: [dir + 'proposal.md'], findings: [], waivers: [] };
    p.put(path, JSON.stringify(report));
    if (pass === 'dramaturgy') {
      assert.match(p.run('review', 'guided', pass, '--record', '--author', 'Reviewer').stderr, /assessments are incomplete/);
      report.requirementAssessments = [{ domain: 'plot', requirement: 'rule', verdict: 'SATISFIED', rationale: 'The cited choice visibly costs a friend.' }];
      p.put(path, JSON.stringify(report));
    }
    p.ok('review', 'guided', pass, '--record', '--author', 'Reviewer');
  }
  p.ok('approve', 'guided', 'final', '--author', 'Author');
  p.ok('apply', 'guided'); p.ok('archive', 'guided');
});

test('custom schema artifacts are required and schema edits stale the plan', t => {
  const p = fixture(t), schemaPath = 'storyspec/schema.json';
  const schema = JSON.parse(p.read(schemaPath));
  schema.artifacts.push({ id: 'theme-note', path: 'extras/theme.md', stage: 'plan', requires: ['proposal'], template: '# Theme\n\n## Decision\n\n<fill in>\n', requiredHeadings: ['Decision'] });
  p.put(schemaPath, JSON.stringify(schema, null, 2));
  p.ok('schema', 'validate');
  const dir = prep(p, 'theme', 'plot');
  assert.match(p.ok('next', 'theme').stdout, /extras\/theme\.md/);
  assert.match(p.run('approve', 'theme', 'plan', '--author', 'Author').stderr, /Custom artifact incomplete/);
  p.put(dir + 'extras/theme.md', '# Theme\n\n## Decision\n\nHope prevails.\n');
  p.ok('approve', 'theme', 'plan', '--author', 'Author');
  schema.artifacts.at(-1).template += '\n';
  p.put(schemaPath, JSON.stringify(schema, null, 2));
  const reconciliation = JSON.parse(p.ok('reconcile', 'theme', '--json').stdout);
  assert.match(reconciliation.stages[0].reason, /storyspec\/schema\.json/);
  schema.artifacts.find(item => item.id === 'proposal').requires = ['tasks'];
  p.put(schemaPath, JSON.stringify(schema, null, 2));
  assert.match(p.run('schema', 'validate').stderr, /cycle/);
});

test('declared simultaneous presence in different places is reported', t => {
  const p = fixture(t), dir = chapter(p, 'simultaneous', 'plot');
  p.ok('new', 'character', 'hero');
  p.ok('new', 'scene', 'simultaneous', 'elsewhere');
  p.put(dir + 'scenes/elsewhere.md', p.read(dir + 'scenes/elsewhere.md').replaceAll('<fill in>', 'Defined.').replaceAll('- Defined.', '- storyspec/style/guide.md'));
  p.ok('map', 'scene', 'set', 'simultaneous', 'opening', '--order', '1', '--time', '5', '--place', 'storyspec/style/guide.md', '--presence', 'hero');
  p.ok('map', 'scene', 'set', 'simultaneous', 'elsewhere', '--order', '2', '--time', '5', '--place', 'storyspec/characters/hero.md', '--presence', 'hero', '--origin', 'Parallel scene.');
  const report = JSON.parse(p.run('verify', 'simultaneous', '--json').stdout);
  assert.ok(report.issues.some(item => item.id.startsWith('co-presence:')));
});
