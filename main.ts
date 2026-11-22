// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- line model and matching (SPEC.md sections 3 and 5) ----

let STRICT = false;

/** A file read as section 3 says: its lines, its own break, and whether it ends with one. */
class Doc {
  lines: string[] = [];
  final = false;
  br = '\n';

  static read(text: string): Doc {
    const doc = new Doc();
    const firstLf = text.indexOf('\n');
    doc.br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
    if (text !== '') {
      doc.final = text.endsWith(doc.br);
      doc.lines = text.split(doc.br);
      if (doc.final) doc.lines.pop();
    }
    return doc;
  }

  text(): string {
    return this.lines.length === 0 ? '' : this.lines.join(this.br) + (this.final ? this.br : '');
  }
}

/** The three tiers of section 5, as the fold each one applies to both sides before comparing. */
const TIERS: ReadonlyArray<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
];

interface Hit {
  tier: number;
  at: number[];
}

/**
 * Every position where `needle` occurs in `hay` at the first tier with any. `from` skips earlier positions;
 * `tail` keeps only a position whose occurrence ends at the last line.
 */
function search(hay: readonly string[], needle: readonly string[], opts: { from?: number; tail?: boolean } = {}): Hit | null {
  const from = opts.from ?? 0;
  const last = hay.length - needle.length;
  const first = opts.tail ? Math.max(from, last) : from;
  const folds = STRICT ? TIERS.slice(0, 1) : TIERS;
  for (let tier = 0; tier < folds.length; tier++) {
    const fold = folds[tier]!;
    const h = hay.map(fold);
    const n = needle.map(fold);
    const at: number[] = [];
    for (let i = first; i <= last; i++) if (n.every((x, k) => h[i + k] === x)) at.push(i);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

type Op = 'keep' | 'drop' | 'add';
/** One line of an edit: context, old or new. `noEol` marks a line a unified `\` line follows. */
interface Row {
  op: Op;
  text: string;
  noEol?: boolean;
}

const rowOf = (marker: string, text: string): Row => ({ op: marker === '-' ? 'drop' : marker === '+' ? 'add' : 'keep', text });
const oldSide = (rows: readonly Row[]): string[] => rows.filter((r) => r.op !== 'add').map((r) => r.text);
const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The lines that replace the occurrence of the old side at `at`, found at `tier` (section 5). */
function rewrite(file: readonly string[], at: number, tier: number, rows: readonly Row[]): string[] {
  const from = indentOf(file[at] ?? '');
  const was = indentOf(rows.find((r) => r.op !== 'add')?.text ?? '');
  let consumed = 0;
  const out: string[] = [];
  for (const r of rows) {
    if (r.op === 'drop') consumed += 1;
    else if (r.op === 'keep') out.push(file[at + consumed++]!);
    else if (tier === 2 && r.text.trim() !== '' && r.text.startsWith(was)) out.push(from + r.text.slice(was.length));
    else out.push(r.text);
  }
  return out;
}

// What an edit does to the tree, shared by the three formats.

/** A file is to be created at `p`: it must be a safe path that is free. */
function create(tree: Tree, p: string, text: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
  if (tree.get(p) !== null) throw new Fail('exists', p);
  tree.now.set(p, text);
}

function erase(tree: Tree, p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
  if (tree.get(p) === null) throw new Fail('missing', p);
  tree.now.set(p, null);
}

/** Opens `from` for change; with a `to` that is a move, so `to` must be safe and free. */
function openForChange(tree: Tree, from: string, to: string | null): Doc {
  if (!safe(from)) throw new Fail('unsafe', from);
  if (to !== null && !safe(to)) throw new Fail('unsafe', to);
  const text = tree.get(from);
  if (text === null) throw new Fail('missing', from);
  if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
  return Doc.read(text);
}

function save(tree: Tree, doc: Doc, from: string, to: string | null): void {
  if (to === null) {
    tree.now.set(from, doc.text());
    return;
  }
  tree.now.set(to, doc.text());
  tree.now.set(from, null);
  tree.moves.push([from, to]);
}

/** Lines of a created file: LF breaks, ended by one unless `endBreak` is false. */
function lfText(lines: readonly string[], endBreak = true): string {
  return lines.length === 0 ? '' : lines.join('\n') + (endBreak ? '\n' : '');
}

const parseAt = (index: number): Exit2 => new Exit2(`error: parse ${index + 1}`);

// ---- unified diffs (section 6) ----

/** A hunk: `a` is the A of its header; `noEol` says a `\` line follows its last context or `+` line. */
interface Hunk {
  a: number;
  rows: Row[];
  noEol: boolean;
}

/** What a section's header says, before the section is settled into one edit. */
interface Header {
  oldP: string | null;
  newP: string | null;
  paired: boolean; // a `---`/`+++` pair named the paths
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
const isGitLine = (l: string): boolean => l.startsWith('diff --git ');
const startsPair = (ls: readonly string[], i: number): boolean => ls[i]!.startsWith('--- ') && (ls[i + 1] ?? '').startsWith('+++ ');
const startsSection = (ls: readonly string[], i: number): boolean => isGitLine(ls[i]!) || startsPair(ls, i);

/** `a/<X> b/<Y>` of a `diff --git` line: the split where both halves agree, else at the first ` b/`. */
function gitPaths(rest: string): [string, string] | null {
  if (!rest.startsWith('a/')) return null;
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  const same = rest.length % 2 === 1 ? (rest.length - 1) / 2 : -1; // the middle of `a/X b/X`
  if (same >= 3 && rest.startsWith(' b/', same) && rest.slice(2, same) === rest.slice(same + 3)) return [rest.slice(2, same), rest.slice(same + 3)];
  const oldP = rest.slice(2, k);
  const newP = rest.slice(k + 3);
  return oldP === '' || newP === '' ? null : [oldP, newP];
}

/** A `---` or `+++` line's path: up to the first tab, spaces trimmed, `/dev/null` as null, one a/ or b/ dropped. */
function headerPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The body of the hunk whose header is just before `from`: rows, and the index of the first line after it. */
function readBody(lines: readonly string[], from: number): { rows: Row[]; next: number } {
  let end = from;
  while (end < lines.length && !startsSection(lines, end) && (lines[end] === '' || ' -+\\'.includes(lines[end]![0]!))) end++;
  let stop = end;
  while (stop > from && lines[stop - 1] === '') stop--; // empty lines that end a body are not part of it
  const rows: Row[] = [];
  for (const l of lines.slice(from, stop)) {
    if (l[0] === '\\') {
      if (rows.length > 0) rows[rows.length - 1]!.noEol = true;
    } else rows.push(l === '' ? { op: 'keep', text: '' } : rowOf(l[0]!, l.slice(1)));
  }
  return { rows, next: end };
}

/** Reads the section that starts at line `start`: its header up to the first hunk, then its hunks. */
function readSection(lines: readonly string[], start: number): { sec: Header; next: number } {
  const sec: Header = { oldP: null, newP: null, paired: false, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] };
  let i = start;
  if (isGitLine(lines[i]!)) {
    const names = gitPaths(lines[i]!.slice(11));
    if (names === null) throw parseAt(i);
    [sec.oldP, sec.newP] = names;
    i++;
  }
  for (; i < lines.length && !lines[i]!.startsWith('@@'); i++) {
    const l = lines[i]!;
    if (isGitLine(l)) return { sec, next: i };
    if (l.startsWith('--- ')) {
      if (!startsPair(lines, i)) throw parseAt(i + 1);
      if (sec.paired) return { sec, next: i };
      sec.oldP = headerPath(l);
      sec.newP = headerPath(lines[i + 1]!);
      sec.paired = true;
      i++;
    } else if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12);
    else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10);
    else if (l.startsWith('new file mode')) sec.isNew = true;
    else if (l.startsWith('deleted file mode')) sec.isDel = true;
  }
  while (i < lines.length) {
    if (startsSection(lines, i)) break;
    const head = HUNK_HEAD.exec(lines[i]!);
    if (lines[i]!.startsWith('@@') && head === null) throw parseAt(i);
    if (head === null) {
      i++;
      continue;
    }
    const { rows, next } = readBody(lines, i + 1);
    const lastText = rows.filter((r) => r.op !== 'drop').at(-1);
    sec.hunks.push({ a: Number(head[1]), rows, noEol: lastText?.noEol === true });
    i = next;
  }
  return { sec, next: i };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Header[] = [];
  for (let i = 0; i < lines.length; ) {
    if (startsSection(lines, i)) {
      const { sec, next } = readSection(lines, i);
      sections.push(sec);
      i = next;
    } else if (lines[i]!.startsWith('@@')) throw parseAt(i); // a hunk before any section
    else i++;
  }
  return sections.map(sectionEdit);
}

