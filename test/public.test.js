import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('bin/storyspec.js');
test('all four teaching projects remain archived and auditable', () => {
  for (const folder of ['novel-en', 'novel-pt', 'light-novel-en', 'light-novel-pt']) {
    const cwd = resolve('examples', folder);
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    const status = JSON.parse(run('status', 'opening', '--json').stdout);
    assert.equal(status.phase, 'ARCHIVED', folder);
    const history = JSON.parse(run('history', 'opening').stdout);
    assert.equal(history.verified, true, folder);
    assert.ok(existsSync(join(cwd, 'manuscript', 'opening.md')));
  }
});

test('assistant adapters are optional, previewable, and never overwrite personal instructions', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'storyspec-adapter-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  for (const [agent, ref] of [['codex', '.agents/skills/storyspec/SKILL.md'], ['claude', '.claude/skills/storyspec/SKILL.md'], ['cursor', '.cursor/rules/storyspec.mdc']]) {
    assert.equal(JSON.parse(run('adapters', 'install', agent, '--dry-run').stdout).action, 'would-install');
    assert.equal(existsSync(join(cwd, ref)), false);
    assert.equal(JSON.parse(run('adapters', 'install', agent).stdout).action, 'installed');
    assert.match(readFileSync(join(cwd, ref), 'utf8'), /human literary assessments/);
    assert.equal(JSON.parse(run('adapters', 'install', agent).stdout).action, 'unchanged');
    writeFileSync(join(cwd, ref), 'Personal instructions\n');
    assert.equal(run('adapters', 'install', agent).status, 1);
    assert.equal(readFileSync(join(cwd, ref), 'utf8'), 'Personal instructions\n');
  }
});
