import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../office-server.mjs';
import { startTestServer } from './helpers.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-inst-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';
const here = path.dirname(fileURLToPath(import.meta.url));

async function withServer(fn, opts = {}) {
  const s = await startTestServer({ port: 0, allowedRoot: dir, ...opts });
  try { await fn(s); } finally { await s.close(); }
}

// 生の HTTP。日本語本文は node から送る
const raw = (port, p, { method = 'GET', headers = {}, body, host } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } }, (x) => {
    const chunks = [];
    x.on('data', (c) => chunks.push(c));
    x.on('end', () => resolve({ status: x.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});
const J = { 'Content-Type': 'application/json' };
const postI = (s, text, headers = J) => raw(s.port, '/instruction', { method: 'POST', headers, body: JSON.stringify({ text }) });
const next = (s, wait = 0.05) => raw(s.port, `/instruction/next?wait=${wait}`);

async function openSse(s) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.port}/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
        waiters.splice(0).forEach((w) => w());
      }
    } catch { /* abort */ }
  })();
  return {
    // pred に合う office イベントが来るまで待つ
    async office(pred = () => true) {
      for (;;) {
        const i = events.findIndex((e) => e.name === 'office' && pred(e.data));
        if (i >= 0) return events.splice(i, 1)[0].data;
        await new Promise((r) => waiters.push(r));
      }
    },
    async snapshot() {
      for (;;) {
        const i = events.findIndex((e) => e.name === 'snapshot');
        if (i >= 0) return events.splice(i, 1)[0].data;
        await new Promise((r) => waiters.push(r));
      }
    },
    close: () => ac.abort(),
  };
}

test('POST /instruction: 正常は 202 {id}、日本語本文もそのまま取り出せる', async () => {
  await withServer(async (s) => {
    const r = await postI(s, '  来月の進捗を分析して  ');
    assert.equal(r.status, 202);
    const { id } = JSON.parse(r.text);
    assert.equal(typeof id, 'string');
    const n = await next(s);
    assert.equal(n.status, 200);
    const got = JSON.parse(n.text);
    assert.equal(got.id, id);
    assert.equal(got.text, '来月の進捗を分析して');
    assert.equal(typeof got.ts, 'number');
  });
});

test('POST /instruction: Host・Origin・Sec-Fetch-Site・型・サイズ・文字数・件数の検査', async () => {
  await withServer(async (s) => {
    const p = s.port;
    const body = JSON.stringify({ text: 'a' });
    const send = (headers, o = {}) => raw(p, '/instruction', { method: 'POST', headers, body, ...o });
    assert.equal((await send(J, { host: 'evil.example:4317' })).status, 403);
    assert.equal((await send({ ...J, Origin: 'http://evil.example' })).status, 403);
    assert.equal((await send({ ...J, Origin: `http://127.0.0.1:${p}`, 'Sec-Fetch-Site': 'same-origin' })).status, 202);
    assert.equal((await send({ ...J, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send({ ...J, 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await send({ ...J, 'Sec-Fetch-Site': 'none' })).status, 403);
    assert.equal((await send({ 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await send({})).status, 415);
    // 文字数・型
    assert.equal((await raw(p, '/instruction', { method: 'POST', headers: J, body: 'not json' })).status, 400);
    for (const t of ['', '   \n ', 5, null, ['a'], { a: 1 }]) assert.equal((await postI(s, t)).status, 400, JSON.stringify(t));
    assert.equal((await raw(p, '/instruction', { method: 'POST', headers: J, body: '{}' })).status, 400);
    assert.equal((await postI(s, 'あ'.repeat(2000))).status, 202); // 日本語2000文字(バイトでは6000)は通る
    assert.equal((await postI(s, 'あ'.repeat(2001))).status, 400);
    assert.equal((await postI(s, '😀'.repeat(2000))).status, 202); // サロゲートペアも1文字と数える
    // 8KB 超は 413
    const big = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, path: '/instruction', method: 'POST', headers: { Host: `127.0.0.1:${p}`, ...J } }, (x) => { x.resume(); resolve(x.statusCode); });
      r.on('error', () => {});
      r.end('x'.repeat(9 * 1024));
      setTimeout(() => reject(new Error('no response')), 3000).unref();
    });
    assert.equal(big, 413);
  });
});

test('キューは最大10件で、11件目は 429。取り出すと空きができる', async () => {
  await withServer(async (s) => {
    for (let i = 0; i < 10; i++) assert.equal((await postI(s, `指示${i}`)).status, 202);
    assert.equal((await postI(s, 'あふれ')).status, 429);
    assert.equal(JSON.parse((await next(s)).text).text, '指示0'); // 先入れ先出し
    assert.equal((await postI(s, '空いた')).status, 202);
  });
});

test('遠隔側は /instruction・/instruction/next が合言葉があっても常に 403', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const rp = s.remotePort();
    const auth = { Cookie: `office_key=${TOKEN}` };
    assert.equal((await raw(rp, '/instruction', { method: 'POST', headers: { ...J, ...auth }, body: '{"text":"x"}' })).status, 403);
    assert.equal((await raw(rp, '/instruction/next?wait=0', { headers: auth })).status, 403);
    assert.equal((await raw(rp, `/instruction/next?wait=0&k=${TOKEN}`)).status, 403);
    assert.equal((await raw(rp, '/instruction', { method: 'POST', headers: J, body: '{"text":"x"}' })).status, 403);
    // 何も積まれていない
    assert.equal((await next(s)).status, 204);
  });
});

