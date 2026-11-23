import fs from 'node:fs';
import path from 'node:path';

// プロジェクト(サンプル・アプリ作成など)の登録。名簿・表示設定は projects/{id}/ に置く。
// マルチプロジェクト設計書(非公開) の4章。

export const DEFAULT_PROJECT = 'demo';
export const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const insideOrSame = (root, p) => { const a = norm(root); const b = norm(p); return b === a || b.startsWith(a + path.sep); };

// Claude Code が ~/.claude/projects 配下に作るフォルダ名: パスの英数字以外を1文字ずつ - にする(実測で確認)
export const claudeDirName = (root) => path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');

const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// projects/{id}/project.json と roster.json を読む。
// 互換: demo は projects/demo/ が無ければ従来の office 直下の roster.json を使う。
// 戻り値: Map<id, { id, name, color, root(絶対パス | null), roster }>
export function loadProjects({ projectsDir, legacyRosterPath, defaultRoot, warn = console.warn }) {
  const out = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (e) { warn(`[projects] ${projectsDir} を読めません(${e.code ?? e.message})。demo だけ使います`); }
  for (const id of dirs) {
    if (id.startsWith('_') || id.startsWith('.')) continue; // _template など。プロジェクトではない
    if (!ID_RE.test(id)) { warn(`[projects] ${id}: フォルダ名が規則(小文字英字で始まり、小文字英数字・_・-、32文字以内)に合わないため読みません`); continue; }
    const dir = path.join(projectsDir, id);
    let meta;
    let roster;
    try {
      meta = readJsonFile(path.join(dir, 'project.json'));
      roster = readJsonFile(path.join(dir, 'roster.json'));
    } catch (e) { warn(`[projects] ${id}: project.json / roster.json を読めないため読みません(${e.code === 'ENOENT' ? 'ファイルがありません' : e.message})`); continue; } // 壊れた1件で他を止めない
    if (meta?.id !== id) { warn(`[projects] ${id}: project.json の id(${JSON.stringify(meta?.id)})がフォルダ名と違うため読みません`); continue; }
    if (!Array.isArray(roster?.members)) { warn(`[projects] ${id}: roster.json に members の配列がないため読みません`); continue; }
    const root = id === DEFAULT_PROJECT && defaultRoot ? path.resolve(defaultRoot) : typeof meta.root === 'string' && meta.root ? path.resolve(dir, meta.root) : null;
    out.set(id, { id, name: String(meta.name ?? id), color: String(meta.color ?? ''), root, roster });
  }
  if (!out.has(DEFAULT_PROJECT)) {
    out.set(DEFAULT_PROJECT, { id: DEFAULT_PROJECT, name: 'サンプルプロジェクト', color: '', root: defaultRoot ? path.resolve(defaultRoot) : null, roster: readJsonFile(legacyRosterPath) });
  }
  return out;
}

// transcript(~/.claude/projects/<名前>/...)の最初のフォルダ名が、プロジェクトのルートの名前か、その後に - で続く名前(サブフォルダ起動)なら、そのプロジェクトのもの
export function transcriptInProject(allowedRoot, root, p) {
  if (!root || typeof p !== 'string') return false;
  const rel = path.relative(path.resolve(allowedRoot), path.resolve(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const seg = norm(rel.split(path.sep)[0]);
  const name = norm(claudeDirName(root));
  return seg === name || seg.startsWith(name + '-');
}

// hook の入力から導いたプロジェクト。cwd と transcript_path のそれぞれで最長一致を求め、判別できたものの一覧を返す(空 = 不明)。
// 2つが別のプロジェクトを指す場合は2件になる(呼び出し側は、宣言と食い違う件があれば捨てる)
export function projectsFromOrigin(registry, allowedRoot, { cwd, transcriptPath }) {
  const pick = (test) => {
    let best = null;
    let bestLen = -1;
    for (const info of registry.values()) if (info.root && test(info.root) && info.root.length > bestLen) { best = info.id; bestLen = info.root.length; }
    return best;
  };
  const byCwd = typeof cwd === 'string' && cwd ? pick((r) => insideOrSame(r, path.resolve(cwd))) : null;
  const byTranscript = pick((r) => transcriptInProject(allowedRoot, r, transcriptPath));
  return [...new Set([byCwd, byTranscript].filter(Boolean))];
}
