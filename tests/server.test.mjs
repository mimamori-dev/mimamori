import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-server-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ev = (kind, o = {}) => ({ ts: 1, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const post = (s, body, raw = false, headers = { 'Content-Type': 'application/json' }) => fetch(`http://127.0.0.1:${s.port}/event`, { method: 'POST', headers, body: raw ? body : JSON.stringify(body) });
const health = async (s) => (await fetch(`http://127.0.0.1:${s.port}/health`)).json();

async function withServer(fn) {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try { await fn(s); } finally { await s.close(); }
}

// SSE を開き、届いたイベントを溜める。close() で切断する
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
    async next(name) {
      for (;;) {
        const i = events.findIndex((e) => e.name === name);
        if (i >= 0) return events.splice(i, 1)[0].data;
        await new Promise((r) => waiters.push(r));
      }
    },
    close: () => ac.abort(),
  };
}

test('SSE の接続数が health に出る', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, ev('session_start', { text: 'x' }))).status, 204);
    const h0 = await health(s);
    assert.equal(h0.ok, true);
    assert.equal(h0.clients, 0);
    const sse = await openSse(s);
    await sse.next('snapshot');
    assert.equal((await health(s)).clients, 1);
    sse.close();
  });
});

test('接続直後に snapshot、その後の POST で office が届く', async () => {
  await withServer(async (s) => {
    const sse = await openSse(s);
    const snap = await sse.next('snapshot');
    assert.ok(Array.isArray(snap.members));
    assert.ok(snap.usage.tokens);
    await post(s, ev('prompt', { text: '依頼を受けました', title: '件名' }));
    const o = await sse.next('office');
    assert.equal(o.event.text, '依頼を受けました');
    assert.equal(o.snapshot.board[0].title, '件名');
    assert.ok(o.snapshot.usage);
    sse.close();
  });
});

test('途中から接続しても案件カードが snapshot に入っている', async () => {
  await withServer(async (s) => {
    await post(s, ev('prompt', { text: 'a', title: '途中案件' }));
    const sse = await openSse(s);
    const snap = await sse.next('snapshot');
    assert.equal(snap.board[0].title, '途中案件');
    sse.close();
  });
});

const rawGet = (s, host, p = '/health') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: s.port, path: p, headers: { Host: host } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
  req.on('error', reject); req.end();
});

test('Host が localhost 系以外なら 403', async () => {
  await withServer(async (s) => {
    assert.equal(await rawGet(s, 'evil.example:4317'), 403);
    assert.equal(await rawGet(s, `localhost:${s.port}`), 200);
    assert.equal(await rawGet(s, `127.0.0.1:${s.port}`), 200);
  });
});

test('64KB 超は 413、JSON でなければ 400', async () => {
  await withServer(async (s) => {
    // 413 の直後にサーバーが接続を切るので、応答が読めた時点で成功とし後続のリセットは無視する
    const code = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: '/event', method: 'POST', headers: { Host: `127.0.0.1:${s.port}`, 'Content-Type': 'application/json' } }, (x) => { x.resume(); resolve(x.statusCode); });
      r.on('error', () => {});
      r.end('x'.repeat(70 * 1024));
      setTimeout(() => reject(new Error('no response')), 3000).unref();
    });
    assert.equal(code, 413);
    assert.equal((await health(s)).ok, true);
    assert.equal((await post(s, 'not json', true)).status, 400);
  });
});

test('.. を含む /vendor パスは 404、無いファイルも 404、/ は配信', async () => {
  await withServer(async (s) => {
    assert.equal(await rawGet(s, `127.0.0.1:${s.port}`, '/vendor/three/../../package.json'), 404);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/vendor/three/nothing.js`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/`)).status, 200);
  });
});

const line = (id, n) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5', usage: { input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n';

test('transcriptPath 付きイベントで usage が SSE に届く', async () => {
  await withServer(async (s) => {
    const tp = path.join(dir, 'main.jsonl');
    fs.writeFileSync(tp, line('m1', 1234));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('prompt', { text: 'a', title: 't', transcriptPath: tp }));
    const u = await sse.next('usage');
    assert.equal(u.tokens.total, 1234);
    sse.close();
  });
});