test('GET /instruction/next: 待っている間に届いた指示を渡す。無ければ 204', async () => {
  await withServer(async (s) => {
    assert.equal((await next(s, 0.05)).status, 204);
    const waiting = next(s, 10);
    await new Promise((r) => setTimeout(r, 50));
    await postI(s, 'あとから届いた');
    const r = await waiting; // 10秒待たずに返る
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).text, 'あとから届いた');
  });
});

test('wait の上限は注入でき、上限を超える wait も切り詰める', async () => {
  await withServer(async (s) => {
    const t0 = Date.now();
    assert.equal((await next(s, 30)).status, 204);
    assert.ok(Date.now() - t0 < 2000);
  }, { waitMaxSec: 0.05 });
});

test('同時に複数の待ち受けがあっても、指示は1つの待ち受けにだけ1回渡る', async () => {
  await withServer(async (s) => {
    const a = next(s, 0.5);
    const b = next(s, 0.5);
    const c = next(s, 0.5);
    await new Promise((r) => setTimeout(r, 50));
    await postI(s, '一回だけ');
    const rs = await Promise.all([a, b, c]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 204, 204]);
    assert.equal((await next(s)).status, 204);
  });
});

test('待ち受けが切断されたら指示は失われず、次の待ち受けに渡る', async () => {
  await withServer(async (s) => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/instruction/next?wait=20' });
    req.on('error', () => {});
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await postI(s, '切断後の指示');
    const r = await next(s);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).text, '切断後の指示');
  });
});

test('取り出した時に prompt イベント・ログ・inbox が反映される', async () => {
  await withServer(async (s) => {
    const sse = await openSse(s);
    const s0 = await sse.snapshot();
    assert.deepEqual(s0.inbox, { pending: 0, listening: false, canSend: true });
    const text = '長い指示'.repeat(20); // 80文字
    await postI(s, text);
    const queued = await sse.office((o) => o.event.kind === 'inbox');
    assert.equal(queued.snapshot.inbox.pending, 1);
    assert.equal(JSON.stringify(queued.event).includes('長い指示'), false); // イベント本体に本文は載せない(一覧 instructions には100字まで載る)
    assert.equal(queued.snapshot.instructions[0].status, 'queued');
    const got = await next(s);
    assert.equal(got.status, 200);
    const o = await sse.office((x) => x.event.kind === 'prompt');
    assert.equal(o.event.text, `社長から『${text.slice(0, 24)}…』の指示を受けました`);
    assert.deepEqual(o.snapshot.instruction, { text, ts: o.event.ts, source: 'office', status: 'working' });
    assert.equal(o.event.title, text.slice(0, 40) + '…');
    assert.equal(typeof o.event.ts, 'number');
    assert.equal(o.snapshot.inbox.pending, 0);
    assert.equal(o.snapshot.inbox.listening, true);
    assert.equal(o.snapshot.inbox.canSend, true);
    assert.equal(o.snapshot.board.at(-1).title, text.slice(0, 40) + '…');
    assert.ok(o.snapshot.log.some((l) => l.text === `社長の指示: ${text.slice(0, 30)}…`));
    sse.close();
  });
});

