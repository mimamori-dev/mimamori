import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startTestServer } from './helpers.mjs';
import { isRemoteEnabled, startRemoteWatcher, resolveRemoteDir } from '../lib/remote-config.mjs';

// 公開版では遠隔(スマホ)は既定で無効。OFFICE_REMOTE=1 のときだけ有効にする
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-optin-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';

test('OFFICE_REMOTE=1 のときだけ有効と判定する', () => {
  assert.equal(isRemoteEnabled({}), false);
  assert.equal(isRemoteEnabled({ OFFICE_REMOTE: '0' }), false);
  assert.equal(isRemoteEnabled({ OFFICE_REMOTE: 'true' }), false);
  assert.equal(isRemoteEnabled({ OFFICE_REMOTE: '1' }), true);
});

test('既定(無効)では Tailscale の宛先があっても口を開かず、remote.json も作らない', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'off-'));
  const s = await startTestServer({ port: 0, allowedRoot: dir, remoteAllowed: false });
  try {
    let asked = 0;
    const t = startRemoteWatcher(s, d, { env: {}, findIp: () => { asked++; return '127.0.0.1'; }, port: 0 });
    assert.equal(t, null);
    assert.equal(asked, 0); // Tailscale を探さない
    assert.equal(s.remotePort(), null);
    assert.equal(fs.existsSync(path.join(d, 'remote.json')), false);
    // 直接呼ばれても断る
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), false);
    assert.equal(s.remotePort(), null);
  } finally { await s.close(); }
});

test('無効なら PC 側の /remote-info は 404', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir, remoteAllowed: false });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/remote-info`)).status, 404);
  } finally { await s.close(); }
});

test('環境変数が無ければ startServer の既定は無効', async () => {
  const saved = process.env.OFFICE_REMOTE;
  delete process.env.OFFICE_REMOTE;
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/remote-info`)).status, 404);
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), false);
  } finally {
    await s.close();
    if (saved !== undefined) process.env.OFFICE_REMOTE = saved;
  }
});

test('OFFICE_REMOTE_DIR があれば合言葉はそこに作り、本体フォルダには作らない', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'home-'));
  const r = fs.mkdtempSync(path.join(dir, 'rdir-'));
  const s = await startTestServer({ port: 0, allowedRoot: dir, remoteAllowed: true });
  const log = console.log;
  console.log = () => {};
  try {
    const t = startRemoteWatcher(s, d, { env: { OFFICE_REMOTE: '1', OFFICE_REMOTE_DIR: r }, findIp: () => '127.0.0.1', port: 0 });
    assert.equal(await t.first, true);
    clearInterval(t);
    assert.equal(fs.existsSync(path.join(r, 'remote.json')), true);
    assert.equal(fs.existsSync(path.join(d, 'remote.json')), false);
  } finally {
    console.log = log;
    await s.close();
  }
});

test('OFFICE_REMOTE=1 なら Tailscale の宛先に口を開き、合言葉を作る', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'on-'));
  const s = await startTestServer({ port: 0, allowedRoot: dir, remoteAllowed: true });
  const log = console.log;
  console.log = () => {}; // URL と合言葉の行をテスト出力に出さない
  try {
    // テストでは Tailscale の代わりに 127.0.0.1 の別ポートを使う
    const t = startRemoteWatcher(s, d, { env: { OFFICE_REMOTE: '1' }, findIp: () => '127.0.0.1', port: 0 });
    assert.ok(t);
    assert.equal(await t.first, true);
    clearInterval(t);
    assert.ok(s.remotePort());
    assert.equal(fs.existsSync(path.join(d, 'remote.json')), true);
    const info = await (await fetch(`http://127.0.0.1:${s.port}/remote-info`)).json();
    assert.match(info.url, new RegExp(`^http://127\\.0\\.0\\.1:${s.remotePort()}/\\?k=`));
  } finally {
    console.log = log;
    await s.close();
  }
});

test('OFFICE_REMOTE_DIR: 空文字・空白は既定の場所(rotate と同じ判定)', () => {
  assert.equal(resolveRemoteDir({ OFFICE_REMOTE_DIR: '' }, '/x').dir, '/x');
  assert.equal(resolveRemoteDir({ OFFICE_REMOTE_DIR: '  ' }, '/x').dir, '/x');
  assert.equal(resolveRemoteDir({}, '/x').custom, false);
});

for (const [name, mk, re] of [
  ['相対パス', () => 'rel/dir', /絶対パス/],
  ['存在しないパス', () => path.join(dir, 'no-such-dir'), /存在しません/],
  ['フォルダでない', () => { const f = path.join(dir, 'afile'); fs.writeFileSync(f, 'x'); return f; }, /フォルダではありません/],
]) {
  test(`OFFICE_REMOTE_DIR が${name}なら警告を1回だけ出し、遠隔を開かず、どこにも remote.json を作らない`, async () => {
    const d = fs.mkdtempSync(path.join(dir, 'bad-'));
    const bad = mk();
    const s = await startTestServer({ port: 0, allowedRoot: dir, remoteAllowed: true });
    const warns = [];
    try {
      const t = startRemoteWatcher(s, d, { env: { OFFICE_REMOTE: '1', OFFICE_REMOTE_DIR: bad }, findIp: () => '127.0.0.1', port: 0, warn: (m) => warns.push(m) });
      assert.equal(await t.first, false);
      clearInterval(t);
      assert.equal(warns.length, 1);
      assert.match(warns[0], re);
      assert.equal(s.remotePort(), null);
      assert.equal(fs.existsSync(path.join(d, 'remote.json')), false);
    } finally { await s.close(); }
  });
}

test('OFFICE_REMOTE_DIR 不正のとき remote-rotate は何も変更せず終了する', () => {
  const d = fs.mkdtempSync(path.join(dir, 'rotbad-'));
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'tools', 'remote-rotate.mjs'), '--yes'], { env: { ...process.env, OFFICE_REMOTE_DIR: path.join(d, 'nope') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(d, 'nope')), false);
});

test('remote-rotate は作成先のパスを出し、合言葉は出さない', () => {
  const d = fs.mkdtempSync(path.join(dir, 'rotpath-'));
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'tools', 'remote-rotate.mjs'), '--yes'], { env: { ...process.env, OFFICE_REMOTE_DIR: d }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(path.join(d, 'remote.json')));
  assert.ok(!r.stdout.includes(JSON.parse(fs.readFileSync(path.join(d, 'remote.json'), 'utf8')).token));
});
