import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer, openSse } from './helpers.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const scriptPath = fileURLToPath(new URL('../tools/statusline-quota.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-quota-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';

function runScript(stdin, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [scriptPath], { env: { ...process.env, OFFICE_PORT: String(port), OFFICE_SEND_TIMEOUT_MS: '15000' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const future = () => Math.floor(Date.now() / 1000) + 3600;
const statusJson = (rl) => JSON.stringify({ model: { id: 'x' }, rate_limits: rl });

test('正常: statusline の JSON から枠だけを送り、標準出力は空・終了コード0', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    const sse = await openSse(s);
    await sse.snapshot();
    const r5 = future();
    const r7 = future() + 86400;
    const r = await runScript(statusJson({ five_hour: { used_percentage: 23.5, resets_at: r5 }, seven_day: { used_percentage: 41, resets_at: r7 } }), s.port);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.ok(r.ms < 30000);
    const o = await sse.office();
    assert.deepEqual({ ...o.snapshot.quota, updatedAt: typeof o.snapshot.quota.updatedAt }, { fiveHour: { pct: 24, resetsAt: r5 }, sevenDay: { pct: 41, resetsAt: r7 }, updatedAt: 'number' });
    sse.close();
  } finally { await s.close(); }
});

test('欠落・不正JSON・サーバー無しでも終了コード0で何も出さない', async () => {
  const dead = await freePort();
  for (const input of ['', 'not json', '{}', JSON.stringify({ rate_limits: {} }), statusJson({ five_hour: { used_percentage: 10, resets_at: future() } }), statusJson('x'), 'null']) {
    const r = await runScript(input, dead);
    assert.equal(r.code, 0, input);
    assert.equal(r.out, '', input);
    assert.ok(r.ms < 30000, input);
  }
});

test('片方だけ・不正値・期限切れはサーバー側で整えられる', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    const sse = await openSse(s);
    await sse.snapshot();
    await runScript(statusJson({ seven_day: { used_percentage: 'abc', resets_at: future() }, five_hour: { used_percentage: 300, resets_at: 'soon' } }), s.port);
    let o = await sse.office();
    assert.deepEqual(o.snapshot.quota.fiveHour, { pct: 100, resetsAt: null });
    assert.equal(o.snapshot.quota.sevenDay, null);
    await runScript(statusJson({ five_hour: { used_percentage: 50, resets_at: Math.floor(Date.now() / 1000) - 10 } }), s.port);
    o = await sse.office();
    assert.equal(o.snapshot.quota, null);
    sse.close();
  } finally { await s.close(); }
});

test('遠隔の snapshot にも quota が載り、金額などは含まれない', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const r5 = future();
    await runScript(statusJson({ five_hour: { used_percentage: 12, resets_at: r5 } }), s.port);
    const rp = s.remotePort();
    const snap = await new Promise((resolve, reject) => {
      const rq = http.get({ host: '127.0.0.1', port: rp, path: '/events', headers: { Host: `127.0.0.1:${rp}`, Cookie: `office_key=${TOKEN}` } }, (x) => {
        let buf = '';
        x.on('data', (c) => {
          buf += c;
          const m = /^data: (.*)$/m.exec(buf);
          if (m) { rq.destroy(); resolve(JSON.parse(m[1])); }
        });
      });
      rq.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.deepEqual(Object.keys(snap.quota).sort(), ['fiveHour', 'sevenDay', 'updatedAt']);
    assert.deepEqual(snap.quota.fiveHour, { pct: 12, resetsAt: r5 });
    assert.equal(snap.quota.sevenDay, null);
  } finally { await s.close(); }
});
