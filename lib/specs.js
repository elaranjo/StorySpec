const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statuses = new Set(['CANON', 'PLANNED', 'OPEN']);
const fields = new Set(['Scope', 'Status', 'Statement', 'Verification', 'Sources', 'Claims', 'Origin', 'Reason']);

function fail(message) { throw new Error('Spec: ' + message); }
function present(value) { return value && !['<fill in>', '<preencher>'].includes(value.trim()); }

function requirement(lines, id, action) {
  if (!idPattern.test(id)) fail('invalid requirement ID: ' + id);
  const item = { id, sources: [], claims: [] };
  let list = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const field = /^([A-Za-z]+):(?:\s*(.*))?$/.exec(line);
    if (field && fields.has(field[1])) {
      const key = field[1];
      if (key === 'Sources' || key === 'Claims') {
        if (field[2]) fail(key + ' must use list items');
        list = key.toLowerCase();
      } else {
        if (item[key.toLowerCase()] !== undefined) fail('duplicate ' + key + ' in ' + id);
        item[key.toLowerCase()] = field[2] || '';
        list = null;
      }
    } else if (line.startsWith('- ') && list) {
      const value = line.slice(2).trim();
      if (present(value)) item[list].push(value);
    } else fail('unexpected line in ' + id + ': ' + line);
  }
  if (action === 'REMOVED') {
    if (!present(item.reason)) fail('REMOVED ' + id + ' requires Reason');
    if (item.statement || item.verification || item.status || item.scope) fail('REMOVED ' + id + ' only accepts Reason');
  } else {
    for (const key of ['scope', 'status', 'statement', 'verification']) {
      if (!present(item[key])) fail(id + ' requires ' + key);
    }
    if (!statuses.has(item.status)) fail(id + ' has invalid Status');
  }
  return item;
}

export function parseSpec(text, domain, delta = false) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = delta ? '# Delta: ' : '# Spec: ';
  if (lines[0] !== title + domain) fail('expected ' + title + domain);
  const result = delta ? { ADDED: [], MODIFIED: [], REMOVED: [] } : [];
  let action = null, id = null, block = [];
  const seen = new Set();
  function flush() {
    if (id === null) return;
    const item = requirement(block, id, action);
    const key = (action || 'CURRENT') + '/' + id;
    if (seen.has(key)) fail('duplicate requirement: ' + id);
    seen.add(key);
    if (delta) result[action].push(item);
    else result.push(item);
    id = null; block = [];
  }
  for (const line of lines.slice(1)) {
    const section = /^## (ADDED|MODIFIED|REMOVED)$/.exec(line);
    const current = /^## Requirement: (.+)$/.exec(line);
    const proposed = /^### Requirement: (.+)$/.exec(line);
    if (section && delta) { flush(); action = section[1]; }
    else if (!delta && current) { flush(); id = current[1]; }
    else if (delta && proposed) {
      flush();
      if (!action) fail('requirement before delta action');
      id = proposed[1];
    } else if (id !== null) block.push(line);
    else if (line.trim()) fail('unexpected content: ' + line);
  }
  flush();
  if (delta && !Object.values(result).some(items => items.length)) fail('delta has no requirements');
  const ids = delta ? Object.values(result).flat().map(item => item.id) : result.map(item => item.id);
  if (new Set(ids).size !== ids.length) fail('same requirement appears more than once');
  return result;
}

function renderItem(item, heading, removed = false) {
  let out = heading + ' Requirement: ' + item.id + '\n';
  if (removed) return out + 'Reason: ' + item.reason + '\n';
  out += 'Scope: ' + item.scope + '\nStatus: ' + item.status + '\nStatement: ' + item.statement +
    '\nVerification: ' + item.verification + '\n';
  if (item.origin) out += 'Origin: ' + item.origin + '\n';
  out += 'Sources:\n';
  for (const source of item.sources) out += '- ' + source + '\n';
  out += 'Claims:\n';
  for (const claim of item.claims) out += '- ' + claim + '\n';
  return out;
}

export function renderSpec(domain, items) {
  return '# Spec: ' + domain + '\n\n' + items.map(item => renderItem(item, '##')).join('\n');
}

export function deltaTemplate(domain) {
  return '# Delta: ' + domain + '\n\n## ADDED\n\n### Requirement: replace-me\n' +
    'Scope: series\nStatus: PLANNED\nStatement: <fill in>\nVerification: <fill in>\n' +
    'Sources:\nClaims:\n\n## MODIFIED\n\n## REMOVED\n';
}

export function applyDelta(current, delta, origin) {
  const result = current.map(item => ({ ...item, sources: [...item.sources], claims: [...item.claims] }));
  for (const item of delta.REMOVED) {
    const index = result.findIndex(old => old.id === item.id);
    if (index < 0) fail('REMOVED target does not exist: ' + item.id);
    result.splice(index, 1);
  }
  for (const item of delta.MODIFIED) {
    const index = result.findIndex(old => old.id === item.id);
    if (index < 0) fail('MODIFIED target does not exist: ' + item.id);
    result[index] = { ...item, origin };
  }
  for (const item of delta.ADDED) {
    if (result.some(old => old.id === item.id)) fail('ADDED target already exists: ' + item.id);
    result.push({ ...item, origin });
  }
  return result;
}
