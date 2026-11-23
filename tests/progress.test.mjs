import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './helpers.mjs';
import { createState, applyEvent, snapshot } from '../lib/state.mjs';
import { toOfficeEvent, summarizeTodos } from '../lib/describe.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const roster = JSON.parse(fs.readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-progress-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const local = (s) => snapshot(s, Date.now(), { local: true });
const member = (s, id, opts = { local: true }) => snapshot(s, Date.now(), opts).members.find((m) => m.seat === id);

// Claude Code 本体の TodoWrite スキーマ: { todos: [{ content, status: pending|in_progress|completed, activeForm }] }(全件を毎回送る)
const todos = (...st) => st.map((status, i) => ({ content: `作業${i + 1}を行う`, status, activeForm: `作業${i + 1}を行っています` }));
const hook = (list, extra = {}) => toOfficeEvent({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: list }, ...extra }, 1);

test('hook: TodoWrite は kind:todo で、件数・完了数・進行中の見出しだけを送る(各項目の全文は送らない)', () => {
  const e = hook([{ content: '金額1,000,000円を確認する', status: 'completed', activeForm: '確認しています' }, { content: '資料を作る', status: 'in_progress', activeForm: '資料を作っています' }, { content: '報告', status: 'pending', activeForm: '報告しています' }]);
  assert.equal(e.kind, 'todo');
  assert.deepEqual([e.todoTotal, e.todoDone, e.todoCurrent], [3, 1, '資料を作っています']);
  assert.ok(!JSON.stringify(e).includes('1,000,000') && !JSON.stringify(e).includes('報告しています'));
  assert.equal(hook(todos('in_progress'), { agent_id: 'a1', agent_type: 'implementer' }).agentId, 'a1');
});

test('summarizeTodos: 見出しは activeForm 優先・40字まで。0件・不正は null、不正な項目は数えない', () => {
  assert.equal(summarizeTodos([{ content: '本文だけ', status: 'in_progress' }]).current, '本文だけ');
  assert.equal(summarizeTodos([{ content: 'x', status: 'in_progress', activeForm: 'あ'.repeat(60) }]).current.length, 40);
  assert.deepEqual(summarizeTodos([{ content: 'a', status: 'completed' }, { status: 'weird' }, null, 5, { content: 'b', status: 'pending' }]), { total: 2, done: 1, current: '' });
  for (const bad of [[], null, undefined, 'x', {}, [null], [{ status: 'x' }]]) assert.equal(summarizeTodos(bad), null, JSON.stringify(bad));
  assert.equal(hook([]).kind, 'tool'); // 使える項目が無ければふつうのツール呼び出し
  assert.equal(hook(undefined).kind, 'tool');
  assert.equal(hook('x').toolName, 'TodoWrite');
});

test('state: 部長の進捗% = 完了数 ÷ 全項目数。見出し・件数・更新時刻と、案件カードの pct も付く', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: '依頼', title: '作業' }));
  assert.equal(member(s, 'bucho').progress, null); // ToDo が無ければ % を出さない
  applyEvent(s, hook(todos('completed', 'in_progress', 'pending')));
  const p = member(s, 'bucho').progress;
  assert.deepEqual({ ...p, updatedAt: typeof p.updatedAt }, { pct: 33, done: 1, total: 3, current: '作業2を行っています', updatedAt: 'number' });
  assert.equal(local(s).board.find((c) => c.owner === '部長').pct, 33);
  applyEvent(s, hook(todos('completed', 'completed', 'completed')));
  assert.equal(member(s, 'bucho').progress.pct, 100);
  assert.equal(member(s, 'bucho').progress.current, '');
  assert.equal(local(s).counters.tools, 2); // ふつうの作業としても数える
});

test('state: サブエージェントは自分の席・カードだけに付き、部長とは区別される。完了で消える', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: '依頼', title: '作業' }));
  applyEvent(s, ev('delegate', { text: 'd', title: '実装する', targetType: 'implementer' }));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'implementer' }));
  applyEvent(s, hook(todos('completed', 'pending'), { agent_id: 'a1', agent_type: 'implementer' }));
  assert.equal(member(s, 'implementer').progress.pct, 50);
  assert.equal(member(s, 'bucho').progress, null);
  const cards = local(s).board;
  assert.equal(cards.find((c) => c.title === '実装する').pct, 50);
  assert.equal(cards.find((c) => c.owner === '部長').pct, undefined);
  applyEvent(s, hook(todos('in_progress'), {}));
  assert.equal(member(s, 'bucho').progress.pct, 0);
  applyEvent(s, ev('subagent_done', { agentId: 'a1', agentType: 'implementer', text: 'できました' }));
  assert.equal(member(s, 'implementer').progress, null);
  assert.equal(local(s).board.find((c) => c.title === '実装する').pct, undefined);
  assert.equal(member(s, 'bucho').progress.pct, 0); // 部長の分は残る
});

test('state: 委任の記録が無い担当も自分の席に付く。stop と新しい指示で消える、不正な数値で落ちない', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: '依頼', title: '作業' }));
  // 委任の記録が無い担当でも、動き出していれば自分の席に付く(部長には付かない)
  applyEvent(s, { ...hook(todos('completed')), agentId: 'ghost', agentType: 'implementer' });
  assert.equal(member(s, 'implementer').progress.pct, 100);
  assert.equal(member(s, 'bucho').progress, null);
  applyEvent(s, hook(todos('completed', 'pending')));
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  assert.equal(member(s, 'bucho').progress, null);
  assert.ok(local(s).board.every((c) => c.pct === undefined));
  applyEvent(s, ev('prompt', { text: '依頼', title: '作業' }));
  applyEvent(s, hook(todos('completed')));
  applyEvent(s, ev('prompt', { text: '次', title: '次' }));
  assert.equal(member(s, 'bucho').progress, null);
  for (const bad of [{ todoTotal: 0, todoDone: 0 }, { todoTotal: 'x', todoDone: 1 }, { todoTotal: 3, todoDone: 99 }, { todoTotal: 3, todoDone: -5 }, {}]) applyEvent(s, ev('todo', bad));
  assert.equal(member(s, 'bucho').progress.pct, 0); // -5 は 0 に、99 は 3 に丸める(最後の有効値)
});

test('遠隔(スマホ)の snapshot は pct だけ。進行中の見出し・件数は出さず、SSE のイベントにも見出しを載せない', async () => {
  const s = createState(roster);
  applyEvent(s, hook([{ content: '機密の内容', status: 'in_progress', activeForm: '金額1,234,567円を確認しています' }]));
  assert.deepEqual(member(s, 'bucho', { local: false }).progress, { pct: 0 });
  assert.ok(!JSON.stringify(snapshot(s)).includes('1,234,567'));
  assert.equal(member(s, 'bucho').progress.current, '金額1,234,567円を確認しています');

  const srv = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    assert.equal(await srv.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${srv.remotePort()}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = res.body.getReader();
    let buf = '';
    const dec = new TextDecoder();
    (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { /* abort */ } })();
    await new Promise((r) => setTimeout(r, 200));
    const e = hook([{ content: 'x', status: 'in_progress', activeForm: '金額1,234,567円を確認しています' }, { content: 'y', status: 'completed', activeForm: 'y' }]);
    await fetch(`http://127.0.0.1:${srv.port}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) });
    for (let i = 0; i < 50 && !buf.includes('"kind":"todo"'); i++) await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    assert.ok(buf.includes('"kind":"todo"') && buf.includes('"pct":50'));
    assert.ok(!buf.includes('1,234,567') && !buf.includes('確認しています'));
  } finally { await srv.close(); }
});
