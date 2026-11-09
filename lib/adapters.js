import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const targets = {
  codex: '.agents/skills/storyspec/SKILL.md',
  claude: '.claude/skills/storyspec/SKILL.md',
  cursor: '.cursor/rules/storyspec.mdc',
};
function body(agent) {
  const contract = readFileSync(new URL('../docs/assistant-contract.md', import.meta.url), 'utf8');
  if (agent === 'cursor') return '---\ndescription: Use StorySpec to plan, verify, review, and archive narrative changes\nalwaysApply: false\n---\n\n' + contract;
  return '---\nname: storyspec\ndescription: Guide local literary specification changes with the StorySpec CLI\n---\n\n' + contract;
}
export function installAdapter(cwd, agent, dryRun = false) {
  if (!(agent in targets)) throw new Error('Adapter must be codex, claude, or cursor.');
  const target = join(cwd, targets[agent]), content = body(agent);
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') === content) return { agent, path: relative(cwd, target), action: 'unchanged' };
    throw new Error('Adapter file already exists: ' + relative(cwd, target));
  }
  if (!dryRun) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, { flag: 'wx' }); }
  return { agent, path: relative(cwd, target), action: dryRun ? 'would-install' : 'installed' };
}
