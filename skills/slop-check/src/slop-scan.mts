#!/usr/bin/env node
/**
 * slop-scan — deterministic metrics for the slop-check skill.
 *
 * Dependency-free (Node 18+). Walks a repo, builds a best-effort import graph,
 * and emits metrics + pre-computed subscores for the script-owned scoring
 * categories (coupling, duplication, dead weight, AI tells).
 *
 * Usage: node slop-scan.mjs <root> [--out <path>]
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, extname, dirname, basename, resolve, sep } from 'node:path';

interface FileEntry { rel: string; abs: string; lang: string; ext: string; }
interface FileData {
  lang: string;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  tells: number;
  debugLeftovers: number;
  commentedOutCode: number;
  isScriptEntry: boolean;
  importSpecs: string[];
}
interface DupWindow { hash: string; startLine: number; }
interface TellExample { file: string; line: number; kind: string; text: string; }
interface MapFileEntry {
  lang: string;
  codeLines: number;
  importedBy: string[];
  imports: string[];
  flags?: string[];
}

// ---------------------------------------------------------------------------
// CLI

const argv: string[] = process.argv.slice(2);
const root: string = resolve(argv.find((a) => !a.startsWith('--')) ?? process.cwd());
const outFlag: number = argv.indexOf('--out');
const outPath: string = outFlag !== -1 ? resolve(argv[outFlag + 1]) : join(root, '.slop-check', 'metrics.json');

if (!existsSync(root)) {
  console.error(`slop-scan: root does not exist: ${root}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config

const MAX_FILES = 50000;
const MAX_FILE_BYTES = 1_200_000;
const DUP_WINDOW = 6; // lines per duplication window
const DUP_MIN_CHARS = 60; // ignore trivial windows
const MAX_TELL_EXAMPLES = 200;

const IGNORE_DIRS = new Set<string>([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'vendor', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', '.DS_Store', 'bower_components', '.gradle', '.dart_tool',
  '.slop-check', '.understand-anything', 'Pods', 'DerivedData', '.terraform',
]);

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp', '.php': 'php',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.swift': 'swift', '.scala': 'scala', '.vue': 'vue', '.svelte': 'svelte',
  '.dart': 'dart', '.lua': 'lua', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
};

// Languages whose relative imports we resolve into the graph.
const RESOLVABLE = new Set<string>(['typescript', 'javascript', 'python', 'vue', 'svelte']);

const HASH_COMMENT_LANGS = new Set<string>(['python', 'ruby', 'shell']);

const AI_TELL_PATTERNS: Array<[string, RegExp]> = [
  ['narration', /(?:\/\/|#)\s*(?:loop through|iterate over|return the|create a new|initialize the|get the|set the|check if the|call the|define the|import the)\b/i],
  ['tutorial-voice', /(?:\/\/|#)\s*(?:first,? we|next,? we|now,? we|as you can see|here,? we|let's)\b/i],
  ['hedge-apology', /(?:\/\/|#|\*)\s*(?:in a real(?:-world)? (?:app|application|scenario|project)|for simplicity|this is a simplified|in production,? you (?:would|should)|for demo purposes|for the sake of)/i],
  ['placeholder', /(?:TODO:?\s*(?:implement|add) (?:actual|real|proper|the actual)|YOUR_API_KEY|your-api-key-here|REPLACE_ME|lorem ipsum)/i],
  ['emoji-header', /^\s*(?:\/\/|#)\s*[\u{1F300}-\u{1FAFF}\u{2728}\u{2705}\u{26A0}\u{2B50}]/u],
];
// Tell patterns run against the comment part of a line only (string literals stripped), except
// `placeholder`, which also hunts quoted template values. "Note that" was dropped from
// tutorial-voice and `<your ...>` from placeholder after real-repo audits showed they mostly hit
// human why-comments and format hints.

// Tests, benchmarks, examples and scripts log and copy code on purpose.
const NON_PRODUCT_PATH = /(^|\/)(tests?|__tests__|spec|e2e|runtime-tests|bench(?:mark)?s?|examples?|samples?|demos?|playground|fixtures?|scripts?)\//i;
// A line that defines a regex: tell patterns here are the detector, not the slop.
// A slash after `=`, `(`, `,` etc. followed directly by a non-space is a regex literal, not division.
const REGEX_DEFINITION_LINE = /(?:[=(,:[|&!]\s*|^)\/[^/*\s]|new RegExp\(/;
const GENERATED_HEADER = /@generated\b|\bdo not edit\b|^\s*(?:\/\/|#|\/\*|\*)\s*(?:this file (?:is|was|has been) )?(?:auto-?)?generated (?:by|from|with)\b/im;
const GENERATED_NAME = /\.(?:generated|gen)\.[^./]+$/;

// Display names for the canonical language ids, so reports read "TypeScript", not "typescript".
const LANG_DISPLAY: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', ruby: 'Ruby',
  go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', csharp: 'C#', php: 'PHP',
  c: 'C', cpp: 'C++', swift: 'Swift', scala: 'Scala', vue: 'Vue', svelte: 'Svelte',
  dart: 'Dart', lua: 'Lua', shell: 'Shell',
};
const langName = (id: string): string => LANG_DISPLAY[id] ?? (id.charAt(0).toUpperCase() + id.slice(1));

const ENTRY_BASENAME = /^(index|main|app|server|cli|run|setup|conftest|manage|wsgi|asgi|__init__|__main__|vite|next|webpack|rollup|babel|jest|vitest|playwright|tailwind|postcss|eslint|prettier)\b/i;
const ENTRY_PATH = /(^|\/)(pages|app|routes|api|scripts?|bin|tools?|tests?|__tests__|spec|e2e|examples?|samples?|demos?|migrations|seeds?|stories|\.storybook|commands|tasks|jobs|workers|functions|lambdas?|hooks|plugins|docs)(\/|$)/i;
const TEST_FILE = /\.(test|spec|stories)\.[^.]+$|_test\.[^.]+$|test_[^/]+\.py$/i;
const UTILS_SEGMENT = /^(utils?|helpers?|common|misc|shared|lib)$/i;
const UTILS_BASENAME = /^(utils?|helpers?|misc|common)\d*(\.|$)/i;

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, Math.round(n)));

// ---------------------------------------------------------------------------
// Ignore + generated-file rules (.gitignore, .gitattributes, tsconfig outDir)

/** gitignore-style glob -> RegExp over root-relative paths. Best-effort: no negation, no char classes. */
function globToRegExp(glob: string): RegExp {
  const trimmed = glob.trim().replace(/\/$/, '');
  const anchored = trimmed.startsWith('/') || trimmed.includes('/');
  const g = trimmed.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern also matches everything beneath a matching directory.
  return new RegExp(anchored ? `^${re}(?:/.*)?$` : `(?:^|/)${re}(?:/.*)?$`);
}