test('遠隔の SSE は canSend=false(snapshot と office の両方)', async () => {
  await withServer(async (s) => {
    await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 });
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.remotePort()}/events`, { headers: { Cookie: `office_key=${TOKEN}` }, signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const read = async (pred) => {
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const d = JSON.parse(/^data: (.*)$/m.exec(block)[1]);
          if (pred(block)) return d;
          continue;
        }
        const { value } = await reader.read();
        buf += dec.decode(value, { stream: true });
      }
    };
    const snap = await read((b) => b.startsWith('event: snapshot'));
    assert.equal(snap.inbox.canSend, false);
    await postI(s, 'PC から送る');
    const o = await read((b) => b.startsWith('event: office'));
    assert.equal(o.snapshot.inbox.canSend, false);
    assert.equal(o.snapshot.inbox.pending, 1);
    ac.abort();
  });
});

test('listening は直近40秒以内に待ち受けが繋がったときだけ true', async () => {
  let t = 1_000_000;
  await withServer(async (s) => {
    const sse = await openSse(s);
    assert.equal((await sse.snapshot()).inbox.listening, false);
    await next(s, 0);
    await postI(s, 'x');
    assert.equal((await sse.office((o) => o.event.kind === 'inbox' && o.snapshot.inbox.pending === 1)).snapshot.inbox.listening, true);
    t += 39_000;
    await postI(s, 'y');
    assert.equal((await sse.office((o) => o.event.kind === 'inbox' && o.snapshot.inbox.pending === 2)).snapshot.inbox.listening, true);
    t += 2_000;
    await postI(s, 'z');
    assert.equal((await sse.office((o) => o.event.kind === 'inbox' && o.snapshot.inbox.pending === 3)).snapshot.inbox.listening, false);
    sse.close();
  }, { now: () => t });
});

test('サーバー停止で待機中の接続が閉じ、close が返る', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  const pending = next(s, 30).then(() => 'ended', () => 'ended');
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  await s.close();
  assert.equal(await pending, 'ended');
  assert.ok(Date.now() - t0 < 3000);
});

const script = path.join(here, '..', 'tools', 'wait-instruction.mjs');
const runScript = (port, env = {}) => {
  const p = spawn(process.execPath, [script], { env: { ...process.env, OFFICE_PORT: String(port), OFFICE_WAIT_SEC: '0.2', OFFICE_RETRY_MS: '50', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  const done = new Promise((resolve) => p.on('close', (code) => resolve({ code, out, err })));
  return { p, done, out: () => out };
};

test('待ち受けスクリプト: 指示を設計書4章の形式で出して終了コード0', async () => {
  await withServer(async (s) => {
    const w = runScript(s.port);
    await new Promise((r) => setTimeout(r, 300)); // 空振り(204)を挟んでも再接続する
    const { id } = JSON.parse((await postI(s, '一行目\n二行目の日本語')).text);
    const r = await w.done;
    assert.equal(r.code, 0);
    assert.equal(r.out, `[Mimamori経由の社長の指示 id=${id}]\n一行目\n二行目の日本語\n`);
    assert.equal(r.err, '');
  });
});

test('待ち受けスクリプト: サーバーが無くても落ちず、出てきたら受け取る', async () => {
  // 空きポートを得て一度閉じる(そこには誰もいない)
  const probe = await startTestServer({ port: 0, allowedRoot: dir });
  const port = probe.port;
  await probe.close();
  const w = runScript(port);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(w.out(), '');
  assert.equal(w.p.exitCode, null); // 生きて再試行している
  const s = await startServer({ port, allowedRoot: dir });
  try {
    const { id } = JSON.parse((await postI(s, 'おそい起動')).text);
    const r = await w.done;
    assert.equal(r.code, 0);
    assert.equal(r.out, `[Mimamori経由の社長の指示 id=${id}]\nおそい起動\n`);
  } finally {
    w.p.kill();
    await s.close();
  }
});