type Plan = { kind: 'create'; path: string } | { kind: 'delete'; path: string } | { kind: 'change'; from: string; to: string };

/** Which of the four things the section is, and the paths it concerns (section 6, "The section's edit"). */
function settle(s: Header): Plan {
  const from = s.paired ? s.oldP : (s.renameFrom ?? s.oldP);
  const to = s.paired ? s.newP : (s.renameTo ?? s.newP);
  const creates = s.isNew || (s.paired && from === null && to !== null);
  if (creates) return { kind: 'create', path: to ?? '' };
  if (s.isDel || (s.paired && to === null && from !== null)) return { kind: 'delete', path: from ?? '' };
  return { kind: 'change', from: from ?? to ?? '', to: to ?? from ?? '' };
}

function sectionEdit(s: Header): Edit {
  const plan = settle(s);
  if (plan.kind === 'delete') return (tree) => erase(tree, plan.path);
  if (plan.kind === 'create') {
    const added = s.hunks.flatMap((h) => h.rows.filter((r) => r.op === 'add'));
    return (tree) => create(tree, plan.path, lfText(added.map((r) => r.text), added.at(-1)?.noEol !== true));
  }
  const dest = plan.to === plan.from ? null : plan.to;
  return (tree) => {
    const doc = openForChange(tree, plan.from, dest);
    let drift = 0;
    for (const h of s.hunks) drift += applyHunk(doc, h, drift, plan.from);
    save(tree, doc, plan.from, dest);
  };
}

