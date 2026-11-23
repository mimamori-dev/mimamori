import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw, openSse } from './helpers.mjs';

// 複数の指示の進み具合(snapshot.instructions)。設計書 11章
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ilist-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const J = { 'Content-Type': 'application/json' };

async function withServer(fn, opts = {}) {
  const s = await startTestServer({ port: 0, allowedRoot: dir, ...opts });
  try { await fn(s); } finally { await s.close(); }
}
const postI = (s, text) => raw(s.port, '/instruction', { method: 'POST', headers: J, body: JSON.stringify({ text }) });
const next = (s) => raw(s.port, '/instruction/next?wait=0.05');
const postEv = (s, ev) => raw(s.port, '/event', { method: 'POST', headers: J, body: JSON.stringify({ ts: 1, agentId: null, agentType: null, text: '', ...ev }) });
const snapOf = async (s) => { const c = await openSse(s); try { return await c.snapshot(); } finally { c.close(); } };
const stat = (sn) => sn.instructions.map((i) => i.status);
const bucho = (sn) => sn.members.find((m) => m.seat === 'bucho');

test('送信で queued が増え inbox.pending と一致。取り出しは1件ずつ assigning', async () => {
  await withServer(async (s) => {
    for (const t of ['A', 'B', 'C']) await postI(s, t);
    let sn = await snapOf(s);
    assert.deepEqual(stat(sn), ['queued', 'queued', 'queued']);
    assert.equal(sn.inbox.pending, 3);
    assert.deepEqual(sn.instructions.map((i) => i.id), ['i1', 'i2', 'i3']);
    assert.ok(sn.instructions.every((i) => i.source === 'office' && typeof i.ts === 'number'));
    await next(s);
    sn = await snapOf(s);
    assert.deepEqual(stat(sn), ['assigning', 'queued', 'queued']); // 次の queued は assigning にならない
    assert.equal(sn.inbox.pending, 2);
    assert.deepEqual(sn.instructions.map((i) => i.text), ['A', 'B', 'C']); // 順序は送信順
    await next(s);
    sn = await snapOf(s);
    assert.deepEqual(stat(sn), ['done', 'assigning', 'queued']); // 前の assigning は done
    assert.equal(sn.instruction.text, 'B'); // 互換の単一表示は最新
  });
});

test('部長の最初の tool/delegate で working、stop で done(queued は残る)', async () => {
  await withServer(async (s) => {
    await postI(s, '一件目'); await postI(s, '二件目');
    await next(s);
    await postEv(s, { kind: 'tool', agentId: 'sub1', agentType: 'x', text: '担当のツール' }); // 担当のツールでは進まない
    assert.deepEqual(stat(await snapOf(s)), ['assigning', 'queued']);
    await postEv(s, { kind: 'tool', text: 'ファイルを探しています' });
    assert.deepEqual(stat(await snapOf(s)), ['working', 'queued']);
    await postEv(s, { kind: 'subagent_done', agentId: 'sub1', agentType: 'x', text: '終わりました' }); // 担当が動いている間は stop でも完了にならない
    await postEv(s, { kind: 'stop', text: '社長に報告' });
    assert.deepEqual(stat(await snapOf(s)), ['done', 'queued']);
    await next(s);
    await postEv(s, { kind: 'delegate', text: 'x', targetType: 'report-writer', title: 't' });
    assert.deepEqual(stat(await snapOf(s)), ['done', 'working']);
  });
});

test('hook の prompt は assigning で追加(terminal)。source・instrId の偽装と担当の prompt は無視', async () => {
  await withServer(async (s) => {
    await postEv(s, { kind: 'prompt', text: '社長から…', title: 't', body: 'ターミナル\nからの指示', source: 'office' });
    let sn = await snapOf(s);
    assert.deepEqual(sn.instructions.map((i) => [i.source, i.status, i.text]), [['terminal', 'assigning', 'ターミナル からの指示']]);
    await postEv(s, { kind: 'prompt', agentId: 'sub1', text: 'x', body: '担当の指示' });
    sn = await snapOf(s);
    assert.equal(sn.instructions.length, 1);
    assert.equal(sn.instructions[0].status, 'assigning');
    await postI(s, '送信済み');
    await postEv(s, { kind: 'prompt', text: 'y', body: '次のターミナル指示', instrId: 'i2' }); // 受け取り待ちを横取りできない
    sn = await snapOf(s);
    assert.deepEqual(stat(sn), ['done', 'queued', 'assigning']);
    assert.equal(sn.inbox.pending, 1);
  });
});

test('100字に切り詰め・改行は空白。10件を超えたら古い done から捨てる', async () => {
  await withServer(async (s) => {
    await postI(s, 'あ'.repeat(150));
    await postI(s, '1行目\n2行目');
    let sn = await snapOf(s);
    assert.equal([...sn.instructions[0].text].length, 100);
    assert.equal(sn.instructions[1].text, '1行目 2行目');
    await next(s); await next(s);
    for (let i = 0; i < 12; i++) await postEv(s, { kind: 'prompt', text: 'p', body: `P${i}` });
    sn = await snapOf(s);
    assert.equal(sn.instructions.length, 10);
    assert.deepEqual(sn.instructions.map((i) => i.text), Array.from({ length: 10 }, (_, i) => `P${i + 2}`));
    assert.equal(sn.instructions.at(-1).status, 'assigning');
  });
});

test('キュー満杯(10件 queued)でも inbox.pending と一致し、取り出しで進む', async () => {
  await withServer(async (s) => {
    for (let i = 0; i < 10; i++) await postI(s, `q${i}`);
    assert.equal((await postI(s, 'あふれ')).status, 429);
    let sn = await snapOf(s);
    assert.equal(sn.instructions.length, 10);
    assert.equal(sn.inbox.pending, 10);
    await next(s);
    sn = await snapOf(s);
    assert.equal(sn.instructions.filter((i) => i.status === 'queued').length, sn.inbox.pending);
  });
});

test('部長の吹き出し: 取り出し後しばらくして「タスクを振っています」', async () => {
  await withServer(async (s) => {
    const sse = await openSse(s);
    await sse.snapshot();
    await postI(s, '分析して');
    await next(s);
    const first = await sse.office((e) => e.event.kind === 'prompt');
    assert.equal(bucho(first.snapshot).bubble, '社長から『分析して』の指示を受けました');
    const later = await sse.office((e) => e.event.kind === 'inbox' && bucho(e.snapshot).bubble === 'タスクを振っています');
    assert.equal(later.snapshot.instructions[0].status, 'assigning');
    sse.close();
  }, { assignBubbleMs: 30 });
});

test('先にツールが出る・確認待ちになったときは「タスクを振っています」に上書きしない', async () => {
  await withServer(async (s) => {
    await postI(s, '分析して');
    await next(s);
    await postEv(s, { kind: 'tool', text: 'ファイルを探しています' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bucho(await snapOf(s)).bubble, 'ファイルを探しています');
  }, { assignBubbleMs: 30 });
  await withServer(async (s) => {
    await postI(s, '分析して');
    await next(s);
    await postEv(s, { kind: 'waiting', text: '社長の確認待ち' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bucho(await snapOf(s)).bubble, '社長の確認待ち');
  }, { assignBubbleMs: 30 });
});
