import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('bin/storyspec.js');
function project(t, language = 'en', profile = 'generic') {
  const cwd = mkdtempSync(join(tmpdir(), 'storyspec-flow-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const file = ref => join(cwd, ref);
  const read = ref => readFileSync(file(ref), 'utf8');
  const put = (ref, body) => writeFileSync(file(ref), body);
  const ok = (...args) => { const result = run(args); assert.equal(result.status, 0, result.stderr); return result; };
  ok('init', 'Example', '--lang', language, '--profile', profile);
  return { cwd, run, file, read, put, ok };
}
function prepare(p, id, domain, req = 'central-conflict') {
  const dir = 'storyspec/changes/' + id + '/';
  p.put(dir + 'proposal.md', p.read(dir + 'proposal.md').replaceAll('<fill in>', 'A causal change.').replaceAll('<preencher>', 'Uma mudança causal.'));
  p.put(dir + 'design.md', p.read(dir + 'design.md').replaceAll('<fill in>', 'Introduce and resolve the tension.').replaceAll('<preencher>', 'Introduzir e resolver a tensão.'));
  p.ok('new', 'delta', id, domain);
  p.put(dir + 'specs/' + domain + '/spec.md', '# Delta: ' + domain + '\n\n## ADDED\n\n### Requirement: ' + req + '\nScope: volume\nStatus: PLANNED\nStatement: A choice causes a visible consequence.\nVerification: Review the chapter ending.\nSources:\nClaims:\n\n## MODIFIED\n\n## REMOVED\n');
  const map = JSON.parse(p.read(dir + 'narrative-map.json'));
  map.coverage.push({ domain, requirement: req, status: 'deferred', defer: { target: 'future-volume', reason: 'Planned for a later manuscript.' } });
  p.put(dir + 'narrative-map.json', JSON.stringify(map, null, 2));
  return dir;
}
function recordVerify(p, id) { p.ok('verify', id, '--record'); }
function completeReviews(p, id, passes) {
  for (const pass of passes) {
    const path = 'storyspec/changes/' + id + '/reviews/' + pass + '.json';
    p.ok('review', id, pass);
    p.put(path, JSON.stringify({ pass, verdict: 'PASS', summary: 'Reviewed by a person.', evidence: ['storyspec/changes/' + id + '/proposal.md'], findings: [], waivers: [] }, null, 2));
    p.ok('review', id, pass, '--record', '--author', 'Reviewer');
  }
}
function completeTasks(p, id) {
  const path = 'storyspec/changes/' + id + '/tasks.md';
  p.put(path, p.read(path).replaceAll('- [ ]', '- [x]'));
}
function fillChapter(p, id, language = 'en') {
  p.ok('new', 'scene', id, 'opening');
  const mapPath = 'storyspec/changes/' + id + '/narrative-map.json';
  const map = JSON.parse(p.read(mapPath));
  map.scenes[0].narrativeOrder = 1; map.scenes[0].originReason = 'Opening of the story.';
  p.put(mapPath, JSON.stringify(map, null, 2));
  for (const ref of ['chapter-contract.md', 'scenes/opening.md']) {
    const path = 'storyspec/changes/' + id + '/' + ref;
    p.put(path, p.read(path).replaceAll(language === 'en' ? '<fill in>' : '<preencher>', 'Defined.').replace('- Defined.', '- storyspec/style/guide.md'));
  }
}

test('new project completes a multi-domain non-manuscript cycle and keeps history', t => {
  const p = project(t, 'en', 'light-novel');
  p.ok('new', 'change', 'arc-one', '--type', 'plot');
  prepare(p, 'arc-one', 'plot');
  prepare(p, 'arc-one', 'characters', 'changed-loyalty');
  assert.match(p.read('storyspec/changes/arc-one/design.md'), /Visual beats \(optional\)/);
  assert.equal(p.run(['approve', 'arc-one', 'plan', '--author', 'Author']).status, 0);
  assert.equal(JSON.parse(p.read('storyspec/changes/arc-one/decisions/plan.json')).inputs.base['storyspec/specs/plot/spec.md'], null);
  completeTasks(p, 'arc-one');
  completeReviews(p, 'arc-one', ['dramaturgy', 'continuity']);
  p.put('evidence.md', '# Evidence\n\nOriginal observation.\n');
  const reviewPath = 'storyspec/changes/arc-one/reviews/continuity.json';
  const report = JSON.parse(p.read(reviewPath));
  report.evidence = ['evidence.md'];
  p.put(reviewPath, JSON.stringify(report, null, 2));
  p.ok('review', 'arc-one', 'continuity', '--record', '--author', 'Reviewer');
  const sourceSnapshot = JSON.parse(p.read('storyspec/changes/arc-one/reviews/continuity.receipt.json')).snapshots['evidence.md'];
  p.put('evidence.md', '# Evidence\n\nChanged observation.\n');
  assert.match(p.run(['approve', 'arc-one', 'final', '--author', 'Author']).stderr, /Review evidence changed/);
  p.put('evidence.md', '# Evidence\n\nOriginal observation.\n');
  recordVerify(p, 'arc-one');
  p.ok('approve', 'arc-one', 'final', '--author', 'Author');
  assert.equal(JSON.parse(p.ok('apply', 'arc-one', '--dry-run').stdout).length, 3);
  p.ok('apply', 'arc-one');
  assert.match(p.read('storyspec/specs/plot/spec.md'), /Origin: arc-one/);
  assert.match(p.read('storyspec/specs/characters/spec.md'), /changed-loyalty/);
  const tasks = p.read('storyspec/changes/arc-one/tasks.md');
  p.put('storyspec/changes/arc-one/tasks.md', tasks + '\nChanged after approval.\n');
  assert.match(p.run(['archive', 'arc-one']).stderr, /Approved artifacts changed/);
  p.put('storyspec/changes/arc-one/tasks.md', tasks);
  p.put('evidence.md', '# Evidence\n\nLater observation.\n');
  const archive = JSON.parse(p.ok('archive', 'arc-one').stdout).path;
  assert.ok(existsSync(p.file(archive + '/decisions/final.json')));
  assert.equal(p.read(sourceSnapshot), '# Evidence\n\nOriginal observation.\n');
  assert.match(p.ok('status').stdout, /arc-one: ARCHIVED/);
  const archivedHistory = JSON.parse(p.ok('history', 'arc-one').stdout);
  assert.equal(archivedHistory.path, 'storyspec/changes/arc-one');
  assert.equal(archivedHistory.verified, true);
  assert.ok(existsSync(p.file('storyspec/changes/arc-one/proposal.md')));
  assert.equal(p.run(['archive', 'arc-one']).status, 1);
  assert.equal(p.run(['new', 'delta', 'arc-one', 'another-domain']).status, 1);
  const archivedProposal = p.read('storyspec/changes/arc-one/proposal.md');
  p.put('storyspec/changes/arc-one/proposal.md', archivedProposal + '\nTampered.\n');
  assert.equal(JSON.parse(p.ok('history', 'arc-one').stdout).verified, false);
});

test('chapter requires plan, human reviews, final approval, accepted manuscript and recovery', t => {
  const p = project(t, 'pt-BR', 'novel');
  p.ok('new', 'chapter', 'capitulo-um');
  fillChapter(p, 'capitulo-um', 'pt-BR');
  prepare(p, 'capitulo-um', 'trama');
  assert.match(p.run(['context', 'capitulo-um', '--purpose', 'write']).stderr, /aprovação do plano/);
  p.ok('approve', 'capitulo-um', 'plan', '--author', 'Autora');
  assert.equal(p.run(['context', 'capitulo-um', '--purpose', 'write']).status, 0);
  p.put('storyspec/changes/capitulo-um/draft.md', '# Rascunho\n\nUma cena escrita.\n');
  completeTasks(p, 'capitulo-um');
  completeReviews(p, 'capitulo-um', ['dramaturgy', 'continuity', 'prose']);
  assert.equal(p.run(['verify', 'capitulo-um', '--record']).status, 1);
  p.put('manuscript/capitulo-um.md', '# Capítulo um\n\nTexto aceito.\n');
  p.ok('manuscript', 'accept', 'capitulo-um', 'manuscript/capitulo-um.md', '--author', 'Autora');
  recordVerify(p, 'capitulo-um');
  p.ok('approve', 'capitulo-um', 'final', '--author', 'Autora');
  const interrupted = p.run(['apply', 'capitulo-um'], { STORYSPEC_INTERRUPT_AFTER: '2' });
  assert.equal(interrupted.status, 1);
  assert.ok(existsSync(p.file('storyspec/narrative-state.json')));
  assert.equal(p.run(['apply', 'capitulo-um']).status, 1);
  assert.equal(JSON.parse(p.ok('apply', '--recover', 'capitulo-um').stdout).action, 'rolled-back');
  assert.equal(existsSync(p.file('storyspec/narrative-state.json')), false);
  p.ok('apply', 'capitulo-um');
  p.ok('archive', 'capitulo-um');
  assert.equal(p.read('manuscript/capitulo-um.md'), '# Capítulo um\n\nTexto aceito.\n');
});

test('revision recovers a committed application receipt after interruption', t => {
  const p = project(t);
  p.ok('new', 'change', 'revise-ending', '--type', 'revision');
  prepare(p, 'revise-ending', 'plot');
  p.ok('approve', 'revise-ending', 'plan', '--author', 'Author');
  p.put('storyspec/changes/revise-ending/draft.md', '# Revised draft\n\nA stronger ending.\n');
  completeTasks(p, 'revise-ending');
  completeReviews(p, 'revise-ending', ['dramaturgy', 'continuity', 'prose']);
  p.put('manuscript/ending.md', '# Ending\n\nAccepted version.\n');
  p.ok('manuscript', 'accept', 'revise-ending', 'manuscript/ending.md', '--author', 'Author');
  recordVerify(p, 'revise-ending');
  p.ok('approve', 'revise-ending', 'final', '--author', 'Author');
  assert.match(p.run(['apply', 'revise-ending'], { STORYSPEC_INTERRUPT_AFTER: 'state' }).stderr, /Simulated interruption/);
  assert.equal(JSON.parse(p.read('storyspec/state.json')).revision, 1);
  assert.equal(JSON.parse(p.ok('apply', '--recover', 'revise-ending').stdout).action, 'completed');
  assert.ok(existsSync(p.file('storyspec/changes/revise-ending/applied.json')));
  p.ok('archive', 'revise-ending');
  assert.match(p.ok('status').stdout, /revise-ending: ARCHIVED/);
});

test('editing approved content and unresolved findings block application', t => {
  const p = project(t);
  p.ok('new', 'change', 'rule-one', '--type', 'world');
  const dir = prepare(p, 'rule-one', 'world');
  p.ok('approve', 'rule-one', 'plan', '--author', 'Author');
  p.put(dir + 'design.md', p.read(dir + 'design.md') + '\nNew decision.\n');
  assert.match(p.ok('status').stdout, /STALE_PLAN_APPROVAL/);
  assert.match(p.run(['review', 'rule-one', 'continuity', '--record', '--author', 'Reviewer']).stderr, /stale/i);
  p.ok('approve', 'rule-one', 'plan', '--author', 'Author');
  completeTasks(p, 'rule-one');
  completeReviews(p, 'rule-one', ['dramaturgy', 'continuity']);
  const path = dir + 'reviews/continuity.json';
  const report = JSON.parse(p.read(path));
  report.verdict = 'BLOCK'; report.findings = [{ id: 'chronology', severity: 'BLOCKER', text: 'Time conflict', evidence: [] }];
  p.put(path, JSON.stringify(report, null, 2));
  p.ok('review', 'rule-one', 'continuity', '--record', '--author', 'Reviewer');
  assert.match(p.run(['approve', 'rule-one', 'final', '--author', 'Author']).stderr, /Unresolved blocking finding/);
  report.waivers = [{ findingId: 'chronology', author: 'Author', reason: 'Intentional ambiguity.' }];
  p.put(path, JSON.stringify(report, null, 2));
  p.ok('review', 'rule-one', 'continuity', '--record', '--author', 'Reviewer');
  recordVerify(p, 'rule-one');
  p.ok('approve', 'rule-one', 'final', '--author', 'Author');
  p.put(dir + 'tasks.md', p.read(dir + 'tasks.md') + '\nAdditional task context.\n');
  assert.match(p.ok('status').stdout, /STALE_FINAL_APPROVAL/);
  assert.match(p.run(['apply', 'rule-one']).stderr, /stale/i);
});

test('plan approval binds touched base and cited sources, not unrelated domains', t => {
  const p = project(t);
  p.ok('new', 'change', 'foundation', '--type', 'world');
  prepare(p, 'foundation', 'world');
  p.ok('approve', 'foundation', 'plan', '--author', 'Author');
  completeTasks(p, 'foundation'); completeReviews(p, 'foundation', ['dramaturgy', 'continuity']);
  recordVerify(p, 'foundation');
  p.ok('approve', 'foundation', 'final', '--author', 'Author');
  p.ok('apply', 'foundation'); p.ok('archive', 'foundation');

  p.put('notes.md', '# Notes\n\nAn imported source.\n');
  const imported = JSON.parse(p.ok('import', 'markdown', 'notes.md', '--id', 'notes').stdout);
  p.ok('new', 'chapter', 'next-chapter'); fillChapter(p, 'next-chapter');
  const dir = prepare(p, 'next-chapter', 'world');
  p.put(dir + 'specs/world/spec.md', '# Delta: world\n\n## ADDED\n\n## MODIFIED\n\n### Requirement: central-conflict\nScope: series\nStatus: CANON\nStatement: A more specific consequence.\nVerification: Check the ending.\nSources:\n- storyspec/style/guide.md\nClaims:\n\n## REMOVED\n');
  p.put(dir + 'proposal.md', p.read(dir + 'proposal.md') + '\n- storyspec/style/guide.md\n');
  p.put(dir + 'design.md', p.read(dir + 'design.md').replace('## Sources\n\n', '## Sources\n\n- ' + imported.path + '\n'));
  p.ok('approve', 'next-chapter', 'plan', '--author', 'Author');
  const plan = JSON.parse(p.read(dir + 'decisions/plan.json'));
  assert.equal(plan.inputs.base['storyspec/specs/world/spec.md'].length, 64);
  assert.ok(plan.inputs.sources[imported.path]);
  assert.ok(plan.inputs.sources['storyspec/style/guide.md']);
  const snapshot = plan.snapshots[imported.path], originalSnapshot = p.read(snapshot);
  const base = p.read('storyspec/specs/world/spec.md');
  p.put('storyspec/specs/world/spec.md', base + '\nChanged base.\n');
  assert.match(p.run(['context', 'next-chapter', '--purpose', 'write']).stderr, /storyspec\/specs\/world\/spec\.md/);
  p.put('storyspec/specs/world/spec.md', base);
  const style = p.read('storyspec/style/guide.md');
  p.put('storyspec/style/guide.md', style + '\nChanged source.\n');
  assert.match(p.run(['context', 'next-chapter', '--purpose', 'write']).stderr, /storyspec\/style\/guide\.md/);
  p.put('storyspec/style/guide.md', style);
  p.put(snapshot, originalSnapshot + '\nCorrupted copy.\n');
  assert.match(p.run(['context', 'next-chapter', '--purpose', 'write']).stderr, /evidence snapshot/);
  p.put(snapshot, originalSnapshot);

  p.ok('new', 'change', 'parallel-change', '--type', 'plot');
  prepare(p, 'parallel-change', 'plot');
  p.ok('approve', 'parallel-change', 'plan', '--author', 'Author');
  completeTasks(p, 'parallel-change'); completeReviews(p, 'parallel-change', ['dramaturgy', 'continuity']);
  recordVerify(p, 'parallel-change');
  p.ok('approve', 'parallel-change', 'final', '--author', 'Author');
  p.ok('apply', 'parallel-change');
  assert.match(p.ok('status').stdout, /next-chapter: PLAN_APPROVED/);
  p.ok('context', 'next-chapter', '--purpose', 'write');
  completeTasks(p, 'next-chapter');
  completeReviews(p, 'next-chapter', ['dramaturgy', 'continuity', 'prose']);
  p.put('storyspec/style/guide.md', style + '\nChanged source again.\n');
  assert.match(p.run(['approve', 'next-chapter', 'final', '--author', 'Author']).stderr, /storyspec\/style\/guide\.md/);
  p.put('storyspec/style/guide.md', style);
  p.put('manuscript/next-chapter.md', '# Chapter\n\nAccepted prose.\n');
  p.ok('manuscript', 'accept', 'next-chapter', 'manuscript/next-chapter.md', '--author', 'Author');
  recordVerify(p, 'next-chapter');
  p.ok('approve', 'next-chapter', 'final', '--author', 'Author');
  p.put('storyspec/style/guide.md', style + '\nChanged after final approval.\n');
  assert.match(p.run(['apply', 'next-chapter', '--dry-run']).stderr, /storyspec\/style\/guide\.md/);
  assert.match(p.run(['apply', 'next-chapter']).stderr, /storyspec\/style\/guide\.md/);
  p.put('storyspec/style/guide.md', style);
  p.ok('apply', 'next-chapter', '--dry-run');
  p.ok('apply', 'next-chapter');
  p.put('storyspec/style/guide.md', style + '\nLater editing is allowed.\n');
  p.ok('archive', 'next-chapter');
});

test('migration requires one-time baseline ratification and preserves old files', t => {
  const p = project(t);
  const configPath = 'storyspec/config.json';
  const old = JSON.parse(p.read(configPath)); old.formatVersion = 3; delete old.profile;
  p.put(configPath, JSON.stringify(old, null, 2) + '\n');
  rmSync(p.file('storyspec/state.json'));
  p.put('storyspec/canon/facts/origin.md', '---\nstoryspec: 3\nstatus: CANON\n---\n\n# Origin\n');
  const original = p.read('storyspec/canon/facts/origin.md');
  p.ok('migrate');
  assert.equal(p.read('storyspec/canon/facts/origin.md'), original);
  p.ok('new', 'change', 'legacy-update', '--type', 'world');
  prepare(p, 'legacy-update', 'world');
  p.ok('approve', 'legacy-update', 'plan', '--author', 'Author');
  completeTasks(p, 'legacy-update');
  completeReviews(p, 'legacy-update', ['dramaturgy', 'continuity']);
  recordVerify(p, 'legacy-update');
  p.ok('approve', 'legacy-update', 'final', '--author', 'Author');
  assert.match(p.run(['apply', 'legacy-update']).stderr, /Baseline ratification required/);
  p.ok('baseline', 'approve', '--author', 'Author');
  p.ok('apply', 'legacy-update');
  assert.equal(p.read('storyspec/canon/facts/origin.md'), original);
});

test('claim deltas, MODIFIED and REMOVED retain traceable current state', t => {
  const p = project(t);
  p.ok('new', 'change', 'first-law', '--type', 'world');
  const dir = prepare(p, 'first-law', 'magic', 'magic-cost');
  p.ok('new', 'delta', 'first-law', 'obsolete');
  p.put(dir + 'specs/obsolete/spec.md', '# Delta: obsolete\n\n## ADDED\n\n### Requirement: old-rule\nScope: series\nStatus: OPEN\nStatement: Old rule.\nVerification: Check the outline.\nSources:\nClaims:\n\n## MODIFIED\n\n## REMOVED\n');
  const firstMap = JSON.parse(p.read(dir + 'narrative-map.json'));
  firstMap.coverage.push({ domain: 'obsolete', requirement: 'old-rule', status: 'deferred', defer: { target: 'future-volume', reason: 'Old rule remains planned.' } });
  p.put(dir + 'narrative-map.json', JSON.stringify(firstMap, null, 2));
  p.ok('new', 'claim-delta', 'first-law', 'fact', 'magic-cost', '--operation', 'ADDED');
  const claim = dir + 'claims/fact/magic-cost.md';
  p.put(claim, p.read(claim).replace('status: DRAFT', 'status: CANON').replace('<fill in>', 'Magic always has a cost.').replace('- <fill in>', '- storyspec/style/guide.md'));
  p.put(dir + 'specs/magic/spec.md', p.read(dir + 'specs/magic/spec.md').replace('Claims:\n', 'Claims:\n- storyspec/claims/fact/magic-cost.md\n'));
  p.ok('approve', 'first-law', 'plan', '--author', 'Author');
  assert.ok(JSON.parse(p.read(dir + 'decisions/plan.json')).inputs.sources['storyspec/style/guide.md']);
  completeTasks(p, 'first-law'); completeReviews(p, 'first-law', ['dramaturgy', 'continuity']);
  recordVerify(p, 'first-law');
  p.ok('approve', 'first-law', 'final', '--author', 'Author');
  p.ok('apply', 'first-law'); p.ok('archive', 'first-law');
  assert.match(p.read('storyspec/claims/fact/magic-cost.md'), /status: CANON/);
  assert.match(p.read('storyspec/claims/fact/magic-cost.md'), /originChange: first-law/);
  p.ok('new', 'change', 'second-law', '--type', 'world');
  const second = 'storyspec/changes/second-law/';
  p.put(second + 'proposal.md', p.read(second + 'proposal.md').replaceAll('<fill in>', 'Revise the law.'));
  p.put(second + 'design.md', p.read(second + 'design.md').replaceAll('<fill in>', 'Tighten the cost.'));
  p.ok('new', 'delta', 'second-law', 'magic');
  p.put(second + 'specs/magic/spec.md', '# Delta: magic\n\n## ADDED\n\n## MODIFIED\n\n### Requirement: magic-cost\nScope: series\nStatus: CANON\nStatement: Every spell costs a memory.\nVerification: Check each spell scene.\nSources:\nClaims:\n- storyspec/claims/fact/magic-cost.md\n\n## REMOVED\n');
  p.ok('new', 'delta', 'second-law', 'obsolete');
  p.put(second + 'specs/obsolete/spec.md', '# Delta: obsolete\n\n## ADDED\n\n## MODIFIED\n\n## REMOVED\n\n### Requirement: old-rule\nReason: Superseded by magic-cost.\n');
  const secondMap = JSON.parse(p.read(second + 'narrative-map.json'));
  secondMap.coverage.push({ domain: 'magic', requirement: 'magic-cost', status: 'deferred', defer: { target: 'future-volume', reason: 'Revised law is planned.' } });
  p.put(second + 'narrative-map.json', JSON.stringify(secondMap, null, 2));
  p.ok('approve', 'second-law', 'plan', '--author', 'Author');
  p.ok('new', 'claim-delta', 'second-law', 'fact', 'magic-cost', '--operation', 'MODIFIED');
  p.ok('approve', 'second-law', 'plan', '--author', 'Author');
  completeTasks(p, 'second-law'); completeReviews(p, 'second-law', ['dramaturgy', 'continuity']);
  recordVerify(p, 'second-law');
  p.ok('approve', 'second-law', 'final', '--author', 'Author');
  const currentClaim = p.read('storyspec/claims/fact/magic-cost.md');
  p.put('storyspec/claims/fact/magic-cost.md', currentClaim + '\nManual claim edit.\n');
  assert.match(p.ok('status').stdout, /second-law: STALE_FINAL_APPROVAL/);
  p.put('storyspec/claims/fact/magic-cost.md', currentClaim);
  p.put('storyspec/specs/magic/spec.md', p.read('storyspec/specs/magic/spec.md') + '\nManual conflict.\n');
  assert.match(p.run(['apply', 'second-law']).stderr, /baseline|state differs/i);
  p.put('storyspec/specs/magic/spec.md', p.read('storyspec/specs/magic/spec.md').replace('\nManual conflict.\n', ''));
  p.ok('apply', 'second-law');
  assert.match(p.read('storyspec/specs/magic/spec.md'), /Every spell costs a memory/);
  assert.doesNotMatch(p.read('storyspec/specs/obsolete/spec.md'), /old-rule/);

  p.ok('new', 'change', 'third-law', '--type', 'world');
  const third = 'storyspec/changes/third-law/';
  p.put(third + 'proposal.md', p.read(third + 'proposal.md').replaceAll('<fill in>', 'Remove the obsolete fact.'));
  p.put(third + 'design.md', p.read(third + 'design.md').replaceAll('<fill in>', 'Keep the requirement without the claim.'));
  p.ok('new', 'delta', 'third-law', 'magic');
  p.put(third + 'specs/magic/spec.md', '# Delta: magic\n\n## ADDED\n\n## MODIFIED\n\n### Requirement: magic-cost\nScope: series\nStatus: CANON\nStatement: Every spell costs a memory.\nVerification: Check each spell scene.\nSources:\nClaims:\n\n## REMOVED\n');
  const thirdMap = JSON.parse(p.read(third + 'narrative-map.json'));
  thirdMap.coverage.push({ domain: 'magic', requirement: 'magic-cost', status: 'deferred', defer: { target: 'future-volume', reason: 'Claim removal only.' } });
  p.put(third + 'narrative-map.json', JSON.stringify(thirdMap, null, 2));
  p.ok('new', 'claim-delta', 'third-law', 'fact', 'magic-cost', '--operation', 'REMOVED');
  p.ok('approve', 'third-law', 'plan', '--author', 'Author');
  completeTasks(p, 'third-law'); completeReviews(p, 'third-law', ['dramaturgy', 'continuity']);
  recordVerify(p, 'third-law');
  p.ok('approve', 'third-law', 'final', '--author', 'Author');
  p.ok('apply', 'third-law');
  assert.equal(existsSync(p.file('storyspec/claims/fact/magic-cost.md')), false);
  assert.doesNotMatch(p.read('storyspec/specs/magic/spec.md'), /storyspec\/claims\/fact\/magic-cost\.md/);
});

test('legacy moved archives remain locatable by change ID', t => {
  const p = project(t);
  p.ok('new', 'change', 'old-archive', '--type', 'world');
  prepare(p, 'old-archive', 'world');
  p.ok('approve', 'old-archive', 'plan', '--author', 'Author');
  completeTasks(p, 'old-archive'); completeReviews(p, 'old-archive', ['dramaturgy', 'continuity']);
  recordVerify(p, 'old-archive');
  p.ok('approve', 'old-archive', 'final', '--author', 'Author');
  p.ok('apply', 'old-archive');
  renameSync(p.file('storyspec/changes/old-archive'), p.file('storyspec/changes/archive/2026-11-09-old-archive'));
  const found = JSON.parse(p.ok('history', 'old-archive').stdout);
  assert.equal(found.legacyMoved, true);
  assert.equal(found.path, 'storyspec/changes/archive/2026-11-09-old-archive');
  assert.equal(p.run(['new', 'change', 'old-archive', '--type', 'world']).status, 1);
});
