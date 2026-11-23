import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw } from './helpers.mjs';
import { cleanRelPath } from '../lib/tree.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tree-'));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const mk = (p, content) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); if (content !== undefined) fs.writeFileSync(path.join(root, p), content); };
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
mk('docs/out/report.xlsx', 'x');
mk('docs/misc/backups/old.xlsx', 'x');
mk('docs/misc/script.py', 'print(1)');
mk('work/misc/backups/b.xlsx', 'x');
mk('work/misc/__pycache__/m.pyc', 'x');
mk('.git/config', 'x');
mk('.claude/worktrees/w/a.txt', 'x');
mk('.claude/settings.json', '{}');
mk('node_modules/pkg/index.js', 'x');
mk('dash/misc/results_cache.json', '{}');
mk('dash/misc/mod.pyc', 'x');
mk('file10.txt', 'ten');
mk('file2.txt', 'two');
mk('README.md', 'hello');
mk('参考資料/.gitkeep', '');
let linked = false;
try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); linked = true; } catch { /* 権限が無い環境ではスキップ */ }
mk('empty/.git/x', 'x'); // 見える子が無いフォルダ

async function withServer(fn, opts = {}) {
  const s = await startTestServer({ port: 0, allowedRoot: base, treeRoot: root, ...opts });
  try { await fn(s); } finally { await s.close(); }
}
const tree = async (s, p) => {
  const r = await raw(s.port, `/tree?path=${encodeURIComponent(p)}`);
  return { status: r.status, body: r.text ? JSON.parse(r.text) : null };
};
const names = (b) => b.entries.map((e) => e.name);

test('ルート直下: フォルダが先・名前順(日本語・数字は自然順)、種別と hasChildren、中身は返さない', async () => {
  await withServer(async (s) => {
    const { status, body } = await tree(s, '');
    assert.equal(status, 200);
    assert.equal(body.truncated, false);
    const n = names(body);
    // 除外: .git / node_modules(ルート直下)
    assert.ok(!n.includes('.git') && !n.includes('node_modules'));
    const dirs = body.entries.filter((e) => e.kind === 'dir').map((e) => e.name);
    const files = body.entries.filter((e) => e.kind === 'file').map((e) => e.name);
    assert.deepEqual(n, [...dirs, ...files]);
    assert.deepEqual(files, ['file2.txt', 'file10.txt', 'README.md'].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })));
    for (const e of body.entries) assert.deepEqual(Object.keys(e).sort(), ['hasChildren', 'kind', 'mtime', 'name', 'size']);
    assert.equal(body.entries.find((e) => e.name === 'empty').hasChildren, false);
    assert.equal(body.entries.find((e) => e.name === 'docs').hasChildren, true);
    assert.equal(body.entries.find((e) => e.name === 'file2.txt').size, 3);
    assert.ok(!JSON.stringify(body).includes('hello'));
  });
});

test('除外: backups・worktrees・__pycache__・*.pyc・*cache*.json は一覧に出さず、直接指定も 404', async () => {
  await withServer(async (s) => {
    assert.deepEqual(names((await tree(s, 'docs/misc')).body), ['script.py']);
    assert.deepEqual(names((await tree(s, 'work/misc')).body), []);
    assert.deepEqual(names((await tree(s, 'dash/misc')).body), []);
    assert.deepEqual(names((await tree(s, '.claude')).body), ['settings.json']);
    for (const p of ['docs/misc/backups', 'work/misc/backups', '.git', '.claude/worktrees', '.claude/worktrees/w', 'node_modules', 'node_modules/pkg', 'work/misc/__pycache__']) {
      assert.equal((await tree(s, p)).status, 404, p);
    }
  });
});

test('パストラバーサルは拒否(.. / %2e%2e / 絶対パス / ドライブ / UNC / NUL / バックスラッシュ / ADS / 予約名)', async () => {
  await withServer(async (s) => {
    const bad = ['..', '../outside', 'docs/../..', 'a/../../outside', '%2e%2e', '%2e%2e%2foutside', '..%2foutside', '/etc', '/', '//server/share', '\\\\server\\share', 'C:/Windows', 'C:', 'c:\\x', 'docs\\成果物', 'docs/\0', 'file2.txt:stream', 'CON', 'nul.txt', 'aux', 'LPT1', 'x./y', 'a /b'];
    for (const p of bad) {
      const r = await raw(s.port, `/tree?path=${p.includes('%') ? p : encodeURIComponent(p)}`);
      assert.equal(r.status, 400, JSON.stringify(p));
      assert.ok(!r.text.includes('TOP-SECRET'));
    }
    // 生のURLで ../ を直接書いても(クエリ内)通らない
    assert.equal((await raw(s.port, '/tree?path=../outside')).status, 400);
    assert.equal((await raw(s.port, '/tree?path=%2e%2e%5coutside')).status, 400);
  });
});

