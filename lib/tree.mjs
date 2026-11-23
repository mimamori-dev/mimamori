import fs from 'node:fs';
import path from 'node:path';
import { isSecretFileName } from './deliverables.mjs';

export const TREE_MAX = 500;

// 表示しない名前(どの階層でも)。仕様 12章の既定の非表示
const HIDDEN_NAMES = new Set(['.git', 'node_modules', '__pycache__', 'secrets', 'backups']);
// 表示しないパス(プロジェクトルートからの相対・/区切り)
const HIDDEN_PATHS = new Set(['.claude/worktrees']);
const HIDDEN_FILE = (name) => /\.pyc$/i.test(name) || /cache.*\.json$/i.test(name) || isSecretFileName(name);
// Windows の予約名(拡張子付きでも同じ扱いになる)
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Windows は大文字小文字を区別しないので、比較は小文字にそろえる(Set 側は小文字で書くこと)
export const isHidden = (relPosix, name, isDir) => {
  const n = name.toLowerCase();
  return HIDDEN_PATHS.has(relPosix.toLowerCase()) || (isDir ? HIDDEN_NAMES.has(n) : HIDDEN_FILE(name) || HIDDEN_NAMES.has(n));
};

// クエリの path(ルートからの相対)を検査し、区切りを / にそろえて返す。不正なら null
export function cleanRelPath(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length > 1024 || /[\0\\]/.test(raw)) return null; // NUL・バックスラッシュ
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null; // 絶対パス・ドライブ・UNC
  const segs = raw.split('/').filter((x) => x !== '' && x !== '.');
  for (const sgm of segs) {
    if (sgm === '..' || sgm.includes(':') || RESERVED.test(sgm) || /[. ]$/.test(sgm) || /[<>"|?*]/.test(sgm)) return null;
  }
  return segs.join('/');
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

// 直下の子だけを名前・種別・更新日時・サイズで返す。中身は読まない。
// { status: 200, body } | { status: 400|403|404 }
export function listTree(root, rawPath) {
  const rel = cleanRelPath(rawPath ?? '');
  if (rel === null) return { status: 400 };
  const parts = rel === '' ? [] : rel.split('/');
  // 途中に非表示の階層があれば、存在しないものとして扱う
  for (let i = 0; i < parts.length; i++) if (isHidden(parts.slice(0, i + 1).join('/'), parts[i], true)) return { status: 404 };
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.join(realRoot, ...parts));
  } catch { return { status: 404 }; }
  if (!inside(realRoot, real)) return { status: 403 }; // シンボリックリンク・ジャンクションでの外出
  // 8.3短縮名などで別名から入られても、実体のパスで非表示を再判定する
  const realParts = path.relative(realRoot, real).split(path.sep).filter(Boolean);
  for (let i = 0; i < realParts.length; i++) if (isHidden(realParts.slice(0, i + 1).join('/'), realParts[i], true)) return { status: 404 };
  let dirents;
  try {
    if (!fs.statSync(real).isDirectory()) return { status: 404 };
    dirents = fs.readdirSync(real, { withFileTypes: true });
  } catch { return { status: 404 }; }

  const entries = [];
  for (const d of dirents) {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const full = path.join(real, d.name);
    let st;
    let target = full;
    try {
      if (d.isSymbolicLink()) {
        target = fs.realpathSync(full);
        if (!inside(realRoot, target)) continue; // ルートの外を指すリンクは見せない
      }
      st = fs.statSync(target);
    } catch { continue; }
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) continue;
    if (isHidden(childRel, d.name, isDir)) continue;
    entries.push({ name: d.name, kind: isDir ? 'dir' : 'file', size: isDir ? null : st.size, mtime: st.mtimeMs, target: isDir ? target : null, childRel });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ja', { numeric: true }) : a.kind === 'dir' ? -1 : 1));
  const truncated = entries.length > TREE_MAX;
  const out = entries.slice(0, TREE_MAX).map((e) => ({ name: e.name, kind: e.kind, size: e.size, mtime: e.mtime, hasChildren: e.kind === 'dir' ? hasVisibleChild(e.target, e.childRel, realRoot) : false }));
  return { status: 200, body: { path: rel, entries: out, truncated } };
}

function hasVisibleChild(dir, relPosix, realRoot) {
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const isDir = d.isDirectory() || (d.isSymbolicLink() && safeIsDir(path.join(dir, d.name), realRoot));
      if (d.isSymbolicLink() && !safeInside(path.join(dir, d.name), realRoot)) continue;
      if (!isHidden(`${relPosix}/${d.name}`, d.name, isDir)) return true;
    }
  } catch { /* 読めない = 子なし */ }
  return false;
}
const safeInside = (p, realRoot) => { try { return inside(realRoot, fs.realpathSync(p)); } catch { return false; } };
const safeIsDir = (p, realRoot) => { try { return safeInside(p, realRoot) && fs.statSync(p).isDirectory(); } catch { return false; } };
