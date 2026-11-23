import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers.mjs';
import { loadRemoteConfig } from '../lib/remote-config.mjs';

// 遠隔は既定で無効。このファイルは有効(OFFICE_REMOTE=1)にしたときの動作を確かめる
process.env.OFFICE_REMOTE = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-rsafe-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';
const here = path.dirname(fileURLToPath(import.meta.url));

const raw = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (x) => {
    const chunks = [];
    x.on('data', (c) => chunks.push(c));
    x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});

async function withRemote(opts, fn) {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0, ...opts }), true);
  try { await fn(s, s.remotePort()); } finally { await s.close(); }
}
const postRemote = (rp, cookie, p = '/instruction', text = 'スマホから') => raw(rp, p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: `http://127.0.0.1:${rp}` },
  body: JSON.stringify({ text }),
});

test('遠隔の指示には source=remote が付き、PC の指示には付かない', async () => {
  await withRemote({}, async (s, rp) => {
    assert.equal((await postRemote(rp, `office_key=${TOKEN}`)).status, 202);
    const a = JSON.parse((await raw(s.port, '/instruction/next?wait=0')).text);
    assert.equal(a.source, 'remote');
    await raw(s.port, '/instruction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"PC"}' });
    const b = JSON.parse((await raw(s.port, '/instruction/next?wait=0')).text);
    assert.equal(b.source, undefined);
  });
});

test('待ち受けスクリプト: 遠隔の指示は見出しに(遠隔・スマホ)が付く', async () => {
  await withRemote({}, async (s, rp) => {
    const script = path.join(here, '..', 'tools', 'wait-instruction.mjs');
    const p = spawn(process.execPath, [script], { env: { ...process.env, OFFICE_PORT: String(s.port), OFFICE_WAIT_SEC: '0.2', OFFICE_RETRY_MS: '50' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    const done = new Promise((r) => p.on('close', r));
    await new Promise((r) => setTimeout(r, 300));
    await postRemote(rp, `office_key=${TOKEN}`, '/instruction', '外出先');
    await done;
    assert.match(out, /^\[Mimamori経由の社長の指示\(遠隔・スマホ\) id=[0-9a-f-]+\]\n外出先\n$/);
  });
});

test('Cookie の有効期間は30日', async () => {
  await withRemote({}, async (_s, rp) => {
    const r = await raw(rp, `/?k=${TOKEN}`);
    assert.equal(r.status, 302);
    assert.match(String(r.headers['set-cookie']), /Max-Age=2592000(;|$)/);
  });
});

test('世代を上げると、前の世代の Cookie は全て無効になる', async () => {
  let oldCookie;
  await withRemote({ generation: 1 }, async (_s, rp) => {
    const r = await raw(rp, `/?k=${TOKEN}`);
    oldCookie = /office_key=([^;]+)/.exec(String(r.headers['set-cookie']))[1];
    assert.equal((await raw(rp, '/', { headers: { Cookie: `office_key=${oldCookie}` } })).status, 200);
    assert.equal((await raw(rp, '/', { headers: { Cookie: `office_key=${TOKEN}` } })).status, 403); // 世代なしの素の合言葉は不可
  });
  await withRemote({ generation: 2 }, async (_s, rp) => {
    assert.equal((await raw(rp, '/', { headers: { Cookie: `office_key=${oldCookie}` } })).status, 403);
    assert.equal((await postRemote(rp, `office_key=${oldCookie}`)).status, 403);
  });
});

test('遠隔からの指示は既定プロジェクトだけ(?project= で他を指定したら 403、何も積まれない)', async () => {
  await withRemote({}, async (s, rp) => {
    const c = `office_key=${TOKEN}`;
    assert.equal((await postRemote(rp, c, '/instruction?project=other')).status, 403);
    assert.equal((await postRemote(rp, c, '/instruction?project=demo')).status, 202);
    assert.equal((await raw(s.port, '/instruction/next?wait=0')).status, 200);
    assert.equal((await raw(s.port, '/instruction/next?wait=0')).status, 204);
  });
});

test('remote-rotate: --yes で世代が上がり合言葉が変わり、合言葉は出力しない', () => {
  const d = fs.mkdtempSync(path.join(dir, 'rot-'));
  fs.writeFileSync(path.join(d, 'remote.json'), JSON.stringify({ token: TOKEN }));
  const run = () => spawnSync(process.execPath, [path.join(here, '..', 'tools', 'remote-rotate.mjs'), '--yes'], { env: { ...process.env, OFFICE_REMOTE_DIR: d }, encoding: 'utf8' });
  const r1 = run();
  assert.equal(r1.status, 0);
  const c1 = loadRemoteConfig(d);
  assert.equal(c1.generation, 1);
  assert.notEqual(c1.token, TOKEN);
  assert.ok(!r1.stdout.includes(c1.token));
  assert.match(r1.stdout, /再起動/);
  run();
  assert.equal(loadRemoteConfig(d).generation, 2);
});

test('remote-rotate: --yes なしで n を答えると変更しない', () => {
  const d = fs.mkdtempSync(path.join(dir, 'rot-'));
  fs.writeFileSync(path.join(d, 'remote.json'), JSON.stringify({ token: TOKEN }));
  const r = spawnSync(process.execPath, [path.join(here, '..', 'tools', 'remote-rotate.mjs')], { env: { ...process.env, OFFICE_REMOTE_DIR: d }, input: 'n\n', encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'remote.json'), 'utf8')).token, TOKEN);
});