test('cleanRelPath: 区切りの正規化と不正値', () => {
  assert.equal(cleanRelPath(''), '');
  assert.equal(cleanRelPath('a//b/./c/'), 'a/b/c');
  assert.equal(cleanRelPath(null), null);
  assert.equal(cleanRelPath('a/../b'), null);
});

test('シンボリックリンク(ジャンクション)でルートの外へは出られない', { skip: !linked }, async () => {
  await withServer(async (s) => {
    assert.ok(!names((await tree(s, '')).body).includes('escape')); // 一覧にも出さない
    const r = await tree(s, 'escape');
    assert.equal(r.status, 403);
    assert.equal(r.body, null);
    assert.equal((await tree(s, 'escape/secret.txt')).status, 403);
  });
});

test('存在しない・ファイルを指すパスは 404', async () => {
  await withServer(async (s) => {
    assert.equal((await tree(s, 'nothing')).status, 404);
    assert.equal((await tree(s, 'file2.txt')).status, 404);
  });
});

test('1回500件まで、超えたら truncated:true', async () => {
  fs.mkdirSync(path.join(root, 'many'), { recursive: true });
  for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(root, 'many', `f${String(i).padStart(4, '0')}.txt`), '');
  await withServer(async (s) => {
    const { body } = await tree(s, 'many');
    assert.equal(body.entries.length, 500);
    assert.equal(body.truncated, true);
    assert.equal(body.entries[0].name, 'f0000.txt');
  });
});

test('遠隔(スマホ)は合言葉があっても /tree は 403', async () => {
  const token = 'test-token-0123456789abcdef';
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token, port: 0 }), true);
    const rp = s.remotePort();
    const status = await new Promise((ok, ng) => {
      const r = http.request({ host: '127.0.0.1', port: rp, path: '/tree?path=', headers: { Host: `127.0.0.1:${rp}`, Cookie: `office_key=${token}` } }, (x) => { x.resume(); x.on('end', () => ok(x.statusCode)); });
      r.on('error', ng); r.end();
    });
    assert.equal(status, 403);
  });
});

test('他サイト由来・不正な Host は 403、ファイルの中身を返すエンドポイントは無い', async () => {
  await withServer(async (s) => {
    assert.equal((await raw(s.port, '/tree?path=', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await raw(s.port, '/tree?path=', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await raw(s.port, '/tree?path=file2.txt&raw=1')).status, 404);
    assert.equal((await raw(s.port, '/file?path=file2.txt')).status, 404);
  });
});

test('非表示は大文字小文字を区別しない(.GIT / Node_Modules / BACKUPS / __PYCACHE__ は 404)', async () => {
  await withServer(async (s) => {
    for (const p of ['.GIT', '.Git', 'Node_Modules', 'docs/misc/BACKUPS', 'work/misc/Backups', 'work/misc/__PYCACHE__', '.CLAUDE/Worktrees', '.git/config']) {
      assert.equal((await tree(s, p)).status, 404, p);
    }
    assert.equal((await tree(s, 'docs/misc')).status, 200); // 通常の階層は見える
  });
});

test('非表示の一覧除外も大文字小文字を区別しない', async () => {
  fs.mkdirSync(path.join(root, 'caseroot', 'NODE_MODULES', 'p'), { recursive: true });
  fs.mkdirSync(path.join(root, 'caseroot', '.GIT'), { recursive: true });
  fs.writeFileSync(path.join(root, 'caseroot', 'Mod.PYC'), 'x');
  fs.writeFileSync(path.join(root, 'caseroot', 'Data_CACHE.JSON'), '{}');
  fs.writeFileSync(path.join(root, 'caseroot', 'ok.txt'), 'x');
  await withServer(async (s) => {
    const { status, body } = await tree(s, 'caseroot');
    assert.equal(status, 200);
    assert.deepEqual(names(body), ['ok.txt']);
  });
});