test('担当の transcript は subagents/ から導出し、その担当の席に紐づく', async () => {
  await withServer(async (s) => {
    const tp = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(tp, line('m1', 10));
    fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess', 'subagents', 'agent-a1.jsonl'), line('s1', 500));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('delegate', { text: 'd', title: 't', targetType: 'report-writer', transcriptPath: tp }));
    await sse.next('usage');
    await post(s, ev('subagent_start', { agentId: 'a1', agentType: 'report-writer', transcriptPath: tp }));
    const u = await sse.next('usage');
    assert.equal(u.tokens.total, 510);
    assert.equal(u.bySeat['report-writer'], 500);
    assert.equal(u.bySeat.bucho, 10);
    sse.close();
  });
});

test('agentTranscriptPath があればそれを使う', async () => {
  await withServer(async (s) => {
    const ap = path.join(dir, 'explicit.jsonl');
    fs.writeFileSync(ap, line('x1', 77));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('delegate', { text: 'd', title: 't', targetType: 'report-writer' }));
    await post(s, ev('subagent_start', { agentId: 'b1', agentType: 'report-writer', agentTranscriptPath: ap }));
    await sse.next('usage'); // delegate 分(使用量は増えない)
    const u = await sse.next('usage');
    assert.equal(u.bySeat['report-writer'], 77);
    sse.close();
  });
});

test('壊れたURLでもサーバーは落ちず /health に答える', async () => {
  await withServer(async (s) => {
    for (const p of ['/static/%zz', '/static/%00x', '/static/%2e%2e/package.json', '/vendor/three/%5c..%5cx']) {
      const code = await rawGet(s, `127.0.0.1:${s.port}`, p);
      assert.ok(code === 404 || code === 400, `${p} -> ${code}`);
      assert.equal((await health(s)).ok, true);
    }
  });
});

test('席の無い担当(overflow)の使用量も合計に数える', async () => {
  await withServer(async (s) => {
    const ap = path.join(dir, 'ov-agent.jsonl');
    fs.writeFileSync(ap, line('o1', 40));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('subagent_done', { text: 'x', agentId: 'ghost', agentType: 'unknown-type', agentTranscriptPath: ap }));
    const u = await sse.next('usage');
    assert.equal(u.tokens.total, 40);
    assert.equal(u.bySeat.overflow, 40);
    sse.close();
  });
});

test('subagent_done の最後の使用量も数える(席が解除されても)', async () => {
  await withServer(async (s) => {
    const ap = path.join(dir, 'done-agent.jsonl');
    fs.writeFileSync(ap, line('d1', 5));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('delegate', { text: 'd', title: 't', targetType: 'report-writer' }));
    await sse.next('usage');
    await post(s, ev('subagent_start', { agentId: 'z1', agentType: 'report-writer', agentTranscriptPath: ap }));
    await sse.next('usage');
    fs.appendFileSync(ap, line('d2', 30));
    await post(s, ev('subagent_done', { agentId: 'z1', agentType: 'report-writer', text: '完了', agentTranscriptPath: ap }));
    const u = await sse.next('usage');
    assert.equal(u.tokens.total, 35);
    assert.equal(u.bySeat['report-writer'], 35);
    sse.close();
  });
});

test('POST /event は Origin 付き・他サイト由来を 403、JSON 以外の型を 415 にする', async () => {
  await withServer(async (s) => {
    const body = JSON.stringify(ev('session_start', { text: 'x' }));
    const j = { 'Content-Type': 'application/json' };
    const send = (headers) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: '/event', method: 'POST', headers: { Host: `127.0.0.1:${s.port}`, ...headers } }, (x) => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
      r.on('error', reject); r.end(body);
    });
    assert.equal(await send({ ...j, Origin: 'http://evil.example' }), 403);
    assert.equal(await send({ ...j, 'Sec-Fetch-Site': 'cross-site' }), 403);
    assert.equal(await send({ ...j, 'Sec-Fetch-Site': 'same-site' }), 403);
    assert.equal(await send({ ...j, 'Sec-Fetch-Site': 'none' }), 204);
    assert.equal(await send({ 'Content-Type': 'text/plain' }), 415);
    assert.equal(await send({}), 415);
    assert.equal(await send(j), 204);
  });
});