/** The hunk applied to `doc`, where `drift` is what earlier hunks added; returns how much this one adds. */
function applyHunk(doc: Doc, h: Hunk, drift: number, path: string): number {
  const old = oldSide(h.rows);
  const added = h.rows.filter((r) => r.op !== 'drop').length;
  let reachesEnd: boolean;
  if (old.length === 0) {
    const at = Math.max(0, Math.min(h.a + drift, doc.lines.length));
    doc.lines.splice(at, 0, ...h.rows.map((r) => r.text));
    reachesEnd = at === doc.lines.length - added;
  } else {
    const hit = search(doc.lines, old);
    if (hit === null) throw new Fail('no-match', path);
    const aim = h.a - 1 + drift;
    const at = hit.at.reduce((best, p) => (Math.abs(p - aim) < Math.abs(best - aim) ? p : best));
    reachesEnd = at + old.length === doc.lines.length;
    doc.lines.splice(at, old.length, ...rewrite(doc.lines, at, hit.tier, h.rows));
  }
  if (reachesEnd) doc.final = !h.noEol;
  return added - old.length;
}

// ---- SEARCH/REPLACE blocks (section 7) ----

interface Block {
  path: string;
  search: string[];
  replace: string[];
}

/** The first line at or after `from` that, its trailing whitespace removed, is `marker`; -1 when none. */
function markerFrom(lines: readonly string[], from: number, marker: string): number {
  for (let i = from; i < lines.length; i++) if (lines[i]!.trimEnd() === marker) return i;
  return -1;
}

/** The path line of a block: the nearest line above `searchAt`, not above `floor`, that is not blank or a code fence. */
function pathAbove(lines: readonly string[], floor: number, searchAt: number): string | null {
  for (let q = searchAt - 1; q >= floor; q--) {
    const t = lines[q]!.trim();
    if (t !== '' && !t.startsWith('```')) return t;
  }
  return null;
}

function readBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let floor = 0; // the line after the previous block's REPLACE line
  let carried: string | null = null;
  for (;;) {
    const open = markerFrom(lines, floor, '<<<<<<< SEARCH');
    if (open < 0) return blocks;
    const mid = markerFrom(lines, open + 1, '=======');
    const close = mid < 0 ? -1 : markerFrom(lines, mid + 1, '>>>>>>> REPLACE');
    if (close < 0) throw parseAt(open);
    const path = pathAbove(lines, floor, open) ?? carried;
    if (path === null) throw parseAt(open);
    blocks.push({ path, search: lines.slice(open + 1, mid), replace: lines.slice(mid + 1, close) });
    carried = path;
    floor = close + 1;
  }
}

function applyBlock(tree: Tree, b: Block): void {
  if (b.search.length === 0) return create(tree, b.path, lfText(b.replace));
  const doc = openForChange(tree, b.path, null);
  const hit = search(doc.lines, b.search);
  if (hit === null) throw new Fail('no-match', b.path);
  if (hit.at.length > 1) throw new Fail('ambiguous', b.path);
  const rows: Row[] = [...b.search.map((text): Row => ({ op: 'drop', text })), ...b.replace.map((text): Row => ({ op: 'add', text }))];
  doc.lines.splice(hit.at[0]!, b.search.length, ...rewrite(doc.lines, hit.at[0]!, hit.tier, rows));
  tree.now.set(b.path, doc.text());
}

const srEdits = (lines: string[]): Edit[] => readBlocks(lines).map((b) => (tree: Tree) => applyBlock(tree, b));

// ---- V4A patches (section 8) ----

interface Chunk {
  anchor: string; // '' when there is none
  rows: Row[];
  atEof: boolean;
}

