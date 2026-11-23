import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageMeter } from '../lib/usage-meter.mjs';

const pricing = {
  usdJpy: 100,
  models: {
    'claude-a': { input: 1, output: 10, cacheWrite: 2, cacheRead: 0.5 },
    'claude-a-long': { input: 100, output: 100, cacheWrite: 100, cacheRead: 100 },
  },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-meter-'));
let n = 0;
const file = (name = `t${n++}.jsonl`) => path.join(dir, name);
const line = (id, u, model = 'claude-a') => JSON.stringify({
  type: 'assistant',
  message: { id, model, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u } },
}) + '\n';
const mk = () => createUsageMeter({ pricing, allowedRoot: dir });

test('別idの2行を合計し、単価表どおりの金額になる', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { input_tokens: 1_000_000 }) + line('m2', { output_tokens: 100_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000 }));
  const m = mk();
  await m.track(p, 'boss');
  const t = m.totals();
  assert.deepStrictEqual(t.tokens, { input: 1_000_000, output: 100_000, cacheWrite: 1_000_000, cacheRead: 2_000_000, total: 4_100_000 });
  // 1 + 1 + 2 + 1 = 5 USD
  assert.ok(Math.abs(t.usd - 5) < 1e-9);
  assert.ok(Math.abs(t.jpy - 500) < 1e-9);
  assert.deepStrictEqual(t.bySeat, { boss: 4_100_000 });
  assert.equal(t.skippedFiles, 0);
});

test('同じidが複数行出たら最後の値だけを数える', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { output_tokens: 1 }) + line('m1', { output_tokens: 5 }) + line('m1', { output_tokens: 9 }));
  const m = mk();
  await m.track(p, 'boss');
  assert.equal(m.totals().tokens.output, 9);
});

test('idの再出現は追記分でも差し替えになる', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { output_tokens: 3 }));
  const m = mk();
  await m.track(p, 'boss');
  fs.appendFileSync(p, line('m1', { output_tokens: 7 }));
  await m.track(p, 'boss');
  assert.equal(m.totals().tokens.output, 7);
});

test('2回目のtrackは追記分だけ、書きかけの行は完成後に数える', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { input_tokens: 10 }));
  const m = mk();
  await m.track(p, 'boss');
  const full = line('m2', { input_tokens: 5 });
  fs.appendFileSync(p, full.slice(0, 30));
  await m.track(p, 'boss');
  assert.equal(m.totals().tokens.input, 10);
  fs.appendFileSync(p, full.slice(30));
  await m.track(p, 'boss');
  assert.equal(m.totals().tokens.input, 15);
});

test('壊れた行・user行は無視し例外を出さない', async () => {
  const p = file();
  fs.writeFileSync(p, '{broken\n' + JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { id: 'z' } }) + '\n' + line('m1', { input_tokens: 2 }));
  const m = mk();
  await m.track(p, 'boss');
  assert.equal(m.totals().tokens.total, 2);
});

test('allowedRoot外のパスと.jsonl以外は読まない', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-outside-'));
  const a = path.join(outside, 'a.jsonl');
  const b = file('b.txt');
  fs.writeFileSync(a, line('m1', { input_tokens: 1 }));
  fs.writeFileSync(b, line('m1', { input_tokens: 1 }));
  const m = createUsageMeter({ pricing, allowedRoot: path.join(dir, 'sub') });
  await m.track(a, 'boss');
  const m2 = mk();
  await m2.track(b, 'boss');
  await m2.track(path.join(dir, '..', path.basename(outside), 'a.jsonl'), 'boss');
  assert.equal(m.totals().tokens.total, 0);
  assert.equal(m2.totals().tokens.total, 0);
});

test('存在しないファイルは例外にならずskippedFilesに数える', async () => {
  const m = mk();
  await m.track(file('none.jsonl'), 'boss');
  await m.track(file('none2.jsonl'), 'boss');
  assert.equal(m.totals().skippedFiles, 2);
});

test('単価未登録モデルはtokensに入りunpricedModelsに出る', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { input_tokens: 1_000_000 }) + line('m2', { input_tokens: 500 }, 'mystery-1'));
  const m = mk();
  await m.track(p, 'boss');
  const t = m.totals();
  assert.equal(t.tokens.input, 1_000_500);
  assert.deepStrictEqual(t.unpricedModels, ['mystery-1']);
  assert.ok(Math.abs(t.usd - 1) < 1e-9);
});

test('モデルは最長一致の単価を使う', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { input_tokens: 1_000_000 }, 'claude-a-long-20260101'));
  const m = mk();
  await m.track(p, 'boss');
  assert.ok(Math.abs(m.totals().usd - 100) < 1e-9);
});

test('resetTurn後は0、以後の追記だけ数える(ファイル位置と進行中idは保持)', async () => {
  const p = file();
  fs.writeFileSync(p, line('m1', { output_tokens: 4 }));
  const m = mk();
  await m.track(p, 'boss');
  m.resetTurn();
  assert.equal(m.totals().tokens.total, 0);
  assert.deepStrictEqual(m.totals().bySeat, {});
  fs.appendFileSync(p, line('m2', { output_tokens: 6 }) + line('m1', { output_tokens: 10 }));
  await m.track(p, 'boss');
  // m1は再出現して4->10に伸びたので増分6だけ、m2は6
  assert.equal(m.totals().tokens.output, 12);
});

test('席ごとに合計し、pricingなしならusdはnull', async () => {
  const p1 = file(), p2 = file();
  fs.writeFileSync(p1, line('m1', { input_tokens: 3 }));
  fs.writeFileSync(p2, line('s1', { input_tokens: 4 }));
  const m = createUsageMeter({ pricing: null, allowedRoot: dir });
  await m.track(p1, 'boss');
  await m.track(p2, 'agent-x');
  const t = m.totals();
  assert.deepStrictEqual(t.bySeat, { boss: 3, 'agent-x': 4 });
  assert.equal(t.usd, null);
  assert.equal(t.jpy, null);
});
