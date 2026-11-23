import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw, openSse } from './helpers.mjs';
import { saveSns, loadSns } from '../lib/sns-store.mjs';
import { resolveTerminalDecisions, createState, addOfficeDecision } from '../lib/state.mjs';
import { SNS_POSTED_GRACE_MS } from '../office-server.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-autoclose-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(path.join(root, 'SNS'), { recursive: true });
fs.writeFileSync(path.join(root, 'SNS', 'a.png'), 'x');
const J = { 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const newFile = () => path.join(base, `q${n++}`, 'sns-queue.json');
const post = (s, p, body) => raw(s.port, p, { method: 'POST', headers: J, body: JSON.stringify(body) });
const snapOf = async (s) => { const sse = await openSse(s); try { return await sse.snapshot(); } finally { sse.close(); } };
async function snapOfProject(s, project) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.port}/events?project=${project}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  } finally { ac.abort(); }
}
async function withServer(fn, opts = {}) {
  const s = await startTestServer({ port: 0, allowedRoot: base, treeRoot: root, openMinIntervalMs: 0, opener: async () => true, snsFile: newFile(), ...opts });
  try { await fn(s); } finally { await s.close(); }
}
const regSns = async (s) => JSON.parse((await post(s, '/deliverable', { title: 'SNS素材', path: path.join(root, 'SNS', 'a.png'), sns: true })).text).id;

// ---- 依頼A: 投稿済みの自動削除 ----
test('猶予の既定は3分で、スナップショットに猶予(snsGraceMs)が載る', async () => {
  assert.equal(SNS_POSTED_GRACE_MS, 180000);
  await withServer(async (s) => { assert.equal((await snapOf(s)).snsGraceMs, 180000); });
});

test('投稿済みにして猶予が過ぎるとカードが消え、sns-queue.json からも消える', async () => {
  const f = newFile();
  await withServer(async (s) => {
    const id = await regSns(s);
    await post(s, '/deliverable-posted', { id });
    assert.ok((await snapOf(s)).deliverables.some((d) => d.id === id));
    assert.equal(loadSns(f, 'demo').length, 1);
    await sleep(500);
    assert.equal((await snapOf(s)).deliverables.length, 0);
    assert.equal(loadSns(f, 'demo').length, 0);
  }, { snsFile: f, snsPostedGraceMs: 300 });
});

test('猶予内に未投稿へ戻すと削除予約が取り消され、カードは残る。再度投稿済みにすると数え直す', async () => {
  const f = newFile();
  await withServer(async (s) => {
    const id = await regSns(s);
    await post(s, '/deliverable-posted', { id });
    await sleep(100);
    await post(s, '/deliverable-unposted', { id });
    await sleep(500);
    const d = (await snapOf(s)).deliverables.find((x) => x.id === id);
    assert.ok(d);
    assert.equal(d.posted, false);
    assert.equal(loadSns(f, 'demo').length, 1);
    await post(s, '/deliverable-posted', { id });
    await sleep(150);
    assert.ok((await snapOf(s)).deliverables.some((x) => x.id === id));
    await sleep(500);
    assert.equal((await snapOf(s)).deliverables.length, 0);
  }, { snsFile: f, snsPostedGraceMs: 400 });
});

test('再起動: 猶予を過ぎた投稿済みは起動時に消え、猶予内のものは残って残り時間で消える。未投稿は消えない', async () => {
  const f = newFile();
  const p = path.join(root, 'SNS', 'a.png');
  const t = Date.now();
  const item = (id, o) => ({ id, title: id, path: p, fileName: 'a.png', kind: 'image', note: '', postText: '', createdAt: t, posted: false, postedAt: null, ...o });
  saveSns(f, 'demo', [item('v1', { posted: true, postedAt: t - 10_000 }), item('v2', { posted: true, postedAt: t - 100 }), item('v3', {})]);
  await withServer(async (s) => {
    const ids = (await snapOf(s)).deliverables.map((d) => d.id).sort();
    assert.deepEqual(ids, ['v2', 'v3']);
    assert.deepEqual(loadSns(f, 'demo').map((d) => d.id).sort(), ['v2', 'v3']);
    await sleep(1100);
    assert.deepEqual((await snapOf(s)).deliverables.map((d) => d.id), ['v3']);
  }, { snsFile: f, snsPostedGraceMs: 1000 });
});

