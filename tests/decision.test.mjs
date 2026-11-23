import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer, raw, openSse } from './helpers.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-dec-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';
const J = { 'Content-Type': 'application/json' };
const GRACE = 150;

async function withServer(fn, opts = {}) {
  const s = await startTestServer({ port: 0, allowedRoot: dir, decisionGraceMs: GRACE, ...opts });
  try { await fn(s); } finally { await s.close(); }
}
const post = (s, p, body, headers = J) => raw(s.port, p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const card = { header: '選択先', question: 'どの案にしますか', options: [{ label: '案A', description: '堅実' }, { label: '案B', description: '大穴' }] };
const newCard = async (s, c = card) => { const r = await post(s, '/decision', c); assert.equal(r.status, 201, r.text); return JSON.parse(r.text).id; };
const snapOf = async (s, local = true) => {
  const sse = await openSse(s);
  try { return await sse.snapshot(); } finally { sse.close(); }
};
const decision = async (s, id) => (await snapOf(s)).decisions.find((d) => d.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t0 = Date.now(); for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } }
const next = (s, wait = 2) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: s.port, path: `/instruction/next?wait=${wait}`, headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }));
  }).on('error', reject);
});

test('POST /decision: カードが source:office・pending で載り、部長が確認待ちになる', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    const snap = await snapOf(s);
    const d = snap.decisions.find((x) => x.id === id);
    assert.equal(d.source, 'office');
    assert.equal(d.status, 'pending');
    assert.equal(d.choice, null);
    assert.equal(d.header, '選択先');
    assert.deepEqual(d.options.map((o) => o.label), ['案A', '案B']);
    assert.equal(snap.members.find((m) => m.seat === 'bucho').status, 'waiting');
    assert.equal(snap.waiting.kind, 'question');
  });
});

test('POST /decision: 選択肢2個未満・不正入力は 400、型違いは 415、開いたカードは5件まで', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/decision', { ...card, options: [{ label: 'だけ' }] })).status, 400);
    assert.equal((await post(s, '/decision', { header: 'h', question: '', options: card.options })).status, 400);
    assert.equal((await post(s, '/decision', { question: 'q' })).status, 400);
    assert.equal((await post(s, '/decision', 'not json')).status, 400);
    assert.equal((await post(s, '/decision', [1])).status, 400);
    assert.equal((await post(s, '/decision', card, {})).status, 415);
    for (let i = 0; i < 5; i++) await newCard(s);
    assert.equal((await post(s, '/decision', card)).status, 429);
  });
});

test('POST /answer: 選ぶと pending のまま choice と confirmAt を持ち、猶予後に確定して受信箱へ入る', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    const t0 = Date.now();
    const r = await post(s, '/answer', { id, choice: 1 });
    assert.equal(r.status, 200);
    const d1 = await decision(s, id);
    assert.equal(d1.status, 'pending');
    assert.equal(d1.choice, 1);
    assert.ok(d1.confirmAt >= t0 && d1.confirmAt <= t0 + GRACE + 500);
    const got = await next(s, 5); // 猶予が終わると受信箱に入り、待ち受けが受け取る
    assert.equal(got.status, 200);
    assert.equal(got.body.text, '【判断への回答】選択先: 案B');
    const d2 = await decision(s, id);
    assert.equal(d2.status, 'answered');
    assert.equal(d2.choice, 1);
  });
});

test('取り消し: 猶予内に取り消すと未回答に戻り、受信箱には入らない。取り消せるのは選択中だけ', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    assert.equal((await post(s, '/answer-cancel', { id })).status, 409); // 選択前
    assert.equal((await post(s, '/answer', { id, choice: 0 })).status, 200);
    assert.equal((await post(s, '/answer-cancel', { id })).status, 204);
    const d = await decision(s, id);
    assert.equal(d.status, 'pending');
    assert.equal(d.choice, null);
    assert.equal(d.confirmAt, null);
    await sleep(GRACE + 200);
    assert.equal((await next(s, 0)).status, 204); // 何も入っていない
    assert.equal((await post(s, '/answer-cancel', { id: 'zzz' })).status, 404);
    // 選び直しもできる
    assert.equal((await post(s, '/answer', { id, choice: 1 })).status, 200);
    assert.equal((await next(s, 5)).body.text, '【判断への回答】選択先: 案B');
    assert.equal((await post(s, '/answer-cancel', { id })).status, 409); // 確定後
  });
});

