import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, untilEffect } from './helpers.mjs';

const hookPath = fileURLToPath(new URL('../office-hook.mjs', import.meta.url));

function runHook(stdin, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [hookPath], {
      env: { ...process.env, OFFICE_PORT: String(port), OFFICE_NO_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function firstSnapshot(port) {
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    let buf = '';
    const dec = new TextDecoder();
    while (!buf.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    return JSON.parse(/^data: (.*)$/m.exec(buf)[1]);
  } finally { ac.abort(); }
}

const readInput = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\日本語\\a.md' } };

test('サーバーが無くても数秒以内に終了コード0で何も出力しない', async () => {
  const r = await runHook(JSON.stringify(readInput), await freePort());
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  assert.ok(r.ms < 30000, `took ${r.ms}ms`);
});

test('JSON でない・空の標準入力でもコード0で何も出力しない', async () => {
  const port = await freePort();
  for (const input of ['not json', '', '[1,2]', 'null']) {
    const r = await runHook(input, port);
    assert.equal(r.code, 0);
    assert.equal(r.out + r.err, '');
  }
});

test('稼働中のサーバーへ節目を送る', async () => {
  const s = await startTestServer({ port: 0 });
  try {
    let snap;
    const r = await untilEffect(() => runHook(JSON.stringify(readInput), s.port), async () => { snap = await firstSnapshot(s.port); return snap.log.some((l) => l.text.includes('a.mdを読んでいます')); });
    assert.equal(r.code, 0);
    assert.equal(r.out + r.err, '');
    assert.ok(snap.log.some((l) => l.text.includes('a.mdを読んでいます')), JSON.stringify(snap.log));
  } finally { await s.close(); }
});

test('AskUserQuestion は ask として送られ、decisions に載る(回答は扱わない)', async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [
      { question: '進めますか?', header: '判断', multiSelect: false, options: [{ label: 'はい', description: '進める' }, { label: 'いいえ', description: '見送る' }] }] } };
    let snap;
    const r = await untilEffect(() => runHook(JSON.stringify(input), s.port), async () => { snap = await firstSnapshot(s.port); return snap.decisions.length > 0; });
    assert.equal(r.code, 0);
    assert.equal(r.out + r.err, '');
    assert.equal(snap.decisions.length, 1);
    assert.equal(snap.decisions[0].status, 'pending');
    assert.equal(snap.decisions[0].question, '進めますか?');
    assert.deepStrictEqual(snap.decisions[0].options.map((o) => o.label), ['はい', 'いいえ']);
    assert.equal(snap.members.find((m) => m.seat === 'bucho').status, 'waiting');
  } finally { await s.close(); }
});

test('SessionStart でサーバーが無ければ自動起動する', async () => {
  const port = await freePort();
  let pid;
  try {
    const r = await runHook(JSON.stringify({ hook_event_name: 'SessionStart' }), port);
    assert.equal(r.code, 0);
    assert.equal(r.out + r.err, '');
    assert.ok(r.ms < 45000, `took ${r.ms}ms`);
    let h = null;
    for (let i = 0; i < 50 && !h; i++) { // 機械が重いと起動が遅れるので待って再試行する
      h = await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.json(), () => null);
      if (!h) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(h.ok, true);
    pid = h.pid;
  } finally {
    // 途中で失敗しても、遅れて起動した切り離しサーバーを残さない
    for (let i = 0; i < 50 && !pid; i++) {
      const h = await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.json(), () => null);
      if (h?.pid) pid = h.pid; else await new Promise((r) => setTimeout(r, 100));
    }
    if (pid) { try { process.kill(pid); } catch { /* 既に終了 */ } }
  }
});

test('describe.mjs に構文エラーがあっても終了コード0で何も出力しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hook-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.copyFileSync(hookPath, path.join(dir, 'office-hook.mjs'));
    fs.writeFileSync(path.join(dir, 'lib', 'describe.mjs'), 'export const = ;');
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(dir, 'office-hook.mjs')], { env: { ...process.env, OFFICE_PORT: String(1), OFFICE_NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let o = '';
      p.stdout.on('data', (d) => { o += d; });
      p.stderr.on('data', (d) => { o += d; });
      p.on('close', (code) => resolve({ code, o }));
      p.stdin.end('{}');
    });
    assert.equal(r.code, 0);
    assert.equal(r.o, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
