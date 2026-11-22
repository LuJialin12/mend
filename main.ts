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

interface FileM {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileM {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function unparse(m: FileM): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const norm = [(s: string) => s, (s: string) => s.replace(/[ \t]+$/, ''), (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '')];
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Occurrences of o in lines (from position `from`) at the first tier that has one. */
function find(lines: string[], o: string[], from = 0, endOnly = false): { tier: number; pos: number[] } | null {
  const tiers = STRICT ? 1 : 3;
  for (let t = 0; t < tiers; t++) {
    const f = norm[t]!;
    const no = o.map(f);
    const nl = lines.map(f);
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (endOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (nl[i + k] !== no[k]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface Ent {
  kind: string; // ' ', '-', '+'
  text: string;
}

/** The lines N that replace the match of O at `pos` (SPEC.md section 5). */
function build(lines: string[], pos: number, tier: number, ents: Ent[]): string[] {
  const firstO = ents.find((e) => e.kind !== '+');
  const F = lead(lines[pos] ?? '');
  const P = firstO ? lead(firstO.text) : '';
  const out: string[] = [];
  let oi = 0;
  for (const e of ents) {
    if (e.kind === ' ') {
      out.push(lines[pos + oi]!);
      oi++;
    } else if (e.kind === '-') oi++;
    else if (tier === 2 && e.text.trim() !== '' && e.text.startsWith(P)) out.push(F + e.text.slice(P.length));
    else out.push(e.text);
  }
  return out;
}

const oOf = (ents: Ent[]): string[] => ents.filter((e) => e.kind !== '+').map((e) => e.text);

function load(tree: Tree, p: string): FileM {
  if (!safe(p)) throw new Fail('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return parseFile(t);
}

function fresh(tree: Tree, p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

function newFile(lines: string[], endBreak = true): string {
  return lines.length === 0 ? '' : lines.join('\n') + (endBreak ? '\n' : '');
}

// ---- unified diffs (section 6) ----

interface Hunk {
  a: number;
  body: { kind: string; text: string }[]; // kind ' ', '-', '+', '\\'
}
interface Section {
  oldP: string | null;
  newP: string | null;
  pair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

function gitPaths(rest: string): [string, string] | null {
  if (!rest.startsWith('a/')) return null;
  const both = rest.slice(2);
  const mid = (both.length - 3) / 2;
  if (Number.isInteger(mid) && mid >= 1 && both.slice(mid, mid + 3) === ' b/' && both.slice(0, mid) === both.slice(mid + 3)) return [both.slice(0, mid), both.slice(mid + 3)];
  const k = rest.indexOf(' b/');
  if (k < 2) return null;
  const x = rest.slice(2, k);
  const y = rest.slice(k + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function hdrPath(l: string): string | null {
  const t = l.slice(4).split('\t')[0]!.replace(/^ +| +$/g, '');
  return t === '/dev/null' ? null : stripAB(t);
}

function unifiedEdits(lines: string[]): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const gp = gitPaths(l.slice(11));
      if (gp === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: gp[0], newP: gp[1], pair: false, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [], inHeader: true };
      secs.push(cur);
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!(cur !== null && cur.inHeader && !cur.pair)) {
        cur = { oldP: null, newP: null, pair: false, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [], inHeader: true };
        secs.push(cur);
      }
      cur.oldP = hdrPath(l);
      cur.newP = hdrPath(lines[i + 1]!);
      cur.pair = true;
      i += 2;
    } else if (l.startsWith('@@')) {
      const mt = hunkRe.exec(l);
      if (mt === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      const body: Hunk['body'] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
        if (b === '') body.push({ kind: ' ', text: '' });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') body.push({ kind: b[0], text: b.slice(1) });
        else break;
        j++;
      }
      // empty lines at the end of a body are not part of it
      while (body.length > 0 && lines[i + body.length] === '') body.pop();
      cur.hunks.push({ a: Number(mt[1]), body });
      i = j;
    } else {
      if (cur !== null && cur.inHeader) {
        if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
        if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12);
        else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10);
        else if (l.startsWith('new file mode')) cur.isNew = true;
        else if (l.startsWith('deleted file mode')) cur.isDel = true;
      }
      i++;
    }
  }
  return secs.map(sectionEdit);
}

function sectionEdit(s: Section): Edit {
  let oldP = s.oldP;
  let newP = s.newP;
  if (!s.pair && (s.renameFrom !== null || s.renameTo !== null)) {
    if (s.renameFrom !== null) oldP = s.renameFrom;
    if (s.renameTo !== null) newP = s.renameTo;
  }
  const creation = s.isNew || (s.pair && s.oldP === null && s.newP !== null);
  const deletion = !creation && (s.isDel || (s.pair && s.newP === null && s.oldP !== null));
  if (creation) {
    const p = newP ?? '';
    return (tree) => {
      fresh(tree, p);
      const adds: string[] = [];
      let lastNoNl = false;
      for (const h of s.hunks) {
        h.body.forEach((b, k) => {
          if (b.kind === '+') {
            adds.push(b.text);
            lastNoNl = h.body[k + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, newFile(adds, !lastNoNl));
    };
  }
  if (deletion) {
    const p = oldP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const from = oldP ?? newP ?? '';
  const to = newP ?? oldP ?? '';
  const move = from !== to;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (move && !safe(to)) throw new Fail('unsafe', to);
    const m = load(tree, from);
    if (move && tree.get(to) !== null) throw new Fail('exists', to);
    let d = 0;
    for (const h of s.hunks) d = applyHunk(m, h, d, from);
    if (move) {
      tree.now.set(to, unparse(m));
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else tree.now.set(from, unparse(m));
  };
}

function applyHunk(m: FileM, h: Hunk, d: number, path: string): number {
  const ents: Ent[] = h.body.filter((b) => b.kind !== '\\');
  let lastNL = -1;
  h.body.forEach((b, k) => {
    if (b.kind === ' ' || b.kind === '+') lastNL = k;
  });
  const noNl = lastNL >= 0 && h.body[lastNL + 1]?.kind === '\\';
  const o = oOf(ents);
  const nLen = ents.filter((e) => e.kind !== '-').length;
  let atEnd: boolean;
  if (o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, m.lines.length));
    atEnd = at === m.lines.length;
    m.lines.splice(at, 0, ...ents.map((e) => e.text));
  } else {
    const r = find(m.lines, o);
    if (r === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = r.pos[0]!;
    for (const p of r.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    atEnd = best + o.length === m.lines.length;
    m.lines.splice(best, o.length, ...build(m.lines, best, r.tier, ents));
  }
  if (atEnd) m.final = !noNl;
  return d + nLen - o.length;
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let j = s + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (j >= lines.length || k >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let q = s - 1; q > prevEnd; q--) {
      const t = lines[q]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    prevPath = path;
    prevEnd = k;
    const old = lines.slice(s + 1, j);
    const neu = lines.slice(j + 1, k);
    const p = path;
    edits.push((tree) => {
      if (old.length === 0) {
        fresh(tree, p);
        tree.now.set(p, newFile(neu));
        return;
      }
      const m = load(tree, p);
      const r = find(m.lines, old);
      if (r === null) throw new Fail('no-match', p);
      if (r.pos.length > 1) throw new Fail('ambiguous', p);
      const ents: Ent[] = [...old.map((t) => ({ kind: '-', text: t })), ...neu.map((t) => ({ kind: '+', text: t }))];
      m.lines.splice(r.pos[0]!, old.length, ...build(m.lines, r.pos[0]!, r.tier, ents));
      tree.now.set(p, unparse(m));
    });
    i = k + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface Chunk {
  anchor: string;
  ents: Ent[];
  eof: boolean;
  closed: boolean;
}

function v4aEdits(lines: string[]): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch' || last === first) throw new Exit2(`error: parse ${n + 1}`);
  const isHead = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isHead(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isHead(lines[j]!)) j++;
    let e = j;
    while (e > i + 1 && blank(lines[e - 1]!)) e--;
    const body = lines.slice(i + 1, e);
    const base = i + 1; // body[k] is patch line base + k + 1
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).replace(/^ +| +$/g, '');
      const out: string[] = [];
      body.forEach((b, k) => {
        if (b === '') out.push('');
        else if (b[0] === '+') out.push(b.slice(1));
        else throw new Exit2(`error: parse ${base + k + 1}`);
      });
      edits.push((tree) => {
        fresh(tree, p);
        tree.now.set(p, newFile(out));
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).replace(/^ +| +$/g, '');
      if (body.length > 0) throw new Exit2(`error: parse ${base + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = l.slice(17).replace(/^ +| +$/g, '');
      let mv: string | null = null;
      let b0 = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        mv = body[0]!.slice(13).replace(/^ +| +$/g, '');
        b0 = 1;
      }
      const chunks: Chunk[] = [];
      let c: Chunk | null = null;
      for (let k = b0; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith('@@')) {
          c = { anchor: b.slice(2).replace(/^ +| +$/g, ''), ents: [], eof: false, closed: false };
          chunks.push(c);
        } else if (b.trim() === '*** End of File') {
          if (c === null || c.closed) {
            c = { anchor: '', ents: [], eof: false, closed: false };
            chunks.push(c);
          }
          c.eof = true;
          c.closed = true;
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (c === null || c.closed) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${base + k + 1}`);
            c = { anchor: '', ents: [], eof: false, closed: false };
            chunks.push(c);
          }
          c.ents.push(b === '' ? { kind: ' ', text: '' } : { kind: b[0]!, text: b.slice(1) });
        } else throw new Exit2(`error: parse ${base + k + 1}`);
      }
      if (chunks.length === 0 && mv === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const m = load(tree, p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== '') {
            let found = -1;
            for (let t = 0; t < (STRICT ? 1 : 3) && found < 0; t++) {
              const f = norm[t]!;
              const a = f(ch.anchor);
              for (let q = cursor; q < m.lines.length; q++) {
                if (f(m.lines[q]!) === a) {
                  found = q;
                  break;
                }
              }
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          const o = oOf(ch.ents);
          if (o.length === 0) {
            const at = ch.eof ? m.lines.length : Math.min(cursor, m.lines.length);
            const ins = ch.ents.map((x) => x.text);
            m.lines.splice(at, 0, ...ins);
            cursor = at + ins.length;
          } else {
            const r = find(m.lines, o, cursor, ch.eof);
            if (r === null) throw new Fail('no-match', p);
            const pos = r.pos[0]!;
            const rep = build(m.lines, pos, r.tier, ch.ents);
            m.lines.splice(pos, o.length, ...rep);
            cursor = pos + rep.length;
          }
        }
        if (mv !== null) {
          tree.now.set(mv, unparse(m));
          tree.now.set(p, null);
          tree.moves.push([p, mv]);
        } else tree.now.set(p, unparse(m));
      });
    }
    i = j;
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
