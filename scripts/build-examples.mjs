import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve('.'), cli = join(repo, 'bin/storyspec.js');
const samples = [
  { folder: 'novel-en', profile: 'novel', lang: 'en', title: 'The Bridge', prose: 'Mira crosses the bridge and leaves her map behind.', reason: 'The crossing forces a visible loss.' },
  { folder: 'novel-pt', profile: 'novel', lang: 'pt-BR', title: 'A Ponte', prose: 'Mira atravessa a ponte e deixa seu mapa para trás.', reason: 'A travessia produz uma perda visível.' },
  { folder: 'light-novel-en', profile: 'light-novel', lang: 'en', title: 'The Lantern', prose: 'The lantern flashes; Ren chooses to reveal the hidden path.', reason: 'A visual beat turns a secret into a decision.' },
  { folder: 'light-novel-pt', profile: 'light-novel', lang: 'pt-BR', title: 'A Lanterna', prose: 'A lanterna cintila; Ren decide revelar o caminho oculto.', reason: 'Um momento visual transforma um segredo em decisão.' },
];
for (const sample of samples) {
  const cwd = join(repo, 'examples', sample.folder);
  if (existsSync(cwd)) throw new Error('Example already exists: ' + cwd);
  mkdirSync(cwd, { recursive: true });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(args.join(' ') + ': ' + result.stderr + result.stdout);
    return result.stdout;
  };
  const get = ref => readFileSync(join(cwd, ref), 'utf8');
  const put = (ref, value) => writeFileSync(join(cwd, ref), value);
  run('init', sample.title, '--lang', sample.lang, '--profile', sample.profile);
  run('new', 'chapter', 'opening');
  run('new', 'scene', 'opening', 'choice');
  run('new', 'delta', 'opening', 'plot');
  const base = 'storyspec/changes/opening/';
  const placeholder = sample.lang === 'en' ? '<fill in>' : '<preencher>';
  for (const name of ['proposal.md', 'design.md', 'chapter-contract.md', 'scenes/choice.md']) {
    put(base + name, get(base + name).replaceAll(placeholder, sample.reason).replaceAll('- ' + sample.reason, '- storyspec/style/guide.md').trimEnd() + '\n');
  }
  put(base + 'draft.md', get(base + 'draft.md').trimEnd() + '\n');
  put(base + 'specs/plot/spec.md', '# Delta: plot\n\n## ADDED\n\n### Requirement: costly-choice\nScope: volume\nStatus: PLANNED\nStatement: ' + sample.reason + '\nVerification: The accepted passage shows the choice and its consequence.\nSources:\nClaims:\n\n## MODIFIED\n\n## REMOVED\n');
  run('approve', 'opening', 'plan', '--author', 'Example Author');
  put('manuscript/opening.md', '# ' + sample.title + '\n\n' + sample.prose + '\n');
  run('manuscript', 'accept', 'opening', 'manuscript/opening.md', '--author', 'Example Author');
  run('map', 'scene', 'set', 'opening', 'choice', '--order', '1', '--origin', sample.reason);
  run('map', 'coverage', 'set', 'opening', 'plot/costly-choice', '--status', 'realized');
  run('map', 'passage', 'add', 'opening', 'plot/costly-choice', '--scene', 'choice', '--lines', '3:3');
  run('verify', 'opening', '--record');
  put(base + 'tasks.md', get(base + 'tasks.md').replaceAll('- [ ]', '- [x]'));
  for (const pass of ['dramaturgy', 'continuity', 'prose']) {
    run('review', 'opening', pass);
    put(base + 'reviews/' + pass + '.json', JSON.stringify({
      pass, verdict: 'PASS', summary: sample.reason, evidence: [base + 'proposal.md'], findings: [], waivers: [],
      ...(pass === 'dramaturgy' ? { requirementAssessments: [{ domain: 'plot', requirement: 'costly-choice', verdict: 'SATISFIED', rationale: sample.reason }] } : {}),
    }, null, 2) + '\n');
    run('review', 'opening', pass, '--record', '--author', 'Example Reviewer');
  }
  run('approve', 'opening', 'final', '--author', 'Example Author');
  run('apply', 'opening', '--dry-run');
  run('apply', 'opening');
  run('archive', 'opening');
  put('README.md', '# ' + sample.title + '\n\nStorySpec ' + sample.profile + ' example (' + sample.lang + '). The completed change is `storyspec/changes/opening/`; the accepted prose is `manuscript/opening.md`.\n\nRun `storyspec status opening --json` and `storyspec history opening` to inspect the archive. For a fresh run, follow the root tutorial in `../../docs/tutorial.md`.\n');
}
