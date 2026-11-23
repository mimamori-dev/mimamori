import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw } from './helpers.mjs';
import { createCommandRunner, defaultCommands, NO_RECURSE_ENV } from '../lib/commands.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-cmd-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const node = (id, code) => ({ id, label: id, cmd: process.execPath, args: ['-e', code], cwd: dir });
const JSON_H = { 'Content-Type': 'application/json' };
const post = (port, id, headers = {}) => raw(port, '/command', { method: 'POST', headers: { ...JSON_H, ...headers }, body: JSON.stringify({ id }) });

async function withServer(opts, fn) {
  const s = await startTestServer({ port: 0, allowedRoot: dir, ...opts });
  try { await fn(s); } finally { await s.close(); }
}

test('GET /commands は許可リストの id と表示名だけを返す(実行はしない)', async () => {
  await withServer({}, async (s) => {
    const r = await raw(s.port, '/commands');
    assert.equal(r.status, 200);
    const list = JSON.parse(r.text);
    assert.deepEqual(list.map((c) => c.label), ['テスト実行', '変更の確認', '履歴の確認', 'サーバーの状態']);
    for (const c of list) assert.deepEqual(Object.keys(c).sort(), ['id', 'label']);
  });
});

test('許可リスト外の id・不正な形は実行せず 404 / 400', async () => {
  await withServer({}, async (s) => {
    for (const id of ['rm', 'test; echo hi', '../test', '__proto__', 'constructor', 'toString', '', 5, null, ['test']]) {
      assert.equal((await post(s.port, id)).status, 404, JSON.stringify(id));
    }
    assert.equal((await raw(s.port, '/command', { method: 'POST', headers: JSON_H, body: '{}' })).status, 404);
    assert.equal((await raw(s.port, '/command', { method: 'POST', headers: JSON_H, body: 'xx' })).status, 400);
    assert.equal((await raw(s.port, '/command', { method: 'POST', headers: JSON_H, body: '[]' })).status, 400);
    assert.equal((await raw(s.port, '/command', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await raw(s.port, '/command', { method: 'POST', headers: JSON_H, body: JSON.stringify({ id: 'x'.repeat(2000) }) })).status, 413);
  });
});

test('他サイト由来(Origin・Sec-Fetch-Site)と不正な Host は 403', async () => {
  await withServer({}, async (s) => {
    assert.equal((await post(s.port, 'health', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(s.port, 'health', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(s.port, 'health', { Host: 'evil.example' })).status, 403);
    assert.equal((await raw(s.port, '/commands', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await raw(s.port, '/commands', { headers: { Origin: 'http://evil.example' } })).status, 403);
    // 同一オリジンなら通る
    assert.equal((await post(s.port, 'health', { Origin: `http://127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  });
});

test('遠隔(スマホ)は合言葉があっても /commands・/command とも 403', async () => {
  const token = 'test-token-0123456789abcdef';
  await withServer({}, async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token, port: 0 }), true);
    const rp = s.remotePort();
    const h = { Cookie: `office_key=${token}`, Host: `127.0.0.1:${rp}` };
    const get = await new Promise((resolve, reject) => {
      import('node:http').then(({ default: http }) => {
        const req = (method, p) => new Promise((ok, ng) => {
          const r = http.request({ host: '127.0.0.1', port: rp, path: p, method, headers: { ...h, 'Content-Type': 'application/json' } }, (x) => { x.resume(); x.on('end', () => ok(x.statusCode)); });
          r.on('error', ng); r.end(method === 'POST' ? JSON.stringify({ id: 'health' }) : undefined);
        });
        Promise.all([req('GET', '/commands'), req('POST', '/command')]).then(resolve, reject);
      });
    });
    assert.deepEqual(get, [403, 403]);
  });
});

test('サーバーの状態(health)は /health と同じ内容を返す', async () => {
  await withServer({}, async (s) => {
    const r = await post(s.port, 'health');
    assert.equal(r.status, 200);
    const b = JSON.parse(r.text);
    assert.equal(b.ok, true);
    assert.equal(b.truncated, false);
    assert.equal(JSON.parse(b.output).ok, true);
  });
});

test('出力は最後の200行まで・truncated、失敗は ok:false', async () => {
  await withServer({ commands: [node('big', "for(let i=1;i<=300;i++)console.log('line'+i)"), node('bad', "console.error('boom');process.exit(3)")] }, async (s) => {
    const b = JSON.parse((await post(s.port, 'big')).text);
    const lines = b.output.split('\n');
    assert.equal(lines.length, 200);
    assert.equal(lines.at(-1), 'line300');
    assert.equal(b.truncated, true);
    assert.equal(b.ok, true);
    const bad = JSON.parse((await post(s.port, 'bad')).text);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /boom/);
    assert.equal(bad.truncated, false);
  });
});

test('同時実行は1件まで(実行中の2件目は 409、終われば再び受け付ける)', async () => {
  await withServer({ commands: [node('slow', 'setTimeout(()=>console.log("done"),800)'), node('fast', 'console.log("hi")')] }, async (s) => {
    const first = post(s.port, 'slow');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await post(s.port, 'fast')).status, 409);
    assert.equal((await post(s.port, 'slow')).status, 409);
    assert.equal(JSON.parse((await first).text).output, 'done');
    assert.equal((await post(s.port, 'fast')).status, 200);
  });
});

test('制限時間を超えたら打ち切り、結果を返して次を受け付ける', async () => {
  await withServer({ commandTimeoutMs: 400, commands: [node('hang', 'console.log("start");setInterval(()=>{},1000)'), node('fast', 'console.log("hi")')] }, async (s) => {
    const t0 = Date.now();
    const r = await post(s.port, 'hang');
    assert.ok(Date.now() - t0 < 30000);
    const b = JSON.parse(r.text);
    assert.equal(b.ok, false);
    assert.equal(b.truncated, true);
    assert.equal(b.timedOut, true);
    assert.match(b.output, /start/);
    assert.equal((await post(s.port, 'fast')).status, 200);
  });
});

test('テスト実行は、実行中のテストの中からは再帰して起動しない', async () => {
  const runner = createCommandRunner({ commands: defaultCommands({ officeDir: dir, projectRoot: dir, health: () => ({}) }), env: { ...process.env, [NO_RECURSE_ENV]: '1' } });
  const r = await runner.run('test');
  assert.equal(r.body.ok, false);
  assert.match(r.body.output, /テストの中/);
});

test('許可リストの内容: 状態を変える操作は含まず、引数は固定', () => {
  const cmds = defaultCommands({ officeDir: dir, projectRoot: dir, health: () => ({}) });
  const flat = cmds.map((c) => [c.cmd, ...(c.args ?? [])].join(' ')).join('\n');
  assert.doesNotMatch(flat, /push|commit|reset|clean|install|rm |checkout|restart/);
  assert.deepEqual(cmds.find((c) => c.id === 'git-log').args, ['log', '--oneline', '-10']);
  assert.ok(cmds.every((c) => c.run || (c.cmd && Array.isArray(c.args))));
});
