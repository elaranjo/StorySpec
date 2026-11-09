import { createHash } from 'node:crypto';
import {
  constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { locales, translate } from './i18n.js';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function atomicJson(path, value) {
  const temporary = path + '.tmp-' + process.pid + '-' + Date.now();
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function outline(body) {
  return body.split(/\r?\n/).flatMap((line, i) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match ? [{ line: i + 1, title: match[2] }] : [];
  });
}

export function importMarkdown({ cwd, root, input, id, dryRun = false, language = 'en' }) {
  const t = (en, pt) => translate(language, en, pt);
  if (!input) throw new Error(t('Provide a Markdown file to import.', 'Informe um arquivo Markdown para importar.'));
  const source = realpathSync(resolve(cwd, input));
  if (extname(source).toLowerCase() !== '.md') throw new Error(t('Import accepts only .md files.', 'A importação aceita apenas arquivos .md.'));
  const bytes = readFileSync(source);
  if (bytes.length > 10 * 1024 * 1024) throw new Error(t('File exceeds the 10 MiB limit.', 'Arquivo acima do limite de 10 MiB.'));
  const body = bytes.toString('utf8');
  if (Buffer.from(body, 'utf8').compare(bytes) !== 0) throw new Error(t('File must use UTF-8.', 'O arquivo precisa estar em UTF-8.'));
  const origin = inside(cwd, source) ? relative(cwd, source) : source;
  const dir = join(root, 'sources', id);
  const manifestPath = join(dir, 'manifest.json');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const snapshot = join(dir, hash + '.md');
  const review = join(dir, hash + '.review.md');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { storyspec: 3, id, origin, versions: [] };
  if (manifest.storyspec !== 3 || manifest.id !== id || manifest.origin !== origin || !Array.isArray(manifest.versions)) {
    throw new Error(t('ID belongs to another origin, or the manifest is invalid.', 'O identificador já pertence a outra origem ou o manifesto é inválido.'));
  }
  const prior = manifest.versions.find(item => item.sha256 === hash);
  if (prior) {
    if (!existsSync(snapshot) || !readFileSync(snapshot).equals(bytes) || !existsSync(review)) throw new Error(t('Registered snapshot is missing or differs.', 'Snapshot registrado está ausente ou diferente.'));
    return { action: 'unchanged', path: relative(cwd, snapshot), review: relative(cwd, review), hash };
  }
  if (existsSync(snapshot) || existsSync(review)) throw new Error(t('A file already exists with this import hash.', 'Já existe um arquivo com o hash desta importação.'));
  const result = { action: dryRun ? 'would-import' : 'imported', path: relative(cwd, snapshot), review: relative(cwd, review), hash };
  if (dryRun) return result;
  mkdirSync(dir, { recursive: true });
  const reviewText = locales[language].triage;
  const headings = outline(body).map(item => '- [ ] ' + reviewText.line + ' ' + item.line + ': ' + item.title).join('\n') || '- [ ] ' + reviewText.whole;
  const reviewBody = '# ' + reviewText.title + ': ' + basename(source) + '\n\n' + reviewText.source + ': ' + result.path +
    '\nSHA-256: ' + hash + '\nStatus: PENDING\n\n## ' + reviewText.section + '\n\n' + headings +
    '\n\n## ' + reviewText.proposed + '\n\n- [ ] ' + reviewText.action +
    '\n\n## ' + reviewText.questions + '\n\n- ' + locales[language].placeholder + '\n';
  let wroteSnapshot = false;
  let wroteReview = false;
  try {
    writeFileSync(snapshot, bytes, { flag: 'wx' });
    wroteSnapshot = true;
    writeFileSync(review, reviewBody, { flag: 'wx' });
    wroteReview = true;
    manifest.versions.push({
      sha256: hash, path: result.path, review: result.review,
      importedAt: new Date().toISOString(), bytes: bytes.length,
    });
    atomicJson(manifestPath, manifest);
  } catch (error) {
    if (wroteReview && existsSync(review)) unlinkSync(review);
    if (wroteSnapshot && existsSync(snapshot)) unlinkSync(snapshot);
    throw error;
  }
  return result;
}

export function verifySnapshot({ cwd, root, path, language = 'en' }) {
  const t = (en, pt) => translate(language, en, pt);
  const rel = relative(root, path).split(sep).join('/');
  if (rel.startsWith('sources/') && rel.endsWith('.review.md')) throw new Error(t('Import review is not an imported source.', 'Ficha de triagem não é fonte importada.'));
  const match = /^sources\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9]{64})\.md$/.exec(rel);
  if (!match) return;
  const manifestPath = join(root, 'sources', match[1], 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(t('Imported source manifest not found.', 'Manifesto da fonte importada não encontrado.'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const registered = manifest.versions?.some(item => item.sha256 === match[2] && item.path === relative(cwd, path));
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (manifest.id !== match[1] || !registered || actual !== match[2]) throw new Error(t('Imported snapshot does not match its manifest and hash.', 'Snapshot importado não corresponde ao manifesto e ao hash.'));
}

export function migrateProject({ root, config, dryRun = false, language = 'en' }) {
  if (config.formatVersion === 3) return { action: 'unchanged', from: 3, to: 3 };
  if (![1, 2].includes(config.formatVersion)) throw new Error(translate(language, 'Unsupported format version.', 'Versão de formato não suportada.'));
  const from = config.formatVersion;
  if (dryRun) return { action: 'would-migrate', from, to: 3 };
  const archive = join(root, 'archive', 'migrations');
  mkdirSync(archive, { recursive: true });
  const backup = join(archive, 'config-v' + from + '-' + Date.now() + '.json');
  copyFileSync(join(root, 'config.json'), backup, constants.COPYFILE_EXCL);
  for (const dir of ['claims/fact', 'claims/knowledge', 'claims/clue', 'claims/event', 'sources']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  atomicJson(join(root, 'config.json'), { ...config, formatVersion: 3 });
  return { action: 'migrated', from, to: 3, backup };
}