test('POST /answer の拒否: 範囲外・整数以外は 400、不明 id は 404、二重クリック・回答済みは 409', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    for (const c of [-1, 2, 99, 1.5, '1', null, true, [1], { a: 1 }, NaN, undefined]) {
      const r = await post(s, '/answer', { id, choice: c });
      assert.equal(r.status, 400, `choice=${JSON.stringify(c)}`);
    }
    assert.equal((await post(s, '/answer', { id: 'd999', choice: 0 })).status, 404);
    for (const bad of [5, null, ['d1'], undefined]) assert.equal((await post(s, '/answer', { id: bad, choice: 0 })).status, 400);
    assert.equal((await post(s, '/answer', { id, choice: 0 })).status, 200);
    assert.equal((await post(s, '/answer', { id, choice: 0 })).status, 409); // 二重クリック
    assert.equal((await post(s, '/answer', { id, choice: 1 })).status, 409); // 選択中の別の選択肢
    await next(s, 5);
    assert.equal((await post(s, '/answer', { id, choice: 1 })).status, 409); // 回答済み
    assert.equal((await post(s, '/answer', 'not json')).status, 400);
    assert.equal((await post(s, '/answer', { id, choice: 0 }, {})).status, 415);
    assert.equal((await post(s, '/answer', { id, choice: 0, pad: 'x'.repeat(5000) })).status, 413);
  });
});

test('hook 由来の ask カードは画面から答えられない(409)。ターミナルで答えた扱いは従来どおり', async () => {
  await withServer(async (s) => {
    const ev = { ts: 1, kind: 'ask', agentId: null, agentType: null, text: '', questions: [{ question: '進めますか', header: '確認', options: [{ label: 'はい' }, { label: 'いいえ' }], multiSelect: false }] };
    assert.equal((await post(s, '/event', ev)).status, 204);
    const d = (await snapOf(s)).decisions[0];
    assert.equal(d.source, 'hook');
    assert.equal((await post(s, '/answer', { id: d.id, choice: 0 })).status, 409);
    // 画面経由のカードは、部長の次の tool で答えられたことにはならない
    const id = await newCard(s);
    assert.equal((await post(s, '/event', { ts: 2, kind: 'tool', agentId: null, agentType: null, text: 'x', toolName: 'Read', toolArg: 'a' })).status, 204);
    const after = (await snapOf(s)).decisions;
    assert.equal(after.find((x) => x.id === d.id).status, 'answered');
    assert.equal(after.find((x) => x.id === id).status, 'pending');
  });
});

test('確定までは「質問待ち」のまま。確定後は waiting が消える', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    await post(s, '/answer', { id, choice: 0 });
    assert.equal((await snapOf(s)).waiting.kind, 'question');
    await next(s, 5);
    assert.equal((await snapOf(s)).waiting, null);
  });
});