test('agentId が安全な文字でなければ担当の transcript を導出・追跡しない', async () => {
  await withServer(async (s) => {
    const tp = path.join(dir, 'safe.jsonl');
    fs.writeFileSync(tp, line('m1', 2));
    fs.mkdirSync(path.join(dir, 'safe', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'safe', 'subagents', 'agent-x.jsonl'), line('s1', 900));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('tool', { text: 'x', agentId: '../../safe/subagents/agent-x', agentType: 'a', transcriptPath: tp }));
    const u = await sse.next('usage');
    assert.equal(u.tokens.total, 2);
    sse.close();
  });
});

test('prompt で同期的にターンがリセットされ、直後の snapshot は 0 から始まる', async () => {
  await withServer(async (s) => {
    const tp = path.join(dir, 'turn.jsonl');
    fs.writeFileSync(tp, line('t1', 100));
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('prompt', { text: 'a', title: '1', transcriptPath: tp }));
    await sse.next('office');
    assert.equal((await sse.next('usage')).tokens.total, 100);
    fs.appendFileSync(tp, line('t2', 7));
    await post(s, ev('prompt', { text: 'b', title: '2', transcriptPath: tp }));
    const o = await sse.next('office');
    assert.equal(o.snapshot.usage.tokens.total, 0);
    assert.equal((await sse.next('usage')).tokens.total, 7);
    sse.close();
  });
});

test('形は正しいが中身が変なイベントでもサーバーは落ちず、次のリクエストに答える', async () => {
  await withServer(async (s) => {
    const odd = [
      ev('tool', { text: 123, title: { a: 1 }, agentId: { x: 1 } }),
      ev('delegate', { text: null, title: 5, targetType: [] }),
      ev('subagent_start', { agentId: 7, agentType: {} }),
      ev('no_such_kind', { text: 'x' }),
      ev('prompt', { title: 99, transcriptPath: 42 }),
    ];
    for (const o of odd) {
      const r = await post(s, o);
      assert.ok([204, 400].includes(r.status), `status ${r.status}`);
    }
    assert.equal((await health(s)).ok, true);
  });
});

test('POST の prompt は source を office と名乗れず、snapshot に instruction が載る', async () => {
  await withServer(async (s) => {
    const sse = await openSse(s);
    await sse.next('snapshot');
    await post(s, ev('prompt', { text: 'a', title: 't', body: '指示本文', source: 'office' }));
    const o = await sse.next('office');
    assert.deepEqual(o.snapshot.instruction, { text: '指示本文', ts: 1, source: 'terminal', status: 'working' });
    sse.close();
  });
});

test('契約: snapshot.members は席ごとに seat・role・nickname・dept を持ち、応援席は無い', async () => {
  await withServer(async (s) => {
    const sse = await openSse(s);
    const snap = await sse.next('snapshot');
    for (const m of snap.members) {
      for (const k of ['seat', 'role', 'nickname', 'dept', 'status']) assert.equal(typeof m[k], 'string', `${m.seat}.${k}`);
    }
    const by = (id) => snap.members.find((m) => m.seat === id);
    assert.equal(by('implementer').nickname, 'タクミくん');
    assert.equal(by('researcher').dept, 'research');
    assert.equal(snap.members.length, 17);
    assert.ok(!snap.members.some((m) => m.seat.startsWith('helper-') || m.dept === 'support'));
    assert.ok(snap.members.every((m) => Number.isInteger(m.count)));
    await post(s, ev('delegate', { text: 'x', title: 't', targetType: 'Explore' }));
    const o = await sse.next('office');
    assert.equal(o.snapshot.members.find((m) => m.seat === 'researcher').status, 'working');
    sse.close();
  });
});