// ---- 依頼B: terminal カードの自動クローズ ----
const term = { mode: 'terminal', header: '承認', question: 'push してよいですか', options: [{ label: '許可' }, { label: '見送り' }] };
const openC = { mode: 'open', header: '資料', question: 'URLを教えて' };
const choice = { header: '選択', question: 'どれ?', options: [{ label: 'A' }, { label: 'B' }] };
const mkCard = async (s, c, project) => { const r = await post(s, `/decision${project ? `?project=${project}` : ''}`, c); assert.equal(r.status, 201, r.text); return JSON.parse(r.text).id; };
const evt = (extra = {}) => ({ ts: Date.now(), kind: 'prompt', agentId: null, agentType: null, text: '社長から指示', title: 'こんにちは', body: 'こんにちは', ...extra });
const cardOf = async (s, id) => (await snapOf(s)).decisions.find((d) => d.id === id);

test('prompt(UserPromptSubmit)で terminal カードだけ閉じ、印(closedByTerminal)が付く。choice / open は閉じない', async () => {
  await withServer(async (s) => {
    const t1 = await mkCard(s, term);
    const t2 = await mkCard(s, term);
    const o = await mkCard(s, openC);
    const c = await mkCard(s, choice);
    assert.equal((await post(s, '/event', evt())).status, 204);
    const sn = await snapOf(s);
    for (const id of [t1, t2]) { const d = sn.decisions.find((x) => x.id === id); assert.equal(d.status, 'answered'); assert.equal(d.closedByTerminal, true); }
    assert.equal(sn.decisions.find((x) => x.id === o).status, 'pending');
    assert.equal(sn.decisions.find((x) => x.id === c).status, 'pending');
  });
});

test('prompt 以外のイベントでは閉じない(tool・stop・subagent_start・session_start)', async () => {
  await withServer(async (s) => {
    const t = await mkCard(s, term);
    for (const k of [{ kind: 'tool', toolName: 'Read', toolArg: 'a' }, { kind: 'stop' }, { kind: 'subagent_start', agentId: 'a1', agentType: 'implementer' }, { kind: 'session_start' }]) {
      await post(s, '/event', evt({ ...k, text: 'x', body: undefined, title: '' }));
    }
    assert.equal((await cardOf(s, t)).status, 'pending');
  });
});

test('担当(agentId あり)の prompt や、通知(<task-notification>)の文では閉じない', async () => {
  await withServer(async (s) => {
    const t = await mkCard(s, term);
    await post(s, '/event', evt({ agentId: 'a1', agentType: 'implementer' }));
    await post(s, '/event', evt({ body: '<task-notification><task-id>x</task-id></task-notification>', title: '<task-notification>' }));
    assert.equal((await cardOf(s, t)).status, 'pending');
  });
});

test('画面経由の指示(/instruction)では terminal カードは閉じない(従来どおり)', async () => {
  await withServer(async (s) => {
    const t = await mkCard(s, term);
    assert.equal((await post(s, '/instruction', { text: '画面からの指示' })).status, 202);
    assert.equal((await cardOf(s, t)).status, 'pending');
  });
});

test('他のプロジェクトのカードは閉じない。手動の /decision-resolve(--resolve)も従来どおり', async () => {
  await withServer(async (s) => {
    const k = await mkCard(s, term);
    const a = await mkCard(s, term, 'apps');
    assert.equal((await post(s, '/event', evt({ project: 'apps' }))).status, 204);
    assert.equal((await cardOf(s, k)).status, 'pending');
    assert.equal((await snapOfProject(s, 'apps')).decisions.find((d) => d.id === a).status, 'answered');
    assert.equal((await post(s, '/decision-resolve', { id: k })).status, 204);
    assert.equal((await cardOf(s, k)).status, 'answered');
  });
});

test('resolveTerminalDecisions: office 由来の terminal の pending だけ。hook 由来・choice は対象外', () => {
  const roster = JSON.parse(fs.readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
  const st = createState(roster);
  const a = addOfficeDecision(st, term, 1);
  const b = addOfficeDecision(st, choice, 2);
  st.decisions.push({ id: 'h1', source: 'hook', mode: 'terminal', status: 'pending', options: [] });
  assert.equal(resolveTerminalDecisions(st), 1);
  assert.equal(st.decisions.find((d) => d.id === a).status, 'answered');
  assert.equal(st.decisions.find((d) => d.id === b).status, 'pending');
  assert.equal(st.decisions.find((d) => d.id === 'h1').status, 'pending');
  assert.equal(resolveTerminalDecisions(st), 0);
});