const V4A_HEADS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const headOf = (l: string): string | undefined => V4A_HEADS.find((h) => l.startsWith(h));
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

/** The chunks of an Update File section's body; `offset` is the patch line index of body[0]. */
function readChunks(body: readonly string[], offset: number): Chunk[] {
  const chunks: Chunk[] = [];
  const begin = (anchor: string): Chunk => {
    const c: Chunk = { anchor, rows: [], atEof: false };
    chunks.push(c);
    return c;
  };
  let open: Chunk | null = null; // the chunk that still takes lines; null before the first and after an end-of-file one
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.startsWith('@@')) open = begin(trimSpaces(b.slice(2)));
    else if (b.trim() === '*** End of File') {
      (open ?? begin('')).atEof = true;
      open = null;
    } else if (b === '' || ' -+'.includes(b[0]!)) {
      if (open === null) {
        if (chunks.length > 0) throw parseAt(offset + k);
        open = begin('');
      }
      open.rows.push(b === '' ? { op: 'keep', text: '' } : rowOf(b[0]!, b.slice(1)));
    } else throw parseAt(offset + k);
  }
  return chunks;
}

/** One chunk applied to `doc` from `cursor` on; returns the cursor after it. */
function applyChunk(doc: Doc, c: Chunk, cursor: number, path: string): number {
  if (c.anchor !== '') {
    const hit = search(doc.lines, [c.anchor], { from: cursor });
    if (hit === null) throw new Fail('no-match', path);
    cursor = hit.at[0]! + 1;
  }
  const old = oldSide(c.rows);
  if (old.length === 0) {
    const at = c.atEof ? doc.lines.length : Math.min(cursor, doc.lines.length);
    const lines = c.rows.map((r) => r.text);
    doc.lines.splice(at, 0, ...lines);
    return at + lines.length;
  }
  const hit = search(doc.lines, old, { from: cursor, tail: c.atEof });
  if (hit === null) throw new Fail('no-match', path);
  const at = hit.at[0]!;
  const written = rewrite(doc.lines, at, hit.tier, c.rows);
  doc.lines.splice(at, old.length, ...written);
  return at + written.length;
}

/** One section of a V4A patch as an edit; `at` is the index of its header line and `body` the lines after it. */
function v4aSection(head: string, path: string, body: readonly string[], at: number): Edit {
  if (head === '*** Add File: ') {
    const content = body.map((b, k) => {
      if (b === '') return '';
      if (b[0] === '+') return b.slice(1);
      throw parseAt(at + 1 + k);
    });
    return (tree) => create(tree, path, lfText(content));
  }
  if (head === '*** Delete File: ') {
    if (body.length > 0) throw parseAt(at + 1);
    return (tree) => erase(tree, path);
  }
  const moved = body.length > 0 && body[0]!.startsWith('*** Move to: ');
  const dest = moved ? trimSpaces(body[0]!.slice(13)) : null;
  const chunks = readChunks(moved ? body.slice(1) : body, at + (moved ? 2 : 1));
  if (chunks.length === 0 && dest === null) throw parseAt(at);
  return (tree) => {
    const doc = openForChange(tree, path, dest);
    let cursor = 0;
    for (const c of chunks) cursor = applyChunk(doc, c, cursor, path);
    save(tree, doc, path, dest);
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseAt(0);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseAt(first);
  const last = lines.findLastIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw parseAt(lines.length);
  const edits: Edit[] = [];
  for (let i = first + 1; i < last; ) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const head = headOf(lines[i]!);
    if (head === undefined) throw parseAt(i);
    let next = i + 1;
    while (next < last && headOf(lines[next]!) === undefined) next++;
    let end = next;
    while (end > i + 1 && blank(lines[end - 1]!)) end--; // blank lines that end a section are not part of it
    edits.push(v4aSection(head, trimSpaces(lines[i]!.slice(head.length)), lines.slice(i + 1, end), i));
    i = next;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  STRICT = strict;
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? srEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const nMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      tree.moves.length = nMoves;
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: [string, string][] = [];
  const asR = new Map<string, string>(); // new path -> old path
  const skip = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (skip.has(o) || skip.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      asR.set(n, o);
      skip.add(o);
      skip.add(n);
    }
  }
  const writes: [string, string | null][] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    writes.push([p, now]);
    if (asR.has(p)) rows.push([p, `R ${asR.get(p)} -> ${p}`]);
    else if (skip.has(p)) continue;
    else rows.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
  if (!check) {
    for (const [p, now] of writes) if (now === null) rmSync(p, { force: true });
    for (const [p, now] of writes) {
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r[1]), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
