import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('bin/storyspec.js');
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'storyspec-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  const file = path => join(cwd, path);
  return { cwd, run, file };
}
function fill(path, source) {
  let body = readFileSync(path, 'utf8').replaceAll('<preencher>', 'Definido.');
  body = body.replace('- Definido.', '- ' + source);
  writeFileSync(path, body);
}
function legacy(file) {
  const configPath = file('storyspec/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.formatVersion = 3;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

test('cria registros, capítulo e cena sem sobrescrever', t => {
  const { run, file } = fixture(t);
  assert.equal(run('init', 'Romance', '--lang', 'pt-BR').status, 0);
  legacy(file);
  assert.equal(run('init', '--lang', 'pt-BR').status, 1);
  assert.equal(run('new', 'structure', 'series', 'serie-01').status, 0);
  assert.equal(run('new', 'structure', 'volume', 'volume-01').status, 0);
  assert.equal(run('new', 'fact', 'origem').status, 0);
  assert.equal(run('new', 'character', 'heroina').status, 0);
  assert.equal(run('new', 'mystery', 'segredo').status, 0);
  assert.equal(run('new', 'continuity', 'evento').status, 0);
  assert.equal(run('new', 'chapter', 'cap-01').status, 0);
  assert.equal(run('new', 'scene', 'cap-01', 'oficina').status, 0);
  assert.equal(run('new', 'scene', 'cap-01', 'oficina').status, 1);
  assert.equal(run('new', 'chapter', '../fora').status, 1);
  assert.equal(run('validate', 'cap-01').status, 1);
  fill(file('storyspec/changes/cap-01/chapter-contract.md'), 'storyspec/style/guide.md');
  fill(file('storyspec/changes/cap-01/scenes/oficina.md'), 'storyspec/canon/facts/origem.md');
  assert.equal(run('validate', 'cap-01').status, 0);
  assert.match(run('status').stdout, /contrato completo/);
});

test('contexto explicita fontes e estados e rejeita caminhos externos', t => {
  const { run, file } = fixture(t);
  run('init', '--lang', 'pt-BR');
  legacy(file);
  run('new', 'chapter', 'cap-01');
  run('new', 'scene', 'cap-01', 'oficina');
  run('new', 'fact', 'origem');
  const contract = file('storyspec/changes/cap-01/chapter-contract.md');
  const scene = file('storyspec/changes/cap-01/scenes/oficina.md');
  const fact = file('storyspec/canon/facts/origem.md');
  fill(contract, 'storyspec/style/guide.md');
  fill(scene, 'storyspec/canon/facts/origem.md');
  writeFileSync(fact, readFileSync(fact, 'utf8').replace('status: DRAFT', 'status: OPEN'));
  const result = run('context', 'cap-01', '--scene', 'oficina', '--purpose', 'write');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fonte: storyspec\/canon\/facts\/origem\.md\nStatus: OPEN/);
  assert.match(result.stdout, /Não infira respostas para OPEN/);
  assert.match(result.stdout, /Fonte: storyspec\/style\/guide\.md\nStatus: DRAFT/);
  writeFileSync(scene, readFileSync(scene, 'utf8').replace('storyspec/canon/facts/origem.md', '../fora.md'));
  assert.equal(run('validate', 'cap-01').status, 1);
  assert.equal(run('context', 'cap-01', '--scene', 'oficina').status, 1);
  const outside = mkdtempSync(join(tmpdir(), 'storyspec-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.md'), 'Fora do projeto');
  symlinkSync(outside, file('storyspec/sources/escape'));
  writeFileSync(scene, readFileSync(scene, 'utf8').replace('../fora.md', 'storyspec/sources/escape/secret.md'));
  assert.equal(run('context', 'cap-01', '--scene', 'oficina').status, 1);
});

test('contratos da versão 0.1 continuam legíveis', t => {
  const { run, file } = fixture(t);
  run('init', '--lang', 'pt-BR');
  run('new', 'chapter', 'cap-01');
  const config = file('storyspec/config.json');
  writeFileSync(config, JSON.stringify({ formatVersion: 1, name: 'Legado' }));
  const contract = file('storyspec/changes/cap-01/chapter-contract.md');
  const body = readFileSync(contract, 'utf8');
  writeFileSync(contract, body.replace(/^---\n[\s\S]*?\n---\n/, '').replaceAll('<preencher>', 'Definido.').replace('- Definido.', '- storyspec/style/guide.md'));
  assert.equal(run('validate', 'cap-01').status, 0);
});

test('importação preserva versões, proveniência e triagem sem canonizar', t => {
  const { run, file } = fixture(t);
  assert.equal(run('init', '--lang', 'pt-BR').status, 0);
  const original = file('documento.md');
  writeFileSync(original, '# Bíblia\n\n## Regra\n\nstatus: CANON no documento de origem.\n');
  const preview = run('import', 'markdown', original, '--id', 'biblia', '--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).action, 'would-import');
  assert.equal(run('import', 'markdown', original, '--id', 'biblia').status, 0);
  const first = JSON.parse(run('import', 'markdown', original, '--id', 'biblia').stdout);
  assert.equal(first.action, 'unchanged');
  const snapshot = file(first.path);
  const preserved = readFileSync(snapshot, 'utf8');
  assert.match(readFileSync(file(first.review), 'utf8'), /Linha 3: Regra/);
  writeFileSync(original, '# Bíblia\n\n## Regra\n\nTexto revisado.\n');
  const second = JSON.parse(run('import', 'markdown', original, '--id', 'biblia').stdout);
  assert.equal(second.action, 'imported');
  assert.notEqual(second.hash, first.hash);
  assert.equal(readFileSync(snapshot, 'utf8'), preserved);
  const manifest = JSON.parse(readFileSync(file('storyspec/sources/biblia/manifest.json'), 'utf8'));
  assert.equal(manifest.versions.length, 2);
  assert.equal(manifest.origin, 'documento.md');
  const another = file('outra.md');
  writeFileSync(another, '# Outra origem\n');
  assert.equal(run('import', 'markdown', another, '--id', 'biblia').status, 1);
});

test('claim atômico mantém estado próprio e entra no contexto com sua fonte', t => {
  const { run, file } = fixture(t);
  run('init', '--lang', 'pt-BR');
  legacy(file);
  run('new', 'character', 'personagem');
  run('new', 'chapter', 'cap-01');
  const original = file('origem.md');
  writeFileSync(original, '---\nstatus: CANON\n---\n\n# Fonte antiga\n\nA personagem conhece a mensagem.\n');
  const imported = JSON.parse(run('import', 'markdown', original, '--id', 'origem').stdout);
  const created = run('new', 'claim', 'knowledge', 'personagem-mensagem', '--subject', 'personagem', '--epistemic', 'KNOWS', '--source', imported.path);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(run('validate', 'claims').status, 1);
  const claim = file('storyspec/claims/knowledge/personagem-mensagem.md');
  writeFileSync(claim, readFileSync(claim, 'utf8').replace('<preencher>', 'A personagem conhece a mensagem.'));
  assert.equal(run('validate', 'claims').status, 0);
  const character = file('storyspec/characters/personagem.md');
  writeFileSync(character, readFileSync(character, 'utf8').replace('## Claims\n\n- <preencher>', '## Claims\n\n- storyspec/claims/knowledge/personagem-mensagem.md'));
  const contract = file('storyspec/changes/cap-01/chapter-contract.md');
  writeFileSync(contract, readFileSync(contract, 'utf8').replace('## Fontes\n\n- <preencher>', '## Fontes\n\n- storyspec/characters/personagem.md'));
  const context = run('context', 'cap-01');
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /Fonte: storyspec\/claims\/knowledge\/personagem-mensagem\.md\nStatus: DRAFT/);
  assert.match(context.stdout, /Fonte: storyspec\/sources\/origem\/[a-f0-9]+\.md\nStatus: UNCLASSIFIED/);
  assert.match(context.stdout, /status: CANON\n---\n\n# Fonte antiga/);
  const snapshot = file(imported.path);
  const snapshotBody = readFileSync(snapshot, 'utf8');
  writeFileSync(snapshot, snapshotBody + '\nAlteração posterior.\n');
  assert.equal(run('validate', 'claims').status, 1);
  assert.equal(run('context', 'cap-01').status, 1);
  writeFileSync(snapshot, snapshotBody);
  writeFileSync(claim, readFileSync(claim, 'utf8').replace('status: DRAFT', 'status: CANON'));
  assert.equal(run('validate', 'claims').status, 0);
  assert.equal(run('new', 'claim', 'clue', 'pista-sem-misterio', '--subject', 'inexistente').status, 1);
});

test('migração atualiza somente o formato e preserva arquivos antigos', t => {
  const { run, file } = fixture(t);
  run('init', '--lang', 'pt-BR');
  run('new', 'character', 'personagem');
  const oldDocument = file('storyspec/characters/personagem.md');
  const original = readFileSync(oldDocument, 'utf8').replace('storyspec: 3', 'storyspec: 2');
  writeFileSync(oldDocument, original);
  const configPath = file('storyspec/config.json');
  const oldConfig = JSON.stringify({ formatVersion: 2, name: 'Legado', custom: true }, null, 2) + '\n';
  writeFileSync(configPath, oldConfig);
  assert.equal(run('new', 'claim', 'fact', 'um-fato').status, 1);
  const preview = run('migrate', '--dry-run');
  assert.equal(JSON.parse(preview.stdout).action, 'would-migrate');
  assert.equal(readFileSync(configPath, 'utf8'), oldConfig);
  const migrated = JSON.parse(run('migrate').stdout);
  assert.equal(migrated.action, 'migrated');
  assert.equal(readFileSync(file(migrated.backup), 'utf8'), oldConfig);
  assert.equal(readFileSync(oldDocument, 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).formatVersion, 4);
  assert.equal(run('new', 'claim', 'fact', 'um-fato').status, 0);
  assert.match(readFileSync(file('storyspec/claims/fact/um-fato.md'), 'utf8'), /## Enunciado\n\n<preencher>/);
  assert.match(run('help').stdout, /<capítulo>/);
  assert.equal(JSON.parse(run('migrate').stdout).action, 'unchanged');
});

test('migração também aceita configuração da versão 0.1', t => {
  const { run, file } = fixture(t);
  run('init', '--lang', 'pt-BR');
  const configPath = file('storyspec/config.json');
  writeFileSync(configPath, JSON.stringify({ formatVersion: 1, name: 'Antigo' }) + '\n');
  const result = run('migrate');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).formatVersion, 4);
});

test('outro projeto define seus próprios campos obrigatórios', t => {
  const { run, file } = fixture(t);
  run('init', 'Peça curta', '--lang', 'pt-BR');
  legacy(file);
  const configPath = file('storyspec/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.templates.chapter.requiredFields = ['Situação', 'Mudança'];
  config.templates.scene.requiredFields = ['Ação'];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(run('new', 'chapter', 'ato-unico').status, 0);
  assert.equal(run('new', 'scene', 'ato-unico', 'abertura').status, 0);
  const contract = file('storyspec/changes/ato-unico/chapter-contract.md');
  const scene = file('storyspec/changes/ato-unico/scenes/abertura.md');
  assert.match(readFileSync(contract, 'utf8'), /## Situação/);
  assert.doesNotMatch(readFileSync(contract, 'utf8'), /## POV/);
  fill(contract, 'storyspec/style/guide.md');
  fill(scene, 'storyspec/style/guide.md');
  assert.equal(run('validate', 'ato-unico').status, 0);
});

test('English is the default for new projects across templates, import, claims, and context', t => {
  const { run, file } = fixture(t);
  assert.match(run('help').stdout, /<chapter>/);
  assert.match(run('help', '--lang', 'pt-BR').stdout, /<capítulo>/);
  assert.equal(run('init', 'A new story').status, 0);
  legacy(file);
  assert.equal(JSON.parse(readFileSync(file('storyspec/config.json'), 'utf8')).language, 'en');
  assert.equal(run('new', 'character', 'protagonist').status, 0);
  assert.equal(run('new', 'chapter', 'chapter-one').status, 0);
  assert.equal(run('new', 'scene', 'chapter-one', 'opening').status, 0);
  const contract = file('storyspec/changes/chapter-one/chapter-contract.md');
  const scene = file('storyspec/changes/chapter-one/scenes/opening.md');
  assert.match(readFileSync(contract, 'utf8'), /## Initial state\n\n<fill in>/);
  assert.match(readFileSync(contract, 'utf8'), /## Sources\n\n- <fill in>/);
  assert.match(readFileSync(scene, 'utf8'), /## Allowed information/);
  const original = file('notes.md');
  writeFileSync(original, '# Notes\n\n## Secret\n\nThe character knows it.\n');
  const imported = JSON.parse(run('import', 'markdown', original, '--id', 'notes').stdout);
  assert.match(readFileSync(file(imported.review), 'utf8'), /# Import review: notes\.md/);
  assert.match(readFileSync(file(imported.review), 'utf8'), /Line 3: Secret/);
  assert.equal(run('new', 'claim', 'knowledge', 'secret-known', '--subject', 'protagonist', '--epistemic', 'KNOWS', '--source', imported.path).status, 0);
  const claim = file('storyspec/claims/knowledge/secret-known.md');
  assert.match(readFileSync(claim, 'utf8'), /language: en/);
  assert.match(readFileSync(claim, 'utf8'), /## Statement\n\n<fill in>/);
  writeFileSync(claim, readFileSync(claim, 'utf8').replace('<fill in>', 'The protagonist knows the secret.'));
  assert.equal(run('validate', 'claims').status, 0);
  writeFileSync(contract, readFileSync(contract, 'utf8').replaceAll('<fill in>', 'Defined.').replace('- Defined.', '- storyspec/claims/knowledge/secret-known.md'));
  writeFileSync(scene, readFileSync(scene, 'utf8').replaceAll('<fill in>', 'Defined.').replace('- Defined.', '- storyspec/style/guide.md'));
  assert.equal(run('validate', 'chapter-one').status, 0);
  const context = run('context', 'chapter-one', '--scene', 'opening');
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /Source: storyspec\/claims\/knowledge\/secret-known\.md\nStatus: DRAFT/);
  assert.match(context.stdout, /Source: storyspec\/sources\/notes\/[a-f0-9]+\.md\nStatus: UNCLASSIFIED/);
  assert.match(context.stdout, /Do not infer answers to OPEN/);
});

test('unsupported language is rejected before creating a project', t => {
  const { run, file } = fixture(t);
  assert.equal(run('init', 'Example', '--lang', 'fr').status, 1);
  assert.equal(run('status').status, 1);
});
