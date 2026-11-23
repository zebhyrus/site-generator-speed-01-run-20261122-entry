// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build(input)
// returns, as a JSON object of path -> text, byte for byte. Written from scratch
// against the reference's README and code: its own front matter, template
// dialect, Markdown subset, slug rule and report. No dependencies, no network,
// no clock, no randomness: the output is a function of the input alone.
//
// Speed comes from fusing the reference's separate lex/parse/render passes into
// single passes, from range-based inline rendering (no string slicing), from
// run-accumulated HTML escaping (no per-character regex), from compiling each
// template once into a JavaScript function, and from avoiding repeated work
// (slug and date caches, shared card objects).

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** `s[a..b)` escaped, pushed piece by piece into `out`. */
const ESC_SPECIAL = /[&<>"']/g;
function escapeInto(s, a, b, out) {
  let i = a;
  while (i < b) {
    ESC_SPECIAL.lastIndex = i;
    const m = ESC_SPECIAL.exec(s);
    const j = m === null || m.index >= b ? b : m.index;
    if (j > i) out.push(s.slice(i, j));
    if (j >= b) break;
    const c = s[j];
    out.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
    i = j + 1;
  }
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const COMBINING = /\p{M}/gu;
const ASCII_ONLY = /^[\x00-\x7F]*$/;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left. Pure ASCII text skips the normalisation (it is the identity there).
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  let hit = longDateCache.get(date);
  if (hit === undefined) {
    const [y, m, d] = date.split('-');
    hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    longDateCache.set(date, hit);
  }
  return hit;
}

/** Whether UTF-16 code unit `c` is JavaScript whitespace (what /\s/ matches). */
function isWsCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let j = 0; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return false;
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Scanned by line offsets
 * rather than split, so the body is a slice of the source, not a re-join.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const data = {};
  let lineStart = 4; // start of line 2 (the opening --- is line 1)
  let lineNo = 2;
  let closeEnd = -1;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    if (line === '---') {
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (!isBlank(line) && line[0] !== '#') {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length && ((line[k] >= 'a' && line[k] <= 'z') || line[k] === '_')) k++;
      if (k === 0 || line[k] !== ':' || (k + 1 !== line.length && line[k + 1] !== ' ')) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, k);
      const raw = (k + 1 === line.length ? '' : line.slice(k + 2)).replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `c` is a fence language character (A-Z, a-z, 0-9, _, +, -). */
function isLangChar(c) {
  return (
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
    c === '_' || c === '+' || c === '-'
  );
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line[h] === '#') h++;
  if (h < 1 || h > 6) return null;
  if (h === line.length || (line[h] !== ' ' && line[h] !== '\t')) return null;
  let a = h;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const rest = line.startsWith('---') ? line.slice(3) : line.startsWith('***') ? line.slice(3) : null;
  if (rest === null) return false;
  for (let j = 0; j < rest.length; j++) if (rest[j] !== ' ' && rest[j] !== '\t') return false;
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line[s] === ' ') s++;
  return s >= 2 && s < line.length && !isWsCode(line.charCodeAt(s));
}

/** The characters a backslash escapes. */
const ESCAPABLE_CODES = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE_CODES.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE_CODES.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline into `out`; `env.link(target)` is a link's href.
 * Works on ranges of the one string, never on slices, so nested strong,
 * emphasis and link text re-render in place. Plain runs are found with one
 * regex scan (the engine, not a per-character loop); lastIndex is reset at
 * the top of every iteration, so the recursion below cannot disturb the scan.
 */
