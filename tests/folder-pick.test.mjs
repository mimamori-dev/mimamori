import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../office-server.mjs';
import { browseDirs, checkRootChoice } from '../lib/folders.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-pick-'));

test('browseDirs: フォルダ名だけを返し、ファイル・隠しフォルダは出さない。相対パスは400', () => {
  const d = mk();
  try {
    fs.mkdirSync(path.join(d, 'b')); fs.mkdirSync(path.join(d, 'a')); fs.mkdirSync(path.join(d, '.git'));
    fs.writeFileSync(path.join(d, 'secret.txt'), 'x');
    const r = browseDirs(d);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entries.map((e) => e.name), ['a', 'b']);
    assert.equal(browseDirs('relative/dir').status, 400);
    assert.equal(browseDirs(path.join(d, 'nothing')).status, 404);
    assert.equal(browseDirs(path.join(d, 'secret.txt')).status, 404);
    assert.equal(browseDirs('').status, 200); // 一番上
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('checkRootChoice: フォルダだけ通す。ドライブ直下・ファイル・相対パスは断る', () => {
  const d = mk();
  try {
    assert.equal(checkRootChoice(d).ok, true);
    assert.equal(checkRootChoice(path.parse(d).root).ok, false);
    assert.equal(checkRootChoice(path.join(d, 'none')).ok, false);
    assert.equal(checkRootChoice('a/b').ok, false);
    assert.equal(checkRootChoice(123).ok, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('POST /project-root で基準フォルダが変わり、/tree に反映され、再起動後も残る。他サイト・不正は拒否', async () => {
  const d = mk();
  const dataDir = mk();
  const rootsFile = path.join(dataDir, 'project-roots.json');
  const pick = path.join(d, '選んだ場所');
  fs.mkdirSync(path.join(pick, '子'), { recursive: true });
  const opts = { port: 0, rootsFile, snsFile: path.join(dataDir, 'sns.json'), estimatesFile: path.join(dataDir, 'e.jsonl') };
  const post = (s, body, headers = {}) => fetch(`http://127.0.0.1:${s.port}/project-root`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    let s = await startServer(opts);
    try {
      assert.equal((await post(s, { root: 'rel' })).status, 400);
      assert.equal((await post(s, { root: path.join(d, 'none') })).status, 400);
      assert.equal((await post(s, { root: pick }, { Origin: 'http://evil.example' })).status, 403);
      const r = await post(s, { root: pick });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, saved: true, rootName: '選んだ場所' });
      const t = await (await fetch(`http://127.0.0.1:${s.port}/tree?path=`)).json();
      assert.equal(t.rootName, '選んだ場所');
      assert.deepEqual(t.entries.map((e) => e.name), ['子']);
    } finally { await s.close(); }
    s = await startServer(opts); // 再起動
    try {
      const t = await (await fetch(`http://127.0.0.1:${s.port}/tree?path=`)).json();
      assert.deepEqual(t.entries.map((e) => e.name), ['子']);
      const b = await fetch(`http://127.0.0.1:${s.port}/browse?path=${encodeURIComponent(d)}`, { headers: { Origin: 'http://evil.example' } });
      assert.equal(b.status, 403);
    } finally { await s.close(); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('browseDirs: よく使う場所(places)と、1つ上(parent)を返す', () => {
  const d = mk();
  try {
    fs.mkdirSync(path.join(d, 'sub'));
    const r = browseDirs(path.join(d, 'sub'));
    assert.equal(r.body.parent, fs.realpathSync(d));
    assert.ok(Array.isArray(r.body.places));
    for (const pl of r.body.places) {
      assert.equal(typeof pl.label, 'string');
      assert.ok(path.isAbsolute(pl.path) && fs.statSync(pl.path).isDirectory()); // 存在する場所だけ
    }
    assert.ok(browseDirs('').body.places.every((pl) => path.isAbsolute(pl.path)));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
