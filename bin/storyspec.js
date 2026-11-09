#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { importMarkdown, verifySnapshot } from '../lib/importer.js';
import { locales, normalizeLanguage, translate } from '../lib/i18n.js';
import { setupWorkflow, upgradeWorkflow, createChange, createDelta, createClaimDelta, validateWorkflowChange, assertPlanApproved, review, approve, acceptManuscript, ratifyBaseline, dryRunApply, applyChange, recoverApply, archiveChange, workflowStatus, workflowProgress, reconcileChange, initMap, verifyNarrative, history } from '../lib/workflow.js';
import { addNarrativeScene } from '../lib/narrative.js';
import { writeDefaultSchema, loadSchema } from '../lib/schema.js';
import { mapCommand } from '../lib/map-commands.js';
import { installAdapter } from '../lib/adapters.js';

const cwd = process.cwd(), root = join(cwd, 'storyspec');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const states = new Set(['CANON', 'PLANNED', 'DRAFT', 'OPEN', 'DEPRECATED']);
let activeLanguage = 'en';
function t(en, pt) { return translate(activeLanguage, en, pt); }
function lex() { return locales[activeLanguage]; }
const records = {
  fact: 'canon/facts',
  character: 'characters',
  mystery: 'mysteries',
  continuity: 'continuity',
};
const levels = { series: 'series', volume: 'volumes', part: 'parts' };
const claimTypes = new Set(['fact', 'knowledge', 'clue', 'event']);
const epistemicStates = new Set(['KNOWS', 'SUSPECTS', 'BELIEVES', 'UNAWARE']);
function workflowError(message) {
  if (activeLanguage !== 'pt-BR') return message;
  const replacements = [
    [/Plan approval required\./, 'É necessária a aprovação do plano.'],
    [/Plan approval is stale\./, 'A aprovação do plano foi invalidada por alterações.'],
    [/Plan approval is stale:/, 'A aprovação do plano foi invalidada por alterações:'],
    [/Final approval required\./, 'É necessária a aprovação final.'],
    [/Final approval is stale\./, 'A aprovação final foi invalidada por alterações.'],
    [/Manuscript acceptance required\./, 'É necessário aceitar o manuscrito.'],
    [/Accepted manuscript changed\./, 'O manuscrito aceito foi alterado.'],
    [/Baseline ratification required before apply\./, 'É necessária a ratificação inicial antes de aplicar.'],
    [/Controlled state differs from its recorded baseline\. Ratify or restore the files\./, 'Os arquivos controlados diferem da base registrada. Restaure os arquivos.'],
    [/Unresolved blocking finding:/, 'Achado bloqueante pendente:'],
    [/Missing recorded review:/, 'Falta revisão registrada:'],
    [/Review changed after recording:/, 'A revisão foi alterada após o registro:'],
    [/Review evidence changed after recording:/, 'A evidência da revisão foi alterada após o registro:'],
    [/Approved artifacts changed after application\./, 'Artefatos aprovados foram alterados após a aplicação.'],
    [/Recover the interrupted application before continuing\./, 'Recupere a aplicação interrompida antes de continuar.'],
  ];
  return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), message);
}
function fail(message) { console.error(t('Error: ', 'Erro: ') + workflowError(message)); process.exitCode = 1; }
function write(path, body) { if (existsSync(path)) throw new Error(t('File already exists: ', 'Arquivo já existe: ') + relative(cwd, path)); writeFileSync(path, body); }
function project() {
  const path = join(root, 'config.json');
  if (!existsSync(path)) throw new Error(t('Project not initialized. Run storyspec init.', 'Projeto não inicializado. Execute storyspec init.'));
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (![1, 2, 3, 4].includes(config.formatVersion)) throw new Error(t('Unsupported format version: ', 'Versão de formato não suportada: ') + config.formatVersion);
  activeLanguage = config.language ? normalizeLanguage(config.language) : 'pt-BR';
  return config;
}
function requiredFields(kind, config = project()) {
  const fields = config.templates?.[kind]?.requiredFields ?? (kind === 'chapter' ? lex().chapterFields : lex().sceneFields);
  if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string' || !field.trim() || field !== field.trim() || field.startsWith('#') || ['Fontes', 'Sources', 'Claims'].includes(field))) {
    throw new Error(t('Configure templates.', 'Configure templates.') + kind + t('.requiredFields as a list of non-empty headings.', '.requiredFields como lista de títulos não vazios.'));
  }
  if (new Set(fields).size !== fields.length) throw new Error(t('Duplicate required fields in ', 'Campos obrigatórios repetidos em ') + kind + '.');
  return fields;
}
function requireV3() { if (project().formatVersion < 3) throw new Error(t('Run storyspec migrate to enable the current format.', 'Execute storyspec migrate para habilitar o formato atual.')); }
function requireV4() { if (project().formatVersion !== 4) throw new Error(t('Run storyspec migrate to enable the narrative workflow.', 'Execute storyspec migrate para habilitar o fluxo narrativo.')); }
function checkId(id) { if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(t('Use an ID with lowercase letters, digits, and hyphens.', 'Use um identificador com letras minúsculas, números e hífens.')); }
function change(id) { checkId(id); return join(root, 'changes', id); }
function template(kind, id, fields, prefix = '') {
  return '---\nstoryspec: 3\nid: ' + id + '\nkind: ' + kind + '\nstatus: DRAFT\nlanguage: ' + activeLanguage +
    '\n---\n\n# ' + kind + ': ' + id + '\n\n' + prefix +
    fields.map(f => '## ' + f + '\n\n' + lex().placeholder + '\n').join('\n') +
    '\n## ' + lex().headings.sources + '\n\n- ' + lex().placeholder + '\n';
}
function meta(body) {
  if (!body.startsWith('---\n')) return null;
  const end = body.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(t('Markdown metadata is missing its closing ---', 'Metadados Markdown sem fechamento ---'));
  return Object.fromEntries(body.slice(4, end).split('\n').map(line => /^([a-zA-Z]+):\s*(.*?)\s*$/.exec(line)).filter(Boolean).map(m => [m[1], m[2]]));
}
function section(body, name) {
  const lines = body.split(/\r?\n/), start = lines.findIndex(line => line === '## ' + name);
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}
function missing(body, fields) { return fields.filter(f => !section(body, f) || ['<preencher>', '<fill in>'].includes(section(body, f))).map(f => t('Required field empty or missing: ', 'Campo obrigatório vazio ou ausente: ') + f); }
function refs(body) {
  return ['Fontes', 'Sources'].flatMap(name => section(body, name).split(/\r?\n/).map(line => /^-\s+(.+?)\s*$/.exec(line)?.[1]))
    .filter(Boolean).map(ref => ref.replace(/^\x60|\x60$/g, '')).filter(ref => !['<preencher>', '<fill in>'].includes(ref));
}
function claimRefs(body) {
  return section(body, 'Claims').split(/\r?\n/).map(line => /^-\s+(.+?)\s*$/.exec(line)?.[1])
    .filter(Boolean).map(ref => ref.replace(/^\x60|\x60$/g, '')).filter(ref => !['<preencher>', '<fill in>'].includes(ref));
}
function links(body) { return [...refs(body), ...claimRefs(body)]; }
function sourceState(path, body) {
  if (relative(root, path).startsWith('sources' + sep)) return 'UNCLASSIFIED';
  const m = meta(body);
  if (!m || !m.storyspec) return 'UNCLASSIFIED';
  return ['2', '3', '4'].includes(m.storyspec) ? (m.status || 'INVALID') : 'INVALID';
}
function sourcePath(ref) {
  if (isAbsolute(ref) || ref.includes('\\') || /(^|\/)\.\.?($|\/)/.test(ref)) throw new Error(t('Invalid reference: ', 'Referência inválida: ') + ref);
  if (!ref.startsWith('storyspec/') && !ref.startsWith('manuscript/')) throw new Error(t('Reference outside the project: ', 'Referência fora do projeto: ') + ref);
  const path = resolve(cwd, ref), rel = relative(realpathSync(cwd), realpathSync(path));
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(t('Reference outside the project: ', 'Referência fora do projeto: ') + ref);
  if (!path.endsWith('.md')) throw new Error(t('Source is not Markdown: ', 'Fonte não é Markdown: ') + ref);
  verifySnapshot({ cwd, root, path, language: activeLanguage });
  return path;
}
function refIssues(body) {
  const issues = [];
  for (const ref of links(body)) {
    try {
      const path = sourcePath(ref), source = readFileSync(path, 'utf8');
      if (claimRefs(body).includes(ref) && !ref.startsWith('storyspec/claims/')) issues.push(t('Claim must point to storyspec/claims/: ', 'Claim deve apontar para storyspec/claims/: ') + ref);
      if (sourceState(path, source) !== 'UNCLASSIFIED' && !states.has(sourceState(path, source))) issues.push(t('Invalid status in ', 'Status inválido em ') + ref);
    }
    catch (error) { issues.push(t('Invalid source: ', 'Fonte inválida: ') + ref + ' (' + error.message + ')'); }
  }
  return issues;
}
function validate(id) {
  const dir = change(id), path = join(dir, 'chapter-contract.md');
  if (!existsSync(path)) return [t('Contract not found.', 'Contrato não encontrado.')];
  const body = readFileSync(path, 'utf8'), m = meta(body), issues = [...missing(body, requiredFields('chapter')), ...refIssues(body)];
  if (m && (!['2', '3'].includes(m.storyspec) || m.id !== id || m.kind !== 'chapter' || !states.has(m.status))) issues.push(t('Invalid contract metadata.', 'Metadados inválidos no contrato.'));
  const scenes = join(dir, 'scenes');
  if (existsSync(scenes)) for (const entry of readdirSync(scenes).filter(n => n.endsWith('.md'))) {
    const scene = readFileSync(join(scenes, entry), 'utf8'), sm = meta(scene);
    if (!sm || !['2', '3'].includes(sm.storyspec) || sm.id !== entry.slice(0, -3) || sm.kind !== 'scene' || !states.has(sm.status)) issues.push(entry + t(': invalid metadata.', ': metadados inválidos.'));
    issues.push(...missing(scene, requiredFields('scene')).map(x => entry + ': ' + x), ...refIssues(scene).map(x => entry + ': ' + x));
  }
  return issues;
}
function init(name, language, profile) {
  if (existsSync(join(root, 'config.json'))) {
    project();
    throw new Error(t('Project already initialized.', 'Projeto já inicializado.'));
  }
  activeLanguage = normalizeLanguage(language);
  if (!['generic', 'novel', 'light-novel'].includes(profile)) throw new Error(t('Unknown profile.', 'Perfil desconhecido.'));
  for (const dir of ['canon/facts', 'characters', 'continuity', 'mysteries', 'style', 'architecture/series', 'architecture/volumes', 'architecture/parts', 'changes', 'archive', 'sources', 'claims/fact', 'claims/knowledge', 'claims/clue', 'claims/event']) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(cwd, 'manuscript'), { recursive: true });
  write(join(root, 'config.json'), JSON.stringify({
    formatVersion: 4,
    name: name || t('My project', 'Meu projeto'),
    language: activeLanguage,
    profile,
    templates: {
      chapter: { requiredFields: lex().chapterFields },
      scene: { requiredFields: lex().sceneFields },
    },
  }, null, 2) + '\n');
  write(join(root, 'README.md'), lex().projectReadme);
  write(join(root, 'style', 'guide.md'), template('style', 'guide', lex().styleFields));
  setupWorkflow(root, profile);
  writeDefaultSchema(root, profile);
  console.log(t('Project initialized in storyspec/.', 'Projeto inicializado em storyspec/.'));
}
function newChapter(id) {
  if (project().formatVersion === 4) {
    const h = lex().headings, marker = lex().placeholder;
    const contract = template('chapter', id, requiredFields('chapter'), '## ' + h.architecture + '\n\n' + marker + '\n\n## ' + h.scenes + '\n\n' + marker + '\n\n');
    createChange({ root, id, type: 'chapter', language: activeLanguage, profile: project().profile || 'generic', chapterContract: contract });
    console.log(t('Chapter created in storyspec/changes/', 'Capítulo criado em storyspec/changes/') + id + '/.');
    return;
  }
  const dir = change(id);
  if (existsSync(dir)) throw new Error(t('A change with this ID already exists.', 'Já existe uma mudança com esse identificador.'));
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  const h = lex().headings, marker = lex().placeholder;
  write(join(dir, 'chapter-contract.md'), template('chapter', id, requiredFields('chapter'), '## ' + h.architecture + '\n\n' + marker + '\n\n## ' + h.scenes + '\n\n' + marker + '\n\n'));
  write(join(dir, 'proposal.md'), template('proposal', id, [h.intention, h.dependencies]));
  write(join(dir, 'tasks.md'), lex().tasks);
  write(join(dir, 'review.md'), lex().review);
  console.log(t('Chapter created in storyspec/changes/', 'Capítulo criado em storyspec/changes/') + id + '/.');
}
function newScene(chapterId, id) {
  const dir = change(chapterId); checkId(id);
  if (existsSync(join(dir, 'archive.json'))) throw new Error(t('Change is archived.', 'A mudança está arquivada.'));
  if (existsSync(join(dir, 'applied.json'))) throw new Error(t('Change is already applied.', 'A mudança já foi aplicada.'));
  const metadata = existsSync(join(dir, 'change.json')) ? JSON.parse(readFileSync(join(dir, 'change.json'), 'utf8')) : null;
  if (!existsSync(join(dir, 'chapter-contract.md')) && metadata?.type !== 'revision') throw new Error(t('Chapter not found: ', 'Capítulo não encontrado: ') + chapterId);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  const path = join(dir, 'scenes', id + '.md');
  write(path, template('scene', id, requiredFields('scene'), '## ' + lex().headings.chapter + '\n\n' + chapterId + '\n\n## ' + lex().headings.dependencies + '\n\n' + lex().placeholder + '\n\n'));
  if (metadata?.workflowVersion >= 2) addNarrativeScene(dir, id);
  console.log(t('Scene created in ', 'Cena criada em ') + relative(cwd, path) + '.');
}
function newRecord(kind, id) {
  checkId(id); const folder = records[kind];
  if (!folder) throw new Error(t('Unknown record type: ', 'Tipo desconhecido: ') + kind);
  const path = join(root, folder, id + '.md');
  mkdirSync(join(root, folder), { recursive: true });
  const prefix = ['character', 'mystery', 'continuity'].includes(kind) ? '## Claims\n\n- ' + lex().placeholder + '\n\n' : '';
  write(path, template(kind, id, lex().recordFields[kind], prefix));
  console.log(t('Record created in ', 'Registro criado em ') + relative(cwd, path) + '.');
}
function newStructure(level, id) {
  checkId(id);
  if (!levels[level]) throw new Error(t('Unknown structure level: ', 'Nível desconhecido: ') + level);
  const path = join(root, 'architecture', levels[level], id + '.md');
  mkdirSync(join(root, 'architecture', levels[level]), { recursive: true });
  write(path, template(level, id, lex().structureFields, '## ' + lex().headings.parent + '\n\n' + lex().placeholder + '\n\n'));
  console.log(t('Structure created in ', 'Estrutura criada em ') + relative(cwd, path) + '.');
}
function options(args, valueKeys, flagKeys = []) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flagKeys.includes(key)) {
      if (key in result) throw new Error(t('Repeated option: ', 'Opção repetida: ') + key);
      result[key] = true;
    } else if (valueKeys.includes(key)) {
      if (key in result || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(t('Missing value or repeated option: ', 'Valor ausente ou opção repetida: ') + key);
      result[key] = args[++i];
    } else throw new Error(t('Unknown option: ', 'Opção desconhecida: ') + key);
  }
  return result;
}
function claimPath(type, id) { return join(root, 'claims', type, id + '.md'); }
function subjectIssues(type, subject) {
  const issues = [];
  if (!subject || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subject)) issues.push(t('Invalid subject.', 'Sujeito inválido.'));
  if (type === 'knowledge' && subject && !existsSync(join(root, 'characters', subject + '.md'))) issues.push(t('Character not found: ', 'Personagem não encontrado: ') + subject);
  if (type === 'clue' && subject && !existsSync(join(root, 'mysteries', subject + '.md'))) issues.push(t('Mystery not found: ', 'Mistério não encontrado: ') + subject);
  return issues;
}
function newClaim(type, id, args) {
  requireV3(); checkId(id);
  if (!claimTypes.has(type)) throw new Error(t('Unknown claim type: ', 'Tipo de claim desconhecido: ') + type);
  const opts = options(args, ['--subject', '--epistemic', '--source']);
  const subject = opts['--subject'] || (['fact', 'event'].includes(type) ? 'world' : '');
  const issues = subjectIssues(type, subject);
  if (issues.length) throw new Error(issues.join(' '));
  const epistemic = opts['--epistemic'];
  if (type === 'knowledge' && !epistemicStates.has(epistemic)) throw new Error(t('Provide --epistemic KNOWS|SUSPECTS|BELIEVES|UNAWARE.', 'Informe --epistemic KNOWS|SUSPECTS|BELIEVES|UNAWARE.'));
  if (type !== 'knowledge' && epistemic) throw new Error(t('--epistemic only applies to knowledge.', '--epistemic só vale para knowledge.'));
  const source = opts['--source'];
  if (source) sourcePath(source);
  const path = claimPath(type, id);
  const header = '---\nstoryspec: 3\nid: ' + id + '\nkind: claim\nclaimType: ' + type +
    '\nstatus: DRAFT\nsubject: ' + subject + (epistemic ? '\nepistemic: ' + epistemic : '') +
    '\nlanguage: ' + activeLanguage + '\n---\n\n';
  const h = lex().headings, marker = lex().placeholder;
  const body = '# ' + type + ': ' + id + '\n\n## ' + h.statement + '\n\n' + marker + '\n\n' +
    (type === 'event' ? '## ' + h.moment + '\n\n' + marker + '\n\n' : '') +
    '## ' + h.sources + '\n\n- ' + (source || marker) + '\n';
  mkdirSync(join(root, 'claims', type), { recursive: true });
  write(path, header + body);
  console.log(t('Claim created in ', 'Claim criado em ') + relative(cwd, path) + '.');
}
function validateClaim(path, type, id) {
  const body = readFileSync(path, 'utf8'), m = meta(body), issues = [];
  if (!m || m.storyspec !== '3' || m.kind !== 'claim' || m.claimType !== type || m.id !== id || !states.has(m.status)) issues.push(t('Invalid metadata.', 'Metadados inválidos.'));
  issues.push(...subjectIssues(type, m?.subject));
  if (type === 'knowledge' && !epistemicStates.has(m?.epistemic)) issues.push(t('Invalid knowledge state.', 'Estado de conhecimento inválido.'));
  if (type !== 'knowledge' && m?.epistemic) issues.push(t('Knowledge state only applies to knowledge.', 'Estado de conhecimento só vale para knowledge.'));
  const language = m?.language ? normalizeLanguage(m.language) : 'pt-BR';
  const h = locales[language].headings;
  issues.push(...missing(body, type === 'event' ? [h.statement, h.moment] : [h.statement]));
  if (m?.status === 'CANON' && !refs(body).length) issues.push(t('CANON claim must cite a source.', 'Claim CANON precisa citar uma fonte.'));
  issues.push(...refIssues(body));
  return issues;
}
function validateClaims() {
  const issues = [];
  for (const type of claimTypes) {
    const dir = join(root, 'claims', type);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter(name => name.endsWith('.md'))) {
      const id = entry.slice(0, -3);
      issues.push(...validateClaim(join(dir, entry), type, id).map(issue => type + '/' + id + ': ' + issue));
    }
  }
  return issues;
}
function context(id, options) {
  const dir = change(id), contract = join(dir, 'chapter-contract.md');
  if (!existsSync(contract)) throw new Error(t('Chapter not found: ', 'Capítulo não encontrado: ') + id);
  const opts = optionsParserForContext(options);
  const purpose = opts['--purpose'] || 'write';
  if (purpose === 'write' && project().formatVersion === 4 && existsSync(join(dir, 'change.json'))) assertPlanApproved(cwd, root, id);
  if (!lex().context[purpose]) throw new Error(t('Invalid purpose: ', 'Propósito inválido: ') + purpose);
  const sceneId = opts['--scene'] || null;
  if (sceneId) checkId(sceneId);
  const files = [contract], proposal = join(dir, 'proposal.md');
  if (existsSync(proposal)) files.push(proposal);
  if (sceneId) {
    const scene = join(dir, 'scenes', sceneId + '.md');
    if (!existsSync(scene)) throw new Error(t('Scene not found: ', 'Cena não encontrada: ') + sceneId);
    files.push(scene);
  }
  const output = ['# ' + t('StorySpec context: ', 'Contexto StorySpec: ') + id, '', t('Purpose: ', 'Propósito: ') + purpose, sceneId ? t('Scene: ', 'Cena: ') + sceneId : '', '', lex().context[purpose], '', lex().contextNotice];
  const visited = new Set();
  let totalBytes = 0;
  for (const path of files) {
    if (visited.has(path)) continue;
    if (visited.size >= 100) throw new Error(t('Context exceeds 100 files; reduce references.', 'Contexto excede 100 arquivos; reduza as referências.'));
    visited.add(path);
    const body = readFileSync(path, 'utf8'), status = sourceState(path, body);
    totalBytes += Buffer.byteLength(body, 'utf8');
    if (totalBytes > 5 * 1024 * 1024) throw new Error(t('Context exceeds 5 MiB; reduce references.', 'Contexto excede 5 MiB; reduza as referências.'));
    if (status !== 'UNCLASSIFIED' && !states.has(status)) throw new Error(t('Invalid status: ', 'Status inválido: ') + relative(cwd, path));
    output.push('', '---\n' + t('Source: ', 'Fonte: ') + relative(cwd, path) + '\nStatus: ' + status + '\n---', '', body.trimEnd());
    if (!relative(root, path).startsWith('sources' + sep)) {
      for (const ref of links(body)) files.push(sourcePath(ref));
    }
  }
  console.log(output.join('\n'));
}
function optionsParserForContext(args) { return options(args, ['--purpose', '--scene']); }
function help() {
  const en = 'StorySpec ' + version + '\n\n  storyspec init [name] [--lang en|pt-BR] [--profile generic|novel|light-novel]\n  storyspec migrate [--dry-run]\n  storyspec baseline approve --author <name>\n  storyspec import markdown <file.md> --id <id> [--dry-run]\n  storyspec new change <id> --type chapter|revision|world|character|plot\n  storyspec new chapter <id>\n  storyspec new scene <chapter> <id>\n  storyspec new delta <change> <domain>\n  storyspec new claim-delta <change> <fact|knowledge|clue|event> <id> --operation ADDED|MODIFIED|REMOVED [--subject <id>] [--epistemic <state>]\n  storyspec new claim <fact|knowledge|clue|event> <id> [--subject <id>] [--epistemic <state>] [--source <path>]\n  storyspec new <fact|character|mystery|continuity> <id>\n  storyspec new structure <series|volume|part> <id>\n  storyspec context <chapter> [--scene <id>] [--purpose write|dramaturgy|continuity|prose]\n  storyspec validate <change|claims>\n  storyspec review <change> <dramaturgy|continuity|prose> [--record --author <name>]\n  storyspec approve <change> <plan|final> --author <name>\n  storyspec manuscript accept <change> <manuscript/file.md> --author <name>\n  storyspec apply <change> [--dry-run]\n  storyspec apply --recover <change>\n  storyspec archive <change>\n  storyspec history <change>\n  storyspec status [<change> --json]\n  storyspec next <change>\n  storyspec map init|upgrade <change>\n  storyspec map scene set <change> <scene> --order <n> [--after <change/scene>] [--cause <change/scene>]\n  storyspec map coverage set <change> <domain>/<requirement> --status realized|partial|deferred\n  storyspec map passage add <change> <domain>/<requirement> --scene <scene> --lines <start>:<end>\n  storyspec map state|knowledge add <change> <scene> [options]\n  storyspec map waive <change> <issue-id> --author <name> --reason <text>\n  storyspec schema validate\n  storyspec reconcile <change> [--json]\n  storyspec adapters install <codex|claude|cursor> [--dry-run]\n  storyspec verify <change> [--json] [--record]\n  storyspec help [--lang en|pt-BR]\n  storyspec --version';
  const pt = 'StorySpec ' + version + '\n\n  storyspec init [nome] [--lang en|pt-BR] [--profile generic|novel|light-novel]\n  storyspec migrate [--dry-run]\n  storyspec baseline approve --author <nome>\n  storyspec import markdown <arquivo.md> --id <id> [--dry-run]\n  storyspec new change <id> --type chapter|revision|world|character|plot\n  storyspec new chapter <id>\n  storyspec new scene <capítulo> <id>\n  storyspec new delta <mudança> <domínio>\n  storyspec new claim-delta <mudança> <fact|knowledge|clue|event> <id> --operation ADDED|MODIFIED|REMOVED [--subject <id>] [--epistemic <estado>]\n  storyspec new claim <fact|knowledge|clue|event> <id> [--subject <id>] [--epistemic <estado>] [--source <caminho>]\n  storyspec new <fact|character|mystery|continuity> <id>\n  storyspec new structure <series|volume|part> <id>\n  storyspec context <capítulo> [--scene <id>] [--purpose write|dramaturgy|continuity|prose]\n  storyspec validate <mudança|claims>\n  storyspec review <mudança> <dramaturgy|continuity|prose> [--record --author <nome>]\n  storyspec approve <mudança> <plan|final> --author <nome>\n  storyspec manuscript accept <mudança> <manuscript/arquivo.md> --author <nome>\n  storyspec apply <mudança> [--dry-run]\n  storyspec apply --recover <mudança>\n  storyspec archive <mudança>\n  storyspec history <mudança>\n  storyspec status [<mudança> --json]\n  storyspec next <mudança>\n  storyspec map init|upgrade <mudança>\n  storyspec map scene set <mudança> <cena> --order <n> [--after <mudança/cena>] [--cause <mudança/cena>]\n  storyspec map coverage set <mudança> <domínio>/<requisito> --status realized|partial|deferred\n  storyspec map passage add <mudança> <domínio>/<requisito> --scene <cena> --lines <início>:<fim>\n  storyspec map state|knowledge add <mudança> <cena> [opções]\n  storyspec map waive <mudança> <id-do-achado> --author <nome> --reason <justificativa>\n  storyspec schema validate\n  storyspec reconcile <mudança> [--json]\n  storyspec adapters install <codex|claude|cursor> [--dry-run]\n  storyspec verify <mudança> [--json] [--record]\n  storyspec help [--lang en|pt-BR]\n  storyspec --version';
  console.log(t(en, pt));
}
function initArgs(args) {
  const opts = {}, name = [];
  for (let i = 0; i < args.length; i++) {
    if (['--lang', '--profile'].includes(args[i])) {
      const key = args[i];
      if (key in opts || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing or repeated init option: ' + key);
      opts[key] = args[++i];
    } else name.push(args[i]);
  }
  if (name.some(part => part.startsWith('--'))) throw new Error(t('Unknown init option.', 'Opção desconhecida para init.'));
  return { name: name.join(' '), language: opts['--lang'] || 'en', profile: opts['--profile'] || 'generic' };
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' || command === '-v') console.log(version);
  else if (command === 'init') { const parsed = initArgs(args); init(parsed.name, parsed.language, parsed.profile); }
  else if (command === 'migrate') {
    const opts = options(args, [], ['--dry-run']);
    const result = upgradeWorkflow(root, project(), Boolean(opts['--dry-run']));
    console.log(JSON.stringify({ ...result, backup: result.backup ? relative(cwd, result.backup) : undefined }));
  }
  else if (command === 'baseline') {
    requireV4();
    if (args[0] !== 'approve') throw new Error('Use baseline approve --author <name>.');
    const opts = options(args.slice(1), ['--author']);
    console.log(JSON.stringify(ratifyBaseline(cwd, root, opts['--author'])));
  }
  else if (command === 'import') {
    requireV3();
    if (args[0] !== 'markdown') throw new Error(t('Use storyspec import markdown <file.md> --id <id>.', 'Use storyspec import markdown <arquivo.md> --id <id>.'));
    const opts = options(args.slice(2), ['--id'], ['--dry-run']);
    checkId(opts['--id']);
    console.log(JSON.stringify(importMarkdown({ cwd, root, input: args[1], id: opts['--id'], dryRun: Boolean(opts['--dry-run']), language: activeLanguage })));
  }
  else if (command === 'new') {
    const config = project();
    if (args[0] === 'change') {
      requireV4(); const opts = options(args.slice(2), ['--type']);
      if (opts['--type'] === 'chapter') newChapter(args[1]);
      else { const path = createChange({ root, id: args[1], type: opts['--type'], language: activeLanguage, profile: config.profile || 'generic' }); console.log(relative(cwd, path)); }
    }
    else if (args[0] === 'delta') { requireV4(); console.log(relative(cwd, createDelta(root, args[1], args[2]))); }
    else if (args[0] === 'claim-delta') {
      requireV4(); const opts = options(args.slice(4), ['--operation', '--subject', '--epistemic']);
      console.log(relative(cwd, createClaimDelta(root, args[1], args[2], args[3], opts['--operation'], opts['--subject'] || 'world', opts['--epistemic'], activeLanguage)));
    }
    else if (args[0] === 'chapter') newChapter(args[1]);
    else if (args[0] === 'scene') newScene(args[1], args[2]);
    else if (args[0] === 'structure') newStructure(args[1], args[2]);
    else if (args[0] === 'claim') newClaim(args[1], args[2], args.slice(3));
    else newRecord(args[0], args[1]);
  } else if (command === 'validate') {
    const config = project();
    if (config.formatVersion === 4 && args[0] !== 'claims' && existsSync(join(change(args[0]), 'change.json'))) {
      validateWorkflowChange(cwd, root, args[0], validate);
      console.log(t('Change is structurally complete. Literary quality requires human review.', 'Mudança estruturalmente completa. A qualidade literária exige revisão humana.'));
    } else {
      const issues = args[0] === 'claims' ? validateClaims() : validate(args[0]);
      if (issues.length) { issues.forEach(issue => console.error('- ' + issue)); process.exitCode = 1; }
      else console.log(args[0] === 'claims' ? t('Claims are structurally complete.', 'Claims estruturalmente completos.') : t('Contract and scenes are structurally complete. Validation does not assess literary quality or truth.', 'Contrato e cenas estruturalmente completos. A validação não avalia qualidade literária ou veracidade.'));
    }
  } else if (command === 'status') {
    project();
    if (args[0]) {
      const opts = options(args.slice(1), [], ['--json']);
      const progress = workflowProgress(cwd, root, args[0], validate);
      if (opts['--json']) console.log(JSON.stringify(progress, null, 2));
      else console.log(progress.change + ': ' + progress.phase + '\n' + (progress.next ? progress.next.action + '\n' + progress.next.path + '\n' + progress.next.reason : t('Complete.', 'Concluído.')));
    } else {
    const changes = readdirSync(join(root, 'changes'), { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'archive');
    if (!changes.length) console.log(t('No changes created.', 'Nenhuma mudança criada.'));
    for (const entry of changes) {
      if (existsSync(join(root, 'changes', entry.name, 'change.json'))) {
        console.log(entry.name + ': ' + workflowStatus(cwd, root, entry.name));
      } else { const issues = validate(entry.name); console.log(entry.name + ': ' + (issues.length ? issues.length + t(' issue(s)', ' pendência(s)') : t('contract complete', 'contrato completo')) + ' (DRAFT)'); }
    }
    }
  } else if (command === 'next') {
    requireV4(); const progress = workflowProgress(cwd, root, args[0], validate);
    console.log(progress.next ? progress.next.action + '\n' + progress.next.path + '\n' + progress.next.reason : t('Change complete.', 'Mudança concluída.'));
  } else if (command === 'map') {
    requireV4();
    if (args[0] === 'init') console.log(relative(cwd, initMap(root, args[1])));
    else {
      const jsonOutput = args.includes('--json'), values = args.filter(value => value !== '--json');
      const action = values[0], offset = ['scene', 'coverage', 'passage', 'state', 'knowledge'].includes(action) && ['set', 'add'].includes(values[1]) ? 1 : 0;
      const changeId = values[1 + offset], target = values[2 + offset], optionArgs = values.slice(3 + offset);
      const result = mapCommand(cwd, root, action, changeId, target, optionArgs);
      console.log(jsonOutput ? JSON.stringify(result, null, 2) : result.action + ': ' + result.path + (result.target ? ' (' + result.target + ')' : ''));
    }
  } else if (command === 'schema') {
    requireV4(); if (args[0] !== 'validate') throw new Error('Use schema validate.');
    const schema = loadSchema(root, project().profile || 'generic');
    console.log(JSON.stringify({ valid: true, artifacts: schema.artifacts.length }));
  } else if (command === 'reconcile') {
    requireV4(); const opts = options(args.slice(1), [], ['--json']);
    const result = reconcileChange(cwd, root, args[0]);
    if (opts['--json']) console.log(JSON.stringify(result, null, 2));
    else for (const stage of result.stages) console.log((stage.current ? 'OK ' : 'STALE ') + stage.stage + (stage.reason ? ': ' + stage.reason : ''));
  } else if (command === 'adapters') {
    if (args[0] !== 'install') throw new Error('Use adapters install <codex|claude|cursor> [--dry-run].');
    const opts = options(args.slice(2), [], ['--dry-run']);
    console.log(JSON.stringify(installAdapter(cwd, args[1], Boolean(opts['--dry-run']))));
  } else if (command === 'verify') {
    requireV4(); const opts = options(args.slice(1), [], ['--json', '--record']);
    const report = verifyNarrative(cwd, root, args[0], Boolean(opts['--record']));
    if (opts['--json']) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(t('Narrative verification: ', 'Verificação narrativa: ') + report.summary.blockers + t(' blocker(s)', ' bloqueio(s)'));
      for (const issue of report.issues) console.log((issue.waived ? 'WAIVED' : issue.severity) + ' ' + issue.id + ': ' + issue.path + ': ' + issue.message);
    }
    if (report.summary.blockers) process.exitCode = 1;
  } else if (command === 'context') { project(); context(args[0], args.slice(1)); }
  else if (command === 'review') {
    requireV4(); const opts = options(args.slice(2), ['--author'], ['--record']);
    console.log(JSON.stringify(review(cwd, root, args[0], args[1], opts['--author'], Boolean(opts['--record']))));
  }
  else if (command === 'approve') {
    requireV4(); const opts = options(args.slice(2), ['--author']);
    console.log(JSON.stringify(approve(cwd, root, args[0], args[1], opts['--author'], validate)));
  }
  else if (command === 'manuscript') {
    requireV4(); if (args[0] !== 'accept') throw new Error('Use manuscript accept <change> <path> --author <name>.');
    const opts = options(args.slice(3), ['--author']);
    console.log(JSON.stringify(acceptManuscript(cwd, root, args[1], args[2], opts['--author'])));
  }
  else if (command === 'apply') {
    requireV4();
    if (args[0] === '--recover') console.log(JSON.stringify(recoverApply(cwd, root, args[1])));
    else { const opts = options(args.slice(1), [], ['--dry-run']); console.log(JSON.stringify(opts['--dry-run'] ? dryRunApply(cwd, root, args[0]) : applyChange(cwd, root, args[0]))); }
  }
  else if (command === 'archive') { requireV4(); console.log(JSON.stringify(archiveChange(cwd, root, args[0]))); }
  else if (command === 'history') { requireV4(); console.log(JSON.stringify(history(root, args[0]))); }
  else {
    if (command && ['help', '--help', '-h'].includes(command)) {
      const opts = options(args, ['--lang']);
      if (opts['--lang']) activeLanguage = normalizeLanguage(opts['--lang']);
      else if (existsSync(join(root, 'config.json'))) project();
    } else if (existsSync(join(root, 'config.json'))) project();
    help();
    if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 1;
  }
} catch (error) { fail(error.message); }