test('Host・Origin・Sec-Fetch-Site の検査は /command と同じ(他サイト由来は 403)', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    for (const p of ['/decision', '/answer', '/answer-cancel']) {
      const b = JSON.stringify({ id, choice: 0, ...card });
      const send = (headers, o = {}) => raw(s.port, p, { method: 'POST', headers, body: b, ...o });
      assert.equal((await send({ ...J, Origin: 'http://evil.example' })).status, 403, p);
      assert.equal((await send({ ...J, 'Sec-Fetch-Site': 'cross-site' })).status, 403, p);
      assert.equal((await send({ ...J, 'Sec-Fetch-Site': 'same-site' })).status, 403, p);
      assert.equal((await send({ ...J, Host: 'evil.example:4317' })).status, 403, p);
    }
    assert.equal((await post(s, '/answer', { id, choice: 0 }, { ...J, Origin: `http://127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await decision(s, id)).choice, 0);
  });
});

test('遠隔(スマホ)は /decision /answer /answer-cancel が常に 403、snapshot に本文を出さず「判断待ち」だけ', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const id = await newCard(s);
    const rp = s.remotePort();
    const rpost = (p, body) => raw(rp, p, { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify(body) });
    for (const p of ['/decision', '/answer', '/answer-cancel']) assert.equal((await rpost(p, { id, choice: 0, ...card })).status, 403, p);
    assert.equal((await decision(s, id)).choice, null);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${rp}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = res.body.getReader();
    let buf = '';
    while (!buf.includes('\n\n')) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); }
    ac.abort();
    const snap = JSON.parse(/^data: (.*)$/m.exec(buf)[1]);
    const d = snap.decisions.find((x) => x.id === id);
    assert.equal(d.question, '判断待ち');
    assert.deepEqual(d.options, []);
    assert.equal(d.header, '');
    assert.equal(snap.waiting.text, '質問への回答待ち');
    assert.ok(!JSON.stringify(snap).includes('選択先') && !JSON.stringify(snap).includes('案A'));
  });
});

function runTool(script, port, stdin, args = [], env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, '..', 'tools', script), ...args], { env: { ...process.env, OFFICE_PORT: String(port), OFFICE_WAIT_SEC: '1', OFFICE_RETRY_MS: '50', ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => p.kill(), 60_000); // 固まっても全体を止めない
    killer.unref();
    p.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    p.stdin.end(stdin);
  });
}

test('tools/post-decision.mjs: カードを出して待ち、社長が選ぶと答えを標準出力に出して終わる', async () => {
  await withServer(async (s) => {
    const run = runTool('post-decision.mjs', s.port, JSON.stringify(card));
    let id;
    for (let i = 0; i < 100 && !id; i++) { id = (await snapOf(s)).decisions.find((d) => d.source === 'office')?.id; if (!id) await sleep(50); }
    assert.ok(id, 'カードが出る');
    assert.equal((await post(s, '/answer', { id, choice: 0 })).status, 200);
    const r = await run;
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('【判断への回答】選択先: 案A'), r.out);
    assert.equal(r.err, '');
  }, { treeRoot: dir });
});

test('tools/post-decision.mjs: --no-wait はカードだけ出して終わる。不正入力・サーバー無しは非0で標準出力は空', async () => {
  await withServer(async (s) => {
    const a = await runTool('post-decision.mjs', s.port, JSON.stringify(card), ['--no-wait']);
    assert.equal(a.code, 0);
    assert.equal(a.out, '[判断カード id=d1]\n');
    assert.equal((await snapOf(s)).decisions.length, 1);
    const b = await runTool('post-decision.mjs', s.port, 'not json', ['--no-wait']);
    assert.equal(b.code, 2);
    assert.equal(b.out, '');
    const c = await runTool('post-decision.mjs', s.port, JSON.stringify({ ...card, options: [] }), ['--no-wait']);
    assert.equal(c.code, 1);
    assert.equal(c.out, '');
  });
  const d = await runTool('post-decision.mjs', 1, JSON.stringify(card), ['--no-wait']); // 繋がらない
  assert.equal(d.code, 1);
  assert.equal(d.out, '');
});

// ---- 5b: open / terminal ----
const openCard = { mode: 'open', header: '資料のお願い', question: '参考サイトのURLを教えてください' };
const termCard = { mode: 'terminal', header: '承認', question: 'GitHub に push してよいですか', options: [{ label: '許可' }, { label: '見送り' }] };

test('mode: 既定は choice。open / terminal は選択肢0〜4個で作れ、不正な mode・5個以上・choice の選択肢不足は 400', async () => {
  await withServer(async (s) => {
    const a = await newCard(s);
    assert.equal((await decision(s, a)).mode, 'choice');
    const o = await newCard(s, openCard);
    const t = await newCard(s, termCard);
    const sn = await snapOf(s);
    assert.deepEqual(sn.decisions.find((d) => d.id === o).options, []);
    assert.equal(sn.decisions.find((d) => d.id === o).mode, 'open');
    assert.equal(sn.decisions.find((d) => d.id === t).options.length, 2);
    assert.equal(sn.pendingDecisions, 3);
    for (const bad of [{ ...openCard, mode: 'x' }, { ...openCard, mode: 5 }, { ...openCard, mode: null }, { ...card, mode: 'choice', options: [] }, { mode: 'open', header: 'h' }]) {
      assert.equal((await post(s, '/decision', bad)).status, 400, JSON.stringify(bad));
    }
    const many = await newCard(s, { ...termCard, options: [1, 2, 3, 4, 5].map((n) => ({ label: `案${n}` })) });
    assert.equal((await decision(s, many)).options.length, 4); // 4個まで
  });
});

test('open / terminal はクリックでは答えられない(409)。待たない(bucho の応答なしでも pending のまま)', async () => {
  await withServer(async (s) => {
    const o = await newCard(s, openCard);
    const t = await newCard(s, termCard);
    for (const id of [o, t]) assert.equal((await post(s, '/answer', { id, choice: 0 })).status, 409);
    assert.equal((await post(s, '/answer-cancel', { id: o })).status, 409);
  });
});

test('open: 社長の入力欄から指示が届くと「回答あり」になり、内容は受信箱経由で受け取れる。terminal は変わらない', async () => {
  await withServer(async (s) => {
    const o = await newCard(s, openCard);
    const t = await newCard(s, termCard);
    const c = await newCard(s);
    const r = await post(s, '/instruction', { text: 'https://example.com/db です' });
    assert.equal(r.status, 202);
    const sn = await snapOf(s);
    assert.equal(sn.decisions.find((d) => d.id === o).status, 'answered');
    assert.equal(sn.decisions.find((d) => d.id === t).status, 'pending');
    assert.equal(sn.decisions.find((d) => d.id === c).status, 'pending'); // choice は指示では答えたことにならない
    assert.equal(sn.pendingDecisions, 2);
    const got = await next(s, 2);
    assert.equal(got.body.text, 'https://example.com/db です');
    assert.equal((await post(s, '/instruction', { text: '' })).status, 400); // 不正な指示では変わらない
  });
});

test('POST /decision-resolve: terminal / open を回答済みにする。choice・不明 id・回答済みは拒否。遠隔は 403', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const t = await newCard(s, termCard);
    const c = await newCard(s);
    assert.equal((await post(s, '/decision-resolve', { id: c })).status, 409);
    assert.equal((await post(s, '/decision-resolve', { id: 'd99' })).status, 404);
    assert.equal((await post(s, '/decision-resolve', { id: 5 })).status, 400);
    assert.equal((await post(s, '/decision-resolve', { id: t }, { ...J, Origin: 'http://evil.example' })).status, 403);
    assert.equal((await raw(s.remotePort(), '/decision-resolve', { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify({ id: t }) })).status, 403);
    assert.equal((await decision(s, t)).status, 'pending');
    assert.equal((await post(s, '/decision-resolve', { id: t })).status, 204);
    assert.equal((await decision(s, t)).status, 'answered');
    assert.equal((await post(s, '/decision-resolve', { id: t })).status, 409);
    assert.equal((await snapOf(s)).pendingDecisions, 1);
  });
});

test('遠隔: open / terminal も本文なし「確認待ち」のみで、mode と件数は出る', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    await newCard(s, openCard);
    await newCard(s, termCard);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.remotePort()}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = res.body.getReader();
    let buf = '';
    while (!buf.includes('\n\n')) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); }
    ac.abort();
    const snap = JSON.parse(/^data: (.*)$/m.exec(buf)[1]);
    assert.deepEqual(snap.decisions.map((d) => [d.mode, d.question, d.options.length, d.header]), [['open', '確認待ち', 0, ''], ['terminal', '確認待ち', 0, '']]);
    assert.equal(snap.pendingDecisions, 2);
    const j = JSON.stringify(snap);
    for (const w of ['URL', 'GitHub', '許可', '資料のお願い', '見送り']) assert.ok(!j.includes(w), w);
  });
});

test('post-decision.mjs: open / terminal は待たず id を出して終わり、--resolve で閉じられる', async () => {
  await withServer(async (s) => {
    const a = await runTool('post-decision.mjs', s.port, JSON.stringify(openCard));
    assert.equal(a.code, 0);
    assert.match(a.out, /^\[判断カード id=d1\]\n$/);
    const b = await runTool('post-decision.mjs', s.port, JSON.stringify(termCard));
    assert.match(b.out, /id=d2\]/);
    const c = await runTool('post-decision.mjs', s.port, '', ['--resolve', 'd2']);
    assert.equal(c.code, 0);
    assert.equal((await decision(s, 'd2')).status, 'answered');
    assert.equal((await runTool('post-decision.mjs', s.port, '', ['--resolve', 'd2'])).code, 1); // 二度目は拒否
    assert.equal((await runTool('post-decision.mjs', s.port, '', ['--resolve'])).code, 1);
    assert.equal((await runTool('post-decision.mjs', s.port, JSON.stringify({ ...openCard, mode: 'bad' }))).code, 1);
  });
});

test('実測: 待ち受けが複数あっても、1件の指示は1つの待ち受けにだけ届く(全員には届かない)。順に1件ずつ割り当たる', async () => {
  await withServer(async (s) => {
    const mk = (script, input) => runTool(script, s.port, input, [], { OFFICE_WAIT_SEC: '4' });
    const waiters = [mk('wait-instruction.mjs', ''), mk('wait-instruction.mjs', ''), mk('post-decision.mjs', JSON.stringify(card))];
    // 3つとも待ち受けに入ったことを(負荷で遅れても)確かめてから送る。順序は固定せず、1件ずつ1つだけが受け取ることを見る
    await until(async () => (await snapOf(s)).inbox.listening && (await snapOf(s)).decisions.length === 1);
    await sleep(1500);
    const texts = ['一件目の指示', '二件目の指示', '三件目の指示'];
    const results = [];
    let doneCount = 0;
    waiters.forEach((w, i) => w.then((r) => { results[i] = r; doneCount++; }));
    for (const [i, t] of texts.entries()) {
      assert.equal((await post(s, '/instruction', { text: t })).status, 202);
      await until(() => doneCount === i + 1, 20000); // 送るたびに、ちょうど1つだけが終わる
    }
    await Promise.all(waiters);
    const got = results.map((r) => texts.filter((t) => r.out.includes(t)));
    assert.ok(got.every((g) => g.length === 1), JSON.stringify(got)); // 各待ち受けは1件だけ受け取る
    assert.deepEqual(got.flat().sort(), [...texts].sort()); // 同じ指示が2つに届くことは無い
  });
});

// ---- 「その他」(自由記入) ----
const OTHER = '第3の案Cにします(予算は別途相談)';

test('その他: 正常系。猶予中は pickedOther、確定で受信箱に「その他: 入力文」。snapshot に入力文は出ない', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    assert.equal((await decision(s, id)).allowOther, true); // 既定は有効
    const r = await post(s, '/answer', { id, other: `  ${OTHER}  ` });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(JSON.parse(r.text)).sort(), ['confirmAt', 'id', 'other']);
    assert.ok(!r.text.includes('案C'));
    const d1 = await decision(s, id);
    assert.equal(d1.status, 'pending');
    assert.equal(d1.pickedOther, true);
    assert.equal(d1.choice, null);
    assert.equal(d1.answeredOther, false);
    assert.ok(!JSON.stringify(await snapOf(s)).includes('案C'));
    const got = await next(s, 5);
    assert.equal(got.status, 200);
    assert.equal(got.body.text, `【判断への回答】選択先: その他: ${OTHER}`); // 前後の空白は除かれる
    const d2 = await decision(s, id);
    assert.equal(d2.status, 'answered');
    assert.equal(d2.answeredOther, true);
    assert.equal(d2.pickedOther, false);
    const snapJson = JSON.stringify(await snapOf(s)); // PC 向け(ログ・活動ログ・指示一覧を含む)にも本文は出ない
    assert.ok(!snapJson.includes('案C') && !snapJson.includes('別途相談'));
    assert.ok(snapJson.includes('その他')); // 一覧には「その他」とだけ出る
    assert.equal((await decision(s, id)).other, undefined);
  }, { decisionGraceMs: 1500 }); // 猶予中の状態を調べる間に確定しないよう長めに
});

test('その他: 改行は許可(CRLF は LF)。500文字ちょうどは通り、サロゲートペアは1文字と数える', async () => {
  await withServer(async (s) => {
    const a = await newCard(s);
    assert.equal((await post(s, '/answer', { id: a, other: '一行目\r\n二行目' })).status, 200);
    assert.equal((await next(s, 5)).body.text, '【判断への回答】選択先: その他: 一行目\n二行目');
    const b = await newCard(s);
    assert.equal((await post(s, '/answer', { id: b, other: 'あ'.repeat(500) })).status, 200);
    assert.equal((await next(s, 5)).body.text, `【判断への回答】選択先: その他: ${'あ'.repeat(500)}`);
    const c = await newCard(s);
    assert.equal((await post(s, '/answer', { id: c, other: '𠮷'.repeat(500) })).status, 200); // 4バイト文字500個
  });
});

test('その他の拒否: 空・空白のみ・501文字・型違い・制御文字・壊れたサロゲート・choice との同時指定は 400', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    const bad = ['', '   ', '\n\n', 'あ'.repeat(501), '𠮷'.repeat(501), 'a\tb', 'a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u0085b', 'a b', 'x\ud800y', '\udc00', 5, null, true, ['a'], { a: 1 }, undefined];
    for (const o of bad) {
      const r = await post(s, '/answer', { id, other: o });
      assert.equal(r.status, 400, `other=${JSON.stringify(o)}`);
    }
    assert.equal((await post(s, '/answer', { id, other: 'ok', choice: 0 })).status, 400);
    assert.equal((await post(s, '/answer', { id, other: 'ok', choice: null })).status, 400);
    assert.equal((await post(s, '/answer', { id, other: 'ok', choice: 'x' })).status, 400);
    assert.equal((await post(s, '/answer', { id: 'd999', other: 'ok' })).status, 404);
    assert.equal((await post(s, '/answer', { id, other: 'ok', pad: 'x'.repeat(5000) })).status, 413);
    const d = await decision(s, id); // どれも受け付けられていない
    assert.equal(d.status, 'pending');
    assert.equal(d.pickedOther, false);
    await sleep(GRACE + 200);
    assert.equal((await next(s, 0)).status, 204);
  });
});

test('その他: 取り消すと未回答に戻り受信箱に入らない。選び直し・二重回答の拒否', async () => {
  await withServer(async (s) => {
    const id = await newCard(s);
    assert.equal((await post(s, '/answer', { id, other: '一案' })).status, 200);
    assert.equal((await post(s, '/answer', { id, other: '二案' })).status, 409); // 選択中の二重
    assert.equal((await post(s, '/answer', { id, choice: 0 })).status, 409); // 選択中に別の答え方
    assert.equal((await post(s, '/answer-cancel', { id })).status, 204);
    const d = await decision(s, id);
    assert.equal(d.status, 'pending');
    assert.equal(d.pickedOther, false);
    assert.equal(d.confirmAt, null);
    await sleep(1700);
    assert.equal((await next(s, 0)).status, 204);
    assert.equal((await post(s, '/answer', { id, other: '二案' })).status, 200); // 選び直し
    assert.equal((await next(s, 5)).body.text, '【判断への回答】選択先: その他: 二案');
    assert.equal((await post(s, '/answer', { id, other: '三案' })).status, 409); // 回答済み
    assert.equal((await post(s, '/answer', { id, choice: 1 })).status, 409);
    assert.equal((await post(s, '/answer-cancel', { id })).status, 409);
    // choice を選んでいる間に other も不可
    const id2 = await newCard(s);
    assert.equal((await post(s, '/answer', { id: id2, choice: 0 })).status, 200);
    assert.equal((await post(s, '/answer', { id: id2, other: 'x' })).status, 409);
  }, { decisionGraceMs: 1500 });
});

test('allowOther:false のカードは other を 400 で拒否し、choice は従来どおり。非 boolean は作成時に 400', async () => {
  await withServer(async (s) => {
    const id = await newCard(s, { ...card, allowOther: false });
    assert.equal((await decision(s, id)).allowOther, false);
    assert.equal((await post(s, '/answer', { id, other: 'x' })).status, 400);
    assert.equal((await post(s, '/answer', { id, choice: 1 })).status, 200);
    assert.equal((await next(s, 5)).body.text, '【判断への回答】選択先: 案B');
    assert.equal((await post(s, '/decision', { ...card, allowOther: 'no' })).status, 400);
    assert.equal((await post(s, '/decision', { ...card, allowOther: 0 })).status, 400);
    assert.equal((await decision(s, await newCard(s, { ...card, allowOther: true }))).allowOther, true);
  });
});

test('その他は open / terminal / hook 由来のカードには使えない(409)。allowOther はそれらで false', async () => {
  await withServer(async (s) => {
    const o = await newCard(s, { mode: 'open', header: 'h', question: 'URL は', options: [] });
    const t = await newCard(s, { mode: 'terminal', header: 'h', question: '承認', options: [] });
    assert.equal((await post(s, '/answer', { id: o, other: 'x' })).status, 409);
    assert.equal((await post(s, '/answer', { id: t, other: 'x' })).status, 409);
    assert.equal((await decision(s, o)).allowOther, false);
    assert.equal((await decision(s, t)).allowOther, false);
  });
});

test('遠隔(スマホ)は other 付きの /answer も 403。snapshot に入力文・allowOther を出さない', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const id = await newCard(s);
    const rp = s.remotePort();
    const rpost = (p, body) => raw(rp, p, { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify(body) });
    assert.equal((await rpost('/answer', { id, other: OTHER })).status, 403);
    assert.equal((await post(s, '/answer', { id, other: 'x' }, { ...J, Origin: 'http://evil.example' })).status, 403); // 他サイトからも
    assert.equal((await post(s, '/answer', { id, other: 'x' }, { ...J, Host: 'evil.example' })).status, 403);
    assert.equal((await decision(s, id)).pickedOther, false);
    // PC で答えたあとの遠隔 snapshot にも本文は出ない
    assert.equal((await post(s, '/answer', { id, other: OTHER })).status, 200);
    await next(s, 5);
    const res = await raw(rp, '/snapshot', { headers: { Cookie: `office_key=${TOKEN}` } });
    const text = res.status === 200 ? res.text : null;
    if (text !== null) assert.ok(!text.includes('案C') && !text.includes('別途相談'));
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${rp}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = sse.body.getReader();
    let buf = '';
    while (!buf.includes('\n\n')) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); }
    ac.abort();
    assert.ok(!buf.includes('案C') && !buf.includes('別途相談'), 'remote snapshot に入力文が出ない');
    const snap = JSON.parse(/^data: (.*)$/m.exec(buf)[1]);
    const d = snap.decisions.find((x) => x.id === id);
    assert.equal(d.status, 'answered');
    assert.deepEqual(d.options, []);
    assert.equal(d.other, undefined);
  });
});

test('SSE の通知イベントとサーバーの標準出力・標準エラーに入力文を出さない', async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  try {
    await withServer(async (s) => {
      const sse = await openSse(s);
      try {
        const id = await newCard(s);
        assert.equal((await post(s, '/answer', { id, other: OTHER })).status, 200);
        await next(s, 5);
        await sleep(100);
        assert.ok(!JSON.stringify(sse.events ?? []).includes('案C'));
      } finally { sse.close(); }
    });
  } finally { Object.assign(console, orig); }
  assert.ok(!logs.join('\n').includes('案C'));
});

test('tools/post-decision.mjs: その他で答えると「【判断への回答】…: その他: …」を出して終わる。allowOther を渡せる', async () => {
  await withServer(async (s) => {
    const run = runTool('post-decision.mjs', s.port, JSON.stringify(card));
    let id;
    for (let i = 0; i < 100 && !id; i++) { id = (await snapOf(s)).decisions.find((d) => d.source === 'office')?.id; if (!id) await sleep(50); }
    assert.ok(id, 'カードが出る');
    assert.equal((await post(s, '/answer', { id, other: OTHER })).status, 200);
    const r = await run;
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(`【判断への回答】選択先: その他: ${OTHER}`), r.out);
    assert.equal(r.err, '');
    const a = await runTool('post-decision.mjs', s.port, JSON.stringify({ ...card, allowOther: false }), ['--no-wait']);
    const id2 = /id=(d\d+)/.exec(a.out)[1];
    assert.equal((await decision(s, id2)).allowOther, false);
    assert.equal((await post(s, '/answer', { id: id2, other: 'x' })).status, 400);
  }, { treeRoot: dir });
});