function readRootLines(name: string): string[] {
  try {
    return readFileSync(join(root, name), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

interface TsConfig { compilerOptions?: { outDir?: unknown } }

function readJsonLoose<T>(path: string): T | null {
  try {
    // tsconfig is JSONC: strip line comments and trailing commas before parsing.
    const text = readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text) as T;
  } catch { return null; }
}

const ignoreRes: RegExp[] = readRootLines('.gitignore').filter((l) => !l.startsWith('!')).map(globToRegExp);

// Build output and vendored code are not the author's code: excluding them keeps committed
// compiled twins (src/*.ts -> scripts/*.js) from scoring as copy-paste duplication.
const generatedRes: RegExp[] = [];
for (const line of readRootLines('.gitattributes')) {
  const [pattern, ...attrs] = line.split(/\s+/);
  if (attrs.some((a) => /^linguist-(?:generated|vendored)(?:=true)?$/.test(a))) generatedRes.push(globToRegExp(pattern));
}
const rootTsconfig = readJsonLoose<TsConfig>(join(root, 'tsconfig.json'));
const outDir = rootTsconfig?.compilerOptions?.outDir;
if (typeof outDir === 'string') {
  const rel = outDir.replace(/^\.\//, '').replace(/\/$/, '');
  if (rel && rel !== '.' && !rel.startsWith('..')) generatedRes.push(globToRegExp('/' + rel));
}

// ---------------------------------------------------------------------------
// Walk

const files: FileEntry[] = [];
let generatedExcluded = 0;
let truncated = false;

function walk(dir: string): void {
  if (files.length >= MAX_FILES) { truncated = true; return; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (files.length >= MAX_FILES) { truncated = true; return; }
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (e.name.startsWith('.') && e.isDirectory() && e.name !== '.github') continue;
    if (IGNORE_DIRS.has(e.name) || ignoreRes.some((r) => r.test(rel))) continue;
    if (e.isDirectory()) { walk(abs); continue; }
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue; // only analyze recognized code files
    if (GENERATED_NAME.test(e.name) || generatedRes.some((r) => r.test(rel))) { generatedExcluded++; continue; }
    let size: number;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    files.push({ rel, abs, lang, ext });
  }
}
walk(root);

// ---------------------------------------------------------------------------
// Per-file analysis

const fileData = new Map<string, FileData>();
const tellExamples: TellExample[] = [];
const dupIndex = new Map<string, Set<string>>();
const dupWindowsByFile = new Map<string, DupWindow[]>();

function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36);
}

const prevNonBlank = (lines: string[], i: number): string => {
  for (let j = i - 1; j >= 0; j--) { const t = lines[j].trim(); if (t) return t; }
  return '';
};

function extractImports(lang: string, lines: string[]): string[] {
  const specs: string[] = [];
  let inBlockComment = false;
  let inTypeOnlyImport = false;
  for (const line of lines) {
    // Imports quoted in JSDoc/docstring-style usage examples are not real edges.
    if (inBlockComment) { if (line.includes('*/')) inBlockComment = false; continue; }
    if (/^\s*\/\*/.test(line)) { inBlockComment = !line.includes('*/'); continue; }
    if (/^\s*(?:\*|\/\/|#)/.test(line)) continue;
    if (lang === 'typescript' || lang === 'javascript' || lang === 'vue' || lang === 'svelte') {
      // Type-only imports vanish at runtime, so they make no real edge (and no false cycles).
      if (/^\s*(?:import|export)\s+type\b/.test(line)) { inTypeOnlyImport = !/['"]/.test(line); continue; }
      // Closing line of a multi-line import/export: `} from './x'`.
      const close = line.match(/^\s*\}\s*from\s*['"]([^'"]+)['"]/);
      if (close) { if (!inTypeOnlyImport) specs.push(close[1]); inTypeOnlyImport = false; continue; }
      const m = line.match(/(?:\bimport\s[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s+(?=['"])|\brequire(?:\.resolve)?\s*\(\s*|\bexport\s[^'"]*?\bfrom\s*)['"]([^'"]+)['"]/);
      if (m) specs.push(m[1]);
    } else if (lang === 'python') {
      let m = line.match(/^\s*from\s+([\w.]+)\s+import\b/);
      if (m) specs.push(m[1]);
      m = line.match(/^\s*import\s+([\w.]+)/);
      if (m) specs.push(m[1]);
    }
  }
  return specs;
}

for (const f of files) {
  let text: string;
  try { text = readFileSync(f.abs, 'utf8'); } catch { continue; }
  const lines = text.split('\n');

  // Skip minified/generated
  const avgLen = text.length / Math.max(1, lines.length);
  if (avgLen > 250) continue;
  if (GENERATED_HEADER.test(lines.slice(0, 5).join('\n'))) { generatedExcluded++; continue; }

  // Standalone scripts are entry points, not dead code — and their console output is the product.
  const isScriptEntry = text.startsWith('#!')
    || text.includes('process.argv')
    || text.includes("__name__ == '__main__'")
    || text.includes('__name__ == "__main__"');
  const isTest = TEST_FILE.test(f.rel) || /(^|\/)(tests?|__tests__|spec)\//.test(f.rel);
  const isProduct = !isTest && !NON_PRODUCT_PATH.test(f.rel);

  const hashComments = HASH_COMMENT_LANGS.has(f.lang);
  let blank = 0, comment = 0, commentedOutCode = 0, inBlock = 0;
  let tells = 0, debugLeftovers = 0;
  const codeLinesNorm: Array<[string, number]> = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) { blank++; continue; }

    let isComment = false;
    if (inBlock > 0) {
      isComment = true;
      if (t.includes('*/')) inBlock = 0;
    } else if (hashComments ? t.startsWith('#') : (t.startsWith('//') || t.startsWith('*'))) {
      isComment = true;
    } else if (!hashComments && t.startsWith('/*')) {
      isComment = true;
      if (!t.includes('*/')) inBlock = 1;
    }

    // AI tells live in comments: match the comment part only, with string literals stripped,
    // so URLs ("https://..."), markdown in template strings, and quoted examples don't count.
    const definesRegex = REGEX_DEFINITION_LINE.test(t);
    let commentPart = '';
    if (isComment) commentPart = t;
    else {
      const noStrings = t.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
      const at = hashComments ? noStrings.search(/(?:^|\s)#/) : noStrings.indexOf('//');
      if (at !== -1) commentPart = noStrings.slice(at).trim();
    }
    for (const [kind, re] of definesRegex ? [] : AI_TELL_PATTERNS) {
      const target = kind === 'placeholder' ? t : commentPart;
      if (!target) continue;
      // A narrating-looking comment that gives a reason is a why-comment, not narration.
      if (kind === 'narration' && /\b(?:because|so that|instead of|not only|otherwise|since)\b/i.test(target)) continue;
      if (re.test(target)) {
        tells++;
        if (tellExamples.length < MAX_TELL_EXAMPLES) {
          tellExamples.push({ file: f.rel, line: i + 1, kind, text: t.slice(0, 140) });
        }
        break;
      }
    }

    if (isComment) {
      comment++;
      // Line comments only: block/JSDoc lines (`* @returns {X}`, @example code) are documentation.
      const isLineComment = hashComments ? t.startsWith('#') : t.startsWith('//');
      const body = t.replace(/^(\/\/|#)\s?/, '');
      if (isProduct && isLineComment && (/^(const |let |var |if\s*\(|for\s*\(|while\s*\(|return |function |def |class |import |from\s+\S+\s+import|console\.|await |\}\s*else)/.test(body) || /[;{}]\s*$/.test(body))) {
        commentedOutCode++;
      }
      continue;
    }

    // Logging in CLIs, tests, examples and benches is output, not a leftover.
    if ((!isScriptEntry && isProduct && /\bconsole\.log\s*\(/.test(t) && !/no-console/.test(prevNonBlank(lines, i)))
      || /^debugger\s*;?$/.test(t)) debugLeftovers++;

    const norm = t.replace(/\s+/g, ' ');
    codeLinesNorm.push([norm, i + 1]);
  }

  // Duplication windows
  const windows: DupWindow[] = [];
  // Product code only: examples and tests are copied on purpose so each stands alone.
  if (isProduct) {
    for (let i = 0; i + DUP_WINDOW <= codeLinesNorm.length; i++) {
      const chunk = codeLinesNorm.slice(i, i + DUP_WINDOW).map((c) => c[0]).join('\n');
      if (chunk.length < DUP_MIN_CHARS) continue;
      const h = fnv(chunk);
      windows.push({ hash: h, startLine: codeLinesNorm[i][1] });
      if (!dupIndex.has(h)) dupIndex.set(h, new Set());
      dupIndex.get(h)!.add(f.rel);
    }
  }
  dupWindowsByFile.set(f.rel, windows);

  fileData.set(f.rel, {
    lang: f.lang,
    totalLines: lines.length,
    codeLines: codeLinesNorm.length,
    commentLines: comment,
    tells, debugLeftovers, commentedOutCode,
    isScriptEntry,
    importSpecs: extractImports(f.lang, lines),
  });
}

// ---------------------------------------------------------------------------
// Import graph (relative imports for JS/TS/Python; '@/' and 'src/' aliases)

const fileSet = new Set<string>(fileData.keys());
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

function resolveJs(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = join(dirname(fromRel), spec).split(sep).join('/');
  } else if (spec.startsWith('@/')) {
    base = 'src/' + spec.slice(2);
  } else if (spec.startsWith('~/')) {
    base = 'src/' + spec.slice(2);
  } else return null;
  base = base.replace(/\\/g, '/');
  const candidates = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => base + '/index' + e)];
  // NodeNext TS style: `import './x.js'` refers to x.ts on disk
  const jsToTs = base.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
  if (jsToTs) candidates.push(jsToTs[1] + '.ts', jsToTs[1] + '.tsx', jsToTs[1] + '.mts');
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

function resolvePy(fromRel: string, spec: string): string | null {
  const fromDir = dirname(fromRel);
  const asPath = spec.replace(/^\.+/, (dots) => '../'.repeat(Math.max(0, dots.length - 1))).replace(/\./g, '/');
  const candidates: string[] = [];
  if (spec.startsWith('.')) {
    candidates.push(join(fromDir, asPath).split(sep).join('/'));
  } else {
    candidates.push(spec.replace(/\./g, '/'));
    candidates.push('src/' + spec.replace(/\./g, '/'));
  }
  for (const base of candidates) {
    for (const c of [base + '.py', base + '/__init__.py']) if (fileSet.has(c)) return c;
  }
  return null;
}

const edges: Array<[string, string]> = [];
const fanOut = new Map<string, Set<string>>();
const fanIn = new Map<string, Set<string>>();
for (const rel of fileSet) { fanOut.set(rel, new Set()); fanIn.set(rel, new Set()); }

for (const [rel, data] of fileData) {
  if (!RESOLVABLE.has(data.lang)) continue;
  for (const spec of data.importSpecs) {
    const target = data.lang === 'python' ? resolvePy(rel, spec) : resolveJs(rel, spec);
    if (target && target !== rel && !fanOut.get(rel)!.has(target)) {
      fanOut.get(rel)!.add(target);
      fanIn.get(target)!.add(rel);
      edges.push([rel, target]);
    }
  }
}

// Cycles via Tarjan SCC
function tarjanSCCs(): string[][] {
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const nodes = [...fileSet];

  for (const start of nodes) {
    if (index.has(start)) continue;
    // iterative Tarjan
    const work: Array<[string, number]> = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, pi] = frame;
      if (pi === 0) {
        index.set(v, idx); low.set(v, idx); idx++;
        stack.push(v); onStack.add(v);
      }
      const neighbors = [...fanOut.get(v)!];
      let recursed = false;
      for (let i = pi; i < neighbors.length; i++) {
        const w = neighbors[i];
        if (!index.has(w)) {
          frame[1] = i + 1;
          work.push([w, 0]);
          recursed = true;
          break;
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (recursed) continue;
      if (low.get(v) === index.get(v)) {
        const scc: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); scc.push(w); } while (w !== v);
        if (scc.length > 1) sccs.push(scc);
      }
      work.pop();
      if (work.length) {
        const [parent] = work[work.length - 1];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
    }
  }
  return sccs;
}

const sccs = tarjanSCCs().sort((a, b) => b.length - a.length);

// God files
const resolvableFiles: Array<[string, FileData]> = [...fileData.entries()].filter(([, d]) => RESOLVABLE.has(d.lang));
const degrees: Array<[string, number]> = [...fileSet].map((rel): [string, number] => [rel, fanIn.get(rel)!.size + fanOut.get(rel)!.size]);
const avgDegree = degrees.reduce((s, [, d]) => s + d, 0) / Math.max(1, resolvableFiles.length);
const godThreshold = Math.max(12, Math.ceil(avgDegree * 4));
const godFiles = degrees
  .filter(([, d]) => d >= godThreshold)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([rel, d]) => ({ file: rel, fanIn: fanIn.get(rel)!.size, fanOut: fanOut.get(rel)!.size, degree: d }));

// Orphans (only meaningful among resolvable langs and when a graph exists)
let orphans: Array<{ file: string; codeLines: number }> = [];
if (edges.length >= 5) {
  orphans = resolvableFiles
    .filter(([rel]) => fanIn.get(rel)!.size === 0)
    .filter(([rel, d]) => {
      const name = basename(rel);
      return !d.isScriptEntry && !ENTRY_BASENAME.test(name) && !ENTRY_PATH.test(rel)
        && !TEST_FILE.test(rel) && !rel.endsWith('.d.ts') && !/config|rc\./i.test(name);
    })
    .map(([rel, d]) => ({ file: rel, codeLines: d.codeLines }))
    .sort((a, b) => b.codeLines - a.codeLines)
    .slice(0, 30);
}

// Duplication totals
let dupLines = 0, totalCodeLines = 0;
const dupFilePairs = new Set<string>();
for (const [rel, data] of fileData) {
  totalCodeLines += data.codeLines;
  const windows = dupWindowsByFile.get(rel) ?? [];
  const dupLineSet = new Set<number>();
  for (const w of windows) {
    const sharers = dupIndex.get(w.hash);
    if (sharers && sharers.size > 1) {
      for (let k = 0; k < DUP_WINDOW; k++) dupLineSet.add(w.startLine + k);
      for (const other of sharers) if (other !== rel) dupFilePairs.add([rel, other].sort().join('|'));
    }
  }
  dupLines += dupLineSet.size;
}
const dupRatio = totalCodeLines ? dupLines / totalCodeLines : 0;

// Worst duplication clusters (for findings)
// Size = distinct covered lines in the cluster's first file (overlapping windows counted once).
const clusterLines = new Map<string, Set<number>>();
for (const [rel, windows] of dupWindowsByFile) {
  for (const w of windows) {
    const sharers = dupIndex.get(w.hash);
    if (!sharers || sharers.size < 2) continue;
    const members = [...sharers].sort();
    if (members[0] !== rel) continue;
    const key = members.join(' <-> ');
    if (!clusterLines.has(key)) clusterLines.set(key, new Set());
    for (let k = 0; k < DUP_WINDOW; k++) clusterLines.get(key)!.add(w.startLine + k);
  }
}
const topDupClusters = [...clusterLines.entries()]
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 8)
  .map(([pair, covered]) => ({ files: pair.split(' <-> '), approxDupLines: covered.size }));

// Aggregate counts
let tells = 0, debugLeftovers = 0, commentedOutCode = 0, totalLines = 0;
const langTotals = new Map<string, number>();
const utilsFiles: string[] = [];
const giantFiles: Array<{ file: string; codeLines: number }> = [];
for (const [rel, d] of fileData) {
  tells += d.tells; debugLeftovers += d.debugLeftovers; commentedOutCode += d.commentedOutCode;
  totalLines += d.totalLines;
  langTotals.set(d.lang, (langTotals.get(d.lang) ?? 0) + d.codeLines);
  const segs = rel.split('/');
  if (segs.slice(0, -1).some((s) => UTILS_SEGMENT.test(s)) || UTILS_BASENAME.test(basename(rel))) utilsFiles.push(rel);
  if (d.codeLines > 400) giantFiles.push({ file: rel, codeLines: d.codeLines });
}
giantFiles.sort((a, b) => b.codeLines - a.codeLines);
const utilsDirs = new Set<string>(utilsFiles.map((f) => dirname(f)));
const kloc = Math.max(0.25, totalCodeLines / 1000);
const codeFileCount = fileData.size;

// ---------------------------------------------------------------------------
// Subscores (0 = pristine, 100 = max slop) — formulas documented in SCORING.md

const graphMeaningful = edges.length >= 5 && resolvableFiles.length >= 10;
const cycleFiles = sccs.reduce((s, c) => s + c.length, 0);

const subscores = {
  coupling: graphMeaningful
    ? clamp(sccs.length * 12 + (cycleFiles / resolvableFiles.length) * 120 + (godFiles.length / codeFileCount) * 350)
    : null,
  duplication: clamp(dupRatio * 400),
  deadWeight: clamp(
    (graphMeaningful ? (orphans.length / Math.max(1, resolvableFiles.length)) * 280 : 0)
    + (commentedOutCode / kloc) * 6,
  ),
  aiTells: clamp((tells / kloc) * 14 + (debugLeftovers / kloc) * 3),
};

// ---------------------------------------------------------------------------
// Sample suggestions for the taste pass (deterministic)

// Sample ~12% of code files (min 10, max 300). The ceiling is a context limit,
// not a taste call: ~50 deeply-read files per reviewer x 6 reviewers max — beyond
// that, reviewers skim instead of read. Mix: most-connected files, largest files,
// highest AI-tell files, plus an even spread across the whole tree.
const sampleCap = Math.max(10, Math.min(300, Math.round(codeFileCount * 0.12)));
const nDegree = Math.ceil(sampleCap * 0.30);
const nSize = Math.ceil(sampleCap * 0.15);
const nTells = Math.ceil(sampleCap * 0.15);
const nSpread = Math.ceil(sampleCap * 0.45);
const byDegree = degrees.slice().sort((a, b) => b[1] - a[1]).slice(0, nDegree).map(([rel]) => rel);
const bySize = [...fileData.entries()].sort((a, b) => b[1].codeLines - a[1].codeLines).slice(0, nSize).map(([rel]) => rel);
const byTells = [...fileData.entries()].filter(([, d]) => d.tells > 0).sort((a, b) => b[1].tells - a[1].tells).slice(0, nTells).map(([rel]) => rel);
const all = [...fileData.keys()].sort();
const spread = Array.from({ length: nSpread }, (_, i) => all[Math.floor(((i + 0.5) / nSpread) * (all.length - 1))]);
const sampleSuggestions = [...new Set([...byDegree, ...bySize, ...byTells, ...spread])].filter(Boolean).slice(0, sampleCap);

// ---------------------------------------------------------------------------
// Output

const result = {
  tool: 'slop-scan',
  version: 1,
  root,
  truncated,
  totals: {
    codeFiles: codeFileCount,
    // Build output / vendored / generated files skipped (via .gitattributes linguist-generated,
    // tsconfig outDir, *.generated.* names, or a generated header).
    generatedExcluded,
    totalLines,
    codeLines: totalCodeLines,
    languages: Object.fromEntries([...langTotals.entries()].sort((a, b) => b[1] - a[1])),
    // Ready-to-use shares to one decimal place, so the report shows e.g. TypeScript 99.7%
    // / JavaScript 0.3% instead of rounding a real second language down to nothing.
    // Copy this straight into the report payload's project.languages.
    languagePercents: [...langTotals.entries()]
      .map(([id, lines]) => ({ name: langName(id), pct: Math.round((lines / Math.max(1, totalCodeLines)) * 1000) / 10 }))
      .filter((l) => l.pct >= 0.1)
      .sort((a, b) => b.pct - a.pct),
  },
  graph: {
    meaningful: graphMeaningful,
    resolvableFiles: resolvableFiles.length,
    edges: edges.length,
    cycles: sccs.slice(0, 10).map((c) => ({ size: c.length, files: c.slice(0, 8) })),
    cycleCount: sccs.length,
    godFiles,
    godThreshold,
    orphans,
  },
  duplication: {
    duplicatedLines: dupLines,
    ratio: +dupRatio.toFixed(4),
    crossFilePairs: dupFilePairs.size,
    topClusters: topDupClusters,
  },
  aiTells: {
    count: tells,
    perKloc: +(tells / kloc).toFixed(2),
    debugLeftovers,
    examples: tellExamples,
  },
  deadWeight: {
    commentedOutCode,
    commentedOutPerKloc: +(commentedOutCode / kloc).toFixed(2),
    orphanCount: orphans.length,
  },
  hygiene: {
    utilsFiles: utilsFiles.length,
    utilsDirs: [...utilsDirs].slice(0, 10),
    giantFiles: giantFiles.slice(0, 10),
  },
  subscores,
  sampleSuggestions,
};

// ---------------------------------------------------------------------------
// The Slop Map: the full per-file knowledge the scan produced, written separately
// so metrics.json stays small enough to read whole. Downstream fixing agents
// consult this instead of re-exploring the repo — the tokens were already spent.

const godSet = new Set<string>(godFiles.map((g) => g.file));
const orphanSet = new Set<string>(orphans.map((o) => o.file));
const giantSet = new Set<string>(giantFiles.map((g) => g.file));
const dupSet = new Set<string>(topDupClusters.flatMap((c) => c.files));
const utilsSet = new Set<string>(utilsFiles);

const mapFiles: Record<string, MapFileEntry> = {};
for (const [rel, d] of fileData) {
  const flags: string[] = [];
  if (godSet.has(rel)) flags.push('god-file');
  if (orphanSet.has(rel)) flags.push('possible-orphan');
  if (giantSet.has(rel)) flags.push('giant');
  if (dupSet.has(rel)) flags.push('in-dup-cluster');
  if (utilsSet.has(rel)) flags.push('utils');
  mapFiles[rel] = {
    lang: d.lang,
    codeLines: d.codeLines,
    importedBy: [...fanIn.get(rel)!].sort(),
    imports: [...fanOut.get(rel)!].sort(),
    ...(flags.length ? { flags } : {}),
  };
}

const slopMap = {
  tool: 'slop-check',
  kind: 'slop-map',
  version: 1,
  root,
  note: 'Per-file import graph + flags from the last slop-check run. Consult before moving, renaming, or refactoring files — importedBy tells you the blast radius.',
  cycles: sccs.slice(0, 25).map((c) => c.slice(0, 12)),
  dupClusters: topDupClusters,
  files: mapFiles,
};
const mapPath = join(dirname(outPath), 'slop-map.json');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
writeFileSync(mapPath, JSON.stringify(slopMap, null, 1));
console.log(`slop-scan: analyzed ${codeFileCount} code files (${totalCodeLines.toLocaleString()} code lines; ${generatedExcluded} generated/vendored skipped)`);
console.log(`slop-scan: wrote slop map (${Object.keys(mapFiles).length} files, ${edges.length} edges) to ${mapPath}`);
console.log(`slop-scan: subscores — coupling=${subscores.coupling ?? 'n/a'} duplication=${subscores.duplication} deadWeight=${subscores.deadWeight} aiTells=${subscores.aiTells}`);
console.log(`slop-scan: wrote ${outPath}`);
