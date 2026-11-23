import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer, openSse, raw } from './helpers.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const scriptPath = fileURLToPath(new URL('../tools/post-answer.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-answer-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';
const J = { 'Content-Type': 'application/json' };

function run(args, stdin, port) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, OFFICE_PORT: String(port), OFFICE_SEND_TIMEOUT_MS: '15000' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(stdin ?? '');
  });
}
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const post = (s, body) => run(['--stdin'], JSON.stringify(body), s.port);
const snapOf = async (s) => { const sse = await openSse(s); const sn = await sse.snapshot(); sse.close(); return sn; };

test('正常: --stdin の日本語がそのまま掲示され、by は部長の愛称・status は new', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    const r = await post(s, { question: '来季の方針はどちらを優先?', answer: '案Aを優先します。理由は実績が多いためです。' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    const sn = await snapOf(s);
    assert.equal(sn.answers.length, 1);
    const a = sn.answers[0];
    assert.deepEqual({ ...a, askedAt: typeof a.askedAt }, { id: 'r1', askedAt: 'number', question: '来季の方針はどちらを優先?', answer: '案Aを優先します。理由は実績が多いためです。', by: 'ムサシ部長', status: 'new' });
    await run(['質問', '答え'], '', s.port); // 引数方式
    const sn2 = await snapOf(s);
    assert.equal(sn2.answers.length, 2);
    assert.equal(sn2.answers[0].question, '質問');
  } finally { await s.close(); }
});

test('空・長すぎ: 空は載せず、長すぎは100字/300字で切り、どれも終了コード0', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    for (const b of [{}, { question: '', answer: 'x' }, { question: 'q', answer: '   ' }, { question: 1, answer: 2 }]) assert.equal((await post(s, b)).code, 0);
    assert.equal((await run(['--stdin'], 'not json', s.port)).code, 0);
    assert.equal((await run([], '', s.port)).code, 0);
    assert.equal((await snapOf(s)).answers.length, 0);
    await post(s, { question: 'あ'.repeat(150), answer: '😀'.repeat(400) });
    const sn = await snapOf(s);
    assert.equal([...sn.answers[0].question].length, 100);
    assert.equal([...sn.answers[0].answer].length, 300);
  } finally { await s.close(); }
});

test('サーバーが無くても終了コード0', async () => {
  const r = await run(['q', 'a'], '', await freePort());
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('件数は直近10件・新しい順', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    for (let i = 1; i <= 12; i++) {
      await fetch(`http://127.0.0.1:${s.port}/event`, { method: 'POST', headers: J, body: JSON.stringify({ ts: i, kind: 'answer', agentId: null, question: `q${i}`, answer: `a${i}` }) });
    }
    const sn = await snapOf(s);
    assert.equal(sn.answers.length, 10);
    assert.deepEqual(sn.answers.map((a) => a.question), ['q12', 'q11', 'q10', 'q9', 'q8', 'q7', 'q6', 'q5', 'q4', 'q3']);
  } finally { await s.close(); }
});

test('既読: /answer-read で new -> read、未知の id は404、不正は400・415、他サイトは403', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    await post(s, { question: 'q', answer: 'a' });
    const rd = (body, headers = J) => raw(s.port, '/answer-read', { method: 'POST', headers, body });
    assert.equal((await rd(JSON.stringify({ id: 'zzz' }))).status, 404);
    assert.equal((await rd('not json')).status, 400);
    assert.equal((await rd(JSON.stringify({ id: 5 }))).status, 400);
    assert.equal((await rd(JSON.stringify({ id: 'r1' }), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await rd(JSON.stringify({ id: 'r1' }), { ...J, Origin: 'http://evil.example' })).status, 403);
    assert.equal((await snapOf(s)).answers[0].status, 'new');
    assert.equal((await rd(JSON.stringify({ id: 'r1' }))).status, 204);
    assert.equal((await snapOf(s)).answers[0].status, 'read');
    assert.equal((await raw(s.port, '/answer-read', { method: 'POST', headers: { ...J, Host: 'evil.example' }, body: '{"id":"r1"}' })).status, 403);
  } finally { await s.close(); }
});

test('遠隔: /answer-read は合言葉があっても403、snapshot には answers が載る(指示本文と同じ扱い)', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    await post(s, { question: 'q', answer: 'a' });
    const rp = s.remotePort();
    const base = { host: '127.0.0.1', port: rp, headers: { Host: `127.0.0.1:${rp}`, Cookie: `office_key=${TOKEN}`, ...J } };
    const status = await new Promise((resolve, reject) => {
      const r = http.request({ ...base, path: '/answer-read', method: 'POST' }, (x) => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
      r.on('error', reject); r.end('{"id":"r1"}');
    });
    assert.equal(status, 403);
    assert.equal((await snapOf(s)).answers[0].status, 'new');
    const snap = await new Promise((resolve, reject) => {
      const rq = http.get({ ...base, path: '/events' }, (x) => {
        let buf = '';
        x.on('data', (c) => { buf += c; const m = /^data: (.*)$/m.exec(buf); if (m) { rq.destroy(); resolve(JSON.parse(m[1])); } });
      });
      rq.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.equal(snap.answers.length, 1);
    assert.equal(snap.answers[0].answer, 'a');
  } finally { await s.close(); }
});