const SPECIAL = /[\\`*\[&<>"']/g;
function inlineInto(s, a, b, env, out) {
  let i = a;
  while (i < b) {
    SPECIAL.lastIndex = i;
    const hit = SPECIAL.exec(s);
    const j = hit === null || hit.index >= b ? b : hit.index;
    if (j > i) out.push(s.slice(i, j));
    i = j;
    if (i >= b) break;
    const c = s[i];
    if (c === '&') {
      out.push('&amp;');
      i++;
      continue;
    }
    if (c === '<') {
      out.push('&lt;');
      i++;
      continue;
    }
    if (c === '>') {
      out.push('&gt;');
      i++;
      continue;
    }
    if (c === '"') {
      out.push('&quot;');
      i++;
      continue;
    }
    if (c === "'") {
      out.push('&#39;');
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < b && ESCAPABLE_CODES.has(s.charCodeAt(i + 1))) {
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.push('<code>');
        escapeInto(s, i + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, b);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s, i + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // '[': the first ']' not escaped closes the text, '(' must follow at once,
    // and the next ')' closes the target, which must not be empty or hold space.
    const k = findUnescaped(s, ']', i + 1, b);
    let m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    if (m >= b) m = -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s, i + 1, k, env, out);
      out.push('</a>');
      i = m + 1;
      continue;
    }
    out.push('[');
    i++;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const out = [];
  inlineInto(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`)}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let t = lines[i].slice(1);
        if (t[0] === ' ') t = t.slice(1);
        body.push(t);
        i++;
      }
      const kept = body.map(trimLine).filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const c0 = line[0];
    let ordered = false;
    let start = 1;
    let first = null;
    if ((c0 === '-' || c0 === '*') && line[1] === ' ') first = line.slice(2);
    else {
      let d = 0;
      while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
      if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
        ordered = true;
        start = Number(line.slice(0, d));
        first = line.slice(d + 2);
      }
    }
    if (first !== null) {
      const items = [[trimLine(first)]];
      i++;
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (!ordered) {
          if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') m = l.slice(2);
        } else {
          let d = 0;
          while (d < l.length && l[d] >= '0' && l[d] <= '9') d++;
          if (d >= 1 && d <= 9 && l[d] === '.' && l[d + 1] === ' ') m = l.slice(d + 2);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` holds only spaces and tabs. */
function onlySpaceTab(s, a, b) {
  for (let j = a; j < b; j++) if (s[j] !== ' ' && s[j] !== '\t') return false;
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- rendering: scopes are prototype-chained frames (a null-prototype root
// holding site/tags/recent/page/..., each loop a child frame). A name reads
// from the innermost frame that holds it, exactly as the reference's chain of
// hasOwn checks, because no frame in the chain has Object.prototype above it.

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HAS_OWN = Object.prototype.hasOwnProperty;

/** The value at `path` in the frame chain `S`, by own-property checks. */
function lookupSlow(S, path) {
  let f = S;
  while (f !== null && !HAS_OWN.call(f, path[0])) f = Object.getPrototypeOf(f);
  if (f === null) return undefined;
  let v = f[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !HAS_OWN.call(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** `nodes` rendered in frame `S` at include depth `D` (the slow, fully general path). */
function renderNodes(nodes, S, D, C) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += C.esc(C.txt(lookupSlow(S, n.path)));
        break;
      case 'raw':
        out += C.txt(lookupSlow(S, n.path));
        break;
      case 'if': {
        const v = C.tru(lookupSlow(S, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, S, D, C);
        break;
      }
      case 'for': {
        const xs = lookupSlow(S, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const f = Object.create(S);
          if (n.name === '__proto__') Object.defineProperty(f, '__proto__', { value: xs[k], enumerable: true, configurable: true, writable: true });
          else f[n.name] = xs[k];
          f.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          out += renderNodes(n.body, f, D, C);
        }
        break;
      }
      case 'include': {
        const t = C.T.get(n.name);
        if (t !== undefined && D < INCLUDE_DEPTH) out += t(S, D + 1, C);
        break;
      }
    }
  }
  return out;
}

/**
 * Whether a template's nodes are safe to compile: no `__proto__` as a loop
 * variable or as a path's first name, where a prototype-chained frame would
 * read the frame's own prototype instead of nothing. Such a template (never
 * drawn by the competition's generator) renders through renderNodes instead.
 */
function compilable(nodes) {
  const walk = (ns) => {
    for (const n of ns) {
      if ((n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') && n.path[0] === '__proto__') return false;
      if (n.kind === 'for' && n.name === '__proto__') return false;
      if (n.kind === 'for' && !walk(n.body)) return false;
      if (n.kind === 'if' && (!walk(n.then) || (n.else !== null && !walk(n.else)))) return false;
    }
    return true;
  };
  return walk(nodes);
}

/** A JavaScript expression for the value at `path` in frame `S` (temp `v`). */
function lookupExpr(path, S) {
  let inner = 'v';
  for (let k = path.length - 1; k >= 1; k--) {
    inner = `(v!==null&&typeof v==="object"&&C.H.call(v,${JSON.stringify(path[k])})?(v=v.${path[k]},${inner}):void 0)`;
  }
  return `(v=${S}.${path[0]},${inner})`;
}

/**
 * A template's nodes compiled into a function (S, D, C) => string: S is the
 * scope frame, D the include depth, C the shared context { T, esc, txt, tru,
 * H }. The generated code inlines lookups and control flow, so rendering
 * walks no node tree and builds no scope objects beyond one frame per loop.
 */
function compileTemplate(nodes) {
  if (!compilable(nodes)) return (S, D, C) => renderNodes(nodes, S, D, C);
  let uid = 0;
  const lines = ['var o=[];var v;'];
  const gen = (ns, S) => {
    for (const n of ns) {
      if (n.kind === 'text') lines.push(`o.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') lines.push(`o.push(C.esc(C.txt(${lookupExpr(n.path, S)})));`);
      else if (n.kind === 'raw') lines.push(`o.push(C.txt(${lookupExpr(n.path, S)}));`);
      else if (n.kind === 'if') {
        const cond = `C.tru(${lookupExpr(n.path, S)})!==${n.not}`;
        if (n.else === null) {
          lines.push(`if(${cond}){`);
          gen(n.then, S);
          lines.push('}');
        } else {
          lines.push(`if(${cond}){`);
          gen(n.then, S);
          lines.push('}else{');
          gen(n.else, S);
          lines.push('}');
        }
      } else if (n.kind === 'for') {
        const id = uid++;
        const xs = `_x${id}`;
        const k = `_k${id}`;
        const f = `_f${id}`;
        lines.push(`var ${xs}=${lookupExpr(n.path, S)};`);
        lines.push(
          `if(Array.isArray(${xs})){for(var ${k}=0;${k}<${xs}.length;${k}++){var ${f}=Object.create(${S});${f}[${JSON.stringify(n.name)}]=${xs}[${k}];${f}.loop={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`,
        );
        gen(n.body, f);
        lines.push('}}');
      } else if (n.kind === 'include') {
        const id = uid++;
        lines.push(`var _t${id}=C.T.get(${JSON.stringify(n.name)});if(_t${id}!==undefined&&D<8)o.push(_t${id}(${S},D+1,C));`);
      }
    }
  };
  gen(nodes, 'S');
  lines.push('return o.join("");');
  return new Function('S', 'D', 'C', lines.join('\n'));
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const C = { T: templates, esc: escapeHtml, txt: textOf, tru: truthy, H: HAS_OWN };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; a source that is not .md
  // is static. Line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a
  // draft. The checks run in order; the first one that fails is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's output directory and url, its slug made unique
  // in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files
  // they name; anything else is a broken link, reported once, kept as written.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (scheme.test(target) || target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: the posts, newest date first, equal dates by slug; each
  // post's newer is the one before it and its older the one after.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by their slug, each named as first met walking the posts
  // in collection order, ordered by count of posts, most first, then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record as templates read it.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

  // A post's card, as lists show it. One card object per source, shared
  // between the lists and the page's own layout (templates only read it).
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const frame = Object.create(null);
    frame.site = site;
    frame.tags = allTags;
    frame.recent = recent;
    Object.assign(frame, vars);
    return fn(frame, 0, C);
  };
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
