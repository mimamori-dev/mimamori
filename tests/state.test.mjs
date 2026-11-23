import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, applyEvent, snapshot } from '../lib/state.mjs';

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const seat = (s, id) => snapshot(s).members.find((m) => m.seat === id);
const delegate = (type, title = '依頼') => ev('delegate', { text: `${type}に依頼します`, title, targetType: type });

test('seatOfAgent は担当の agentId から今座っている席を返し、不明なら null', async () => {
  const { seatOfAgent } = await import('../lib/state.mjs');
  const s = createState(roster);
  applyEvent(s, delegate('report-writer'));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'report-writer' }));
  assert.equal(seatOfAgent(s, 'a1'), 'report-writer');
  assert.equal(seatOfAgent(s, 'zzz'), null);
  assert.equal(seatOfAgent(s, null), null);
});

test('delegate -> start -> tool で専属席の吹き出しが更新される', () => {
  const s = createState(roster);
  applyEvent(s, delegate('report-writer'));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'report-writer', text: '作業を始めます' }));
  applyEvent(s, ev('tool', { agentId: 'a1', agentType: 'report-writer', text: 'X.xlsxを読んでいます' }));
  const m = seat(s, 'report-writer');
  assert.equal(m.bubble, 'X.xlsxを読んでいます');
  assert.equal(m.status, 'working');
  assert.equal(seat(s, 'bucho').bubble, '「レポート作成担当に依頼」');
  assert.equal(snapshot(s).counters.tools, 1);
});

test('同じ担当を2回依頼しても席は1つで、count が2になる', () => {
  const s = createState(roster);
  applyEvent(s, delegate('report-writer'));
  applyEvent(s, delegate('report-writer'));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'report-writer' }));
  applyEvent(s, ev('subagent_start', { agentId: 'a2', agentType: 'report-writer' }));
  applyEvent(s, ev('tool', { agentId: 'a2', agentType: 'report-writer', text: 'B.mdを書いています' }));
  const m = seat(s, 'report-writer');
  assert.equal(m.count, 2);
  assert.equal(m.role, 'レポート作成担当');
  assert.equal(m.bubble, 'B.mdを書いています');
  assert.equal(snapshot(s).members.filter((x) => x.status === 'working' && x.seat !== 'bucho').length, 1);
});

test('同じ席の2人: 片方が完了しても1人動いている間は working、両方完了で count 0', () => {
  const s = createState(roster);
  for (const id of ['a1', 'a2']) {
    applyEvent(s, delegate('implementer'));
    applyEvent(s, ev('subagent_start', { agentId: id, agentType: 'implementer' }));
  }
  assert.equal(seat(s, 'implementer').count, 2);
  applyEvent(s, ev('subagent_done', { agentId: 'a1', agentType: 'implementer', text: 'できました' }));
  assert.equal(seat(s, 'implementer').count, 1);
  assert.equal(seat(s, 'implementer').status, 'working');
  applyEvent(s, ev('subagent_done', { agentId: 'a2', agentType: 'implementer', text: 'できました' }));
  assert.equal(seat(s, 'implementer').count, 0);
  assert.equal(seat(s, 'implementer').status, 'done');
  assert.ok(snapshot(s).board.filter((c) => c.owner === '実装担当').every((c) => c.column === 'reviewing'));
});

test('名簿にない種類はユウくん(万能担当)の席で受け、役割名は万能担当のまま', () => {
  const s = createState(roster);
  applyEvent(s, delegate('mystery-agent'));
  applyEvent(s, ev('subagent_start', { agentId: 'u1', agentType: 'mystery-agent' }));
  const m = seat(s, 'general-purpose');
  assert.equal(m.nickname, 'ユウくん');
  assert.equal(m.role, '万能担当');
  assert.equal(m.status, 'working');
  assert.equal(m.count, 1);
  applyEvent(s, delegate('another-agent'));
  applyEvent(s, ev('subagent_start', { agentId: 'u2', agentType: 'another-agent' }));
  assert.equal(seat(s, 'general-purpose').count, 2);
  assert.doesNotThrow(() => applyEvent(s, ev('tool', { agentId: 'u3', agentType: 'x', text: 't' })));
});

test('応援席は存在せず、members は名簿の人数(部長+制作2+検証6+環境影響1+アクセス審査1+開発3+調査2+SNS1=17)で dept に support は出ない', () => {
  const sn = snapshot(createState(roster));
  assert.equal(roster.helperSeats, undefined);
  assert.equal(sn.members.length, roster.members.length);
  assert.equal(sn.members.length, 17);
  assert.ok(!sn.members.some((m) => m.seat.startsWith('helper-') || m.dept === 'support'));
  assert.ok(sn.members.every((m) => m.count === 0));
  const text = JSON.stringify(sn);
  for (const w of ['応援', 'ヘルプ', 'ハナさん']) assert.ok(!text.includes(w), w);
});

test('prompt -> delegate -> done -> stop で案件カードが両方 done', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: '月次報告' }));
  applyEvent(s, delegate('report-writer', '資料作成'));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'report-writer' }));
  applyEvent(s, ev('subagent_done', { agentId: 'a1', agentType: 'report-writer', text: 'できました' }));
  assert.equal(seat(s, 'report-writer').status, 'done');
  assert.equal(seat(s, 'report-writer').bubble, 'できました');
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  const snap = snapshot(s);
  assert.equal(snap.board.length, 2);
  assert.ok(snap.board.every((c) => c.column === 'done'));
  assert.equal(snap.counters.delegates, 1);
  assert.equal(seat(s, 'bucho').bubble, '『月次報告』の作業が終わりました。社長に報告します');
  assert.ok(snap.members.every((m) => m.status === 'idle'));
});

test('waiting は案件を待ちにし、次の tool で作業中に戻る', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: 'x' }));
  applyEvent(s, ev('waiting', { text: '社長の確認待ち' }));
  assert.equal(snapshot(s).board[0].column, 'waiting');
  assert.equal(seat(s, 'bucho').status, 'waiting');
  applyEvent(s, ev('tool', { text: 'ファイルを探しています' }));
  assert.equal(snapshot(s).board[0].column, 'working');
  assert.equal(seat(s, 'bucho').status, 'working');
});

test('600件の tool 後も log は500件', () => {
  const s = createState(roster);
  for (let i = 0; i < 600; i++) applyEvent(s, ev('tool', { text: `t${i}` }));
  const snap = snapshot(s);
  assert.equal(snap.log.length, 500);
  assert.equal(snap.log.at(-1).text, 't599');
});

test('snapshot は JSON でそのまま往復できる', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: 'x' }));
  applyEvent(s, delegate('general-purpose'));
  const snap = snapshot(s);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test('stop で作業中・待ちの案件がすべて done になる', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: 'p' }));
  applyEvent(s, delegate('report-writer'));
  applyEvent(s, delegate('video-producer'));
  applyEvent(s, ev('waiting', { text: '社長の確認待ち' }));
  applyEvent(s, ev('stop', { text: '社長に報告' })); // 担当は未着席(pending)なので保留せず完了
  assert.ok(snapshot(s).board.every((c) => c.column === 'done'));
});

test('新しい prompt で前の案件カードが done になる', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: '1' }));
  applyEvent(s, ev('prompt', { title: '2' }));
  assert.deepEqual(snapshot(s).board.map((c) => c.column), ['done', 'working']);
});

test('board は50枚まで。done から先に捨て、無ければ古い順', () => {
  const s = createState(roster);
  for (let i = 0; i < 60; i++) applyEvent(s, ev('prompt', { title: `p${i}` }));
  let b = snapshot(s).board;
  assert.equal(b.length, 50);
  assert.equal(b.at(-1).title, 'p59');
  assert.equal(b.at(-1).column, 'working');
  // 席数の上限で作業中カードは常に50枚未満なので、古い順の落とし方は done 側で確認する
  assert.equal(b[0].title, 'p10');
});

test('途中から開いても未知の agentId の tool が席とカードを得る', () => {
  const s = createState(roster);
  applyEvent(s, ev('tool', { agentId: 'z1', agentType: 'numbers-checker', text: 'A.xlsxを読んでいます' }));
  const snap = snapshot(s);
  assert.equal(seat(s, 'numbers-checker').bubble, 'A.xlsxを読んでいます');
  assert.equal(seat(s, 'numbers-checker').status, 'working');
  assert.equal(snap.board.length, 1);
  assert.equal(snap.board[0].column, 'working');
});

test('未知の agentId の subagent_done は何も変えない', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: 'x' }));
  const before = snapshot(s);
  assert.doesNotThrow(() => applyEvent(s, ev('subagent_done', { agentId: 'nope', agentType: 'report-writer', text: 'できました' })));
  assert.deepEqual(snapshot(s), before);
});

test('席に座れなかった agentId の tool は例外にならない', () => {
  const s = createState(roster);
  for (let i = 0; i < 6; i++) applyEvent(s, ev('subagent_start', { agentId: `g${i}`, agentType: 'general-purpose' }));
  assert.doesNotThrow(() => applyEvent(s, ev('tool', { agentId: 'g5', agentType: 'general-purpose', text: 'x' })));
  assert.equal(snapshot(s).counters.tools, 1);
});

const ask = (questions, o = {}) => ev('ask', { text: '社長のご判断待ち', questions, ...o });
const q = (question, extra = {}) => ({ question, header: 'h', options: [{ label: 'はい', description: 'd' }, { label: 'いいえ', description: '' }], multiSelect: false, ...extra });
const decisions = (s) => snapshot(s, Date.now(), { local: true }).decisions;

test('ask で decisions が pending になり、部長が確認待ち・カードが waiting・通知ログが1行増える', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: '依頼', title: '作業' }));
  const logBefore = snapshot(s).log.length;
  applyEvent(s, ask([q('一つ目の質問です'), q('二つ目')]));
  const d = decisions(s);
  assert.deepStrictEqual(d.map((x) => [x.id, x.status, x.question]), [['d1', 'pending', '一つ目の質問です'], ['d2', 'pending', '二つ目']]);
  assert.equal(d[0].header, 'h');
  assert.equal(d[0].options.length, 2);
  assert.equal(typeof d[0].askedAt, 'number');
  assert.equal(seat(s, 'bucho').status, 'waiting');
  assert.equal(seat(s, 'bucho').bubble, 'ご判断をお待ちしています');
  assert.equal(snapshot(s).board.find((c) => c.owner === '部長').column, 'waiting');
  const log = snapshot(s).log;
  assert.equal(log.length, logBefore + 1);
  assert.equal(log.at(-1).text, '社長のご判断待ち: 一つ目の質問です');
});

test('tool で answered に戻り、部長とカードは working に戻る', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: '依頼', title: '作業' }));
  applyEvent(s, ask([q('質問')]));
  applyEvent(s, ev('tool', { text: 'a.mdを読んでいます' }));
  assert.equal(decisions(s)[0].status, 'answered');
  assert.equal(seat(s, 'bucho').status, 'working');
  assert.equal(snapshot(s).board.find((c) => c.owner === '部長').column, 'working');
});

test('stop・prompt・session_start でも answered になる。decisions 自体は残る', () => {
  for (const kind of ['stop', 'prompt', 'session_start']) {
    const s = createState(roster);
    applyEvent(s, ask([q('質問')]));
    applyEvent(s, ev(kind, { text: 'x' }));
    assert.deepStrictEqual(decisions(s).map((x) => x.status), ['answered'], kind);
  }
});

test('サブエージェントのイベントでは answered にならず、サブエージェントの ask は無視される', () => {
  const s = createState(roster);
  applyEvent(s, delegate('report-writer'));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'report-writer' }));
  applyEvent(s, ask([q('サブの質問')], { agentId: 'a1', agentType: 'report-writer' }));
  assert.equal(decisions(s).length, 0);
  assert.notEqual(seat(s, 'bucho').status, 'waiting');
  applyEvent(s, ask([q('部長の質問')]));
  applyEvent(s, ev('tool', { agentId: 'a1', agentType: 'report-writer', text: 'x' }));
  assert.equal(decisions(s)[0].status, 'pending');
});

test('decisions は20件まで。古い answered から捨てる', () => {
  const s = createState(roster);
  for (let i = 0; i < 6; i++) applyEvent(s, ask([q(`a${i}`), q(`b${i}`), q(`c${i}`), q(`d${i}`)]));
  const d = decisions(s);
  assert.equal(d.length, 20);
  assert.ok(d.every((x) => x.status === 'pending')); // 全部 pending なら古い順に捨てる
  assert.equal(d[0].id, 'd5');
  applyEvent(s, ev('tool'));
  applyEvent(s, ask([q('new')]));
  const d2 = decisions(s);
  assert.equal(d2.length, 20);
  assert.equal(d2.at(-1).status, 'pending');
  assert.equal(d2.at(-1).id, 'd25');
  assert.equal(d2.filter((x) => x.status === 'pending').length, 1);
});

test('不正な ask は例外を出さず状態を変えない', () => {
  const s = createState(roster);
  const before = JSON.stringify(snapshot(s));
  for (const questions of [undefined, null, 'x', [], [null, 3, { question: 1 }], [{ question: '' }]]) applyEvent(s, ask(questions));
  assert.equal(JSON.stringify(snapshot(s)), before);
  applyEvent(s, ask([q('ok', { options: 'x', multiSelect: 'yes' })]));
  assert.deepStrictEqual(decisions(s)[0].options, []);
  assert.equal(decisions(s)[0].multiSelect, false);
});

test('snapshot の decisions は内部状態のコピー', () => {
  const s = createState(roster);
  applyEvent(s, ask([q('質問')]));
  snapshot(s, Date.now(), { local: true }).decisions[0].options[0].label = '改ざん';
  assert.equal(decisions(s)[0].options[0].label, 'はい');
});

test('instruction: 初期は null、prompt で working、stop で done(中身は残る)、session_start では不変', () => {
  const s = createState(roster);
  assert.equal(snapshot(s).instruction, null);
  applyEvent(s, ev('session_start', { text: '出社しました' }));
  assert.equal(snapshot(s).instruction, null);
  const p = ev('prompt', { text: 'x', title: 't', body: '資料を更新して' });
  applyEvent(s, p);
  assert.deepEqual(snapshot(s).instruction, { text: '資料を更新して', ts: p.ts, source: 'terminal', status: 'working' });
  applyEvent(s, ev('session_start', { text: '出社しました' }));
  assert.equal(snapshot(s).instruction.status, 'working');
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  assert.deepEqual(snapshot(s).instruction, { text: '資料を更新して', ts: p.ts, source: 'terminal', status: 'done' });
  const p2 = ev('prompt', { body: '次の指示', source: 'office' });
  applyEvent(s, p2);
  assert.deepEqual(snapshot(s).instruction, { text: '次の指示', ts: p2.ts, source: 'office', status: 'working' });
});

test('instruction: 300字に切り詰め、snapshot は内部の値を共有しない', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { body: 'あ'.repeat(500) }));
  assert.equal(snapshot(s).instruction.text.length, 300);
  snapshot(s).instruction.text = 'x';
  assert.equal(snapshot(s).instruction.text.length, 300);
});

test('instruction: 想定外の source は terminal、本文が文字列でなければ title で代用', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { source: 'evil', body: 9, title: '件名' }));
  assert.equal(snapshot(s).instruction.source, 'terminal');
  assert.equal(snapshot(s).instruction.text, '件名');
});

test('サブエージェントの prompt は instruction を変えない', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { body: '本物の指示' }));
  applyEvent(s, ev('prompt', { agentId: 'a1', agentType: 'implementer', body: '内部' }));
  assert.equal(snapshot(s).instruction.text, '本物の指示');
});

test('stop の吹き出しは直近の指示の先頭16字(超えたら…)。ログも同じ文', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { body: 'あ'.repeat(30) }));
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  const want = `『${'あ'.repeat(16)}…』の作業が終わりました。社長に報告します`;
  assert.equal(seat(s, 'bucho').bubble, want);
  assert.equal(snapshot(s).log.at(-1).text, want);
});

test('指示が無いまま stop なら従来の「社長に報告」', () => {
  const s = createState(roster);
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  assert.equal(seat(s, 'bucho').bubble, '社長に報告');
  assert.equal(snapshot(s).instruction, null);
});

test('instructions: 状態遷移(state 単体)', async () => {
  const { enqueueInstruction, markAssigningBubble } = await import('../lib/state.mjs');
  const s = createState(roster);
  const a = enqueueInstruction(s, 'A', 1);
  enqueueInstruction(s, 'B', 2);
  applyEvent(s, ev('prompt', { text: '社長から…', body: 'A', source: 'office', instrId: a }));
  assert.deepEqual(snapshot(s).instructions.map((i) => i.status), ['assigning', 'queued']);
  assert.equal(markAssigningBubble(s), true);
  assert.equal(seat(s, 'bucho').bubble, 'タスクを振っています');
  applyEvent(s, ev('tool', { text: 't' }));
  assert.equal(snapshot(s).instructions[0].status, 'working');
  assert.equal(markAssigningBubble(s), false);
  applyEvent(s, ev('stop', { text: '報告' }));
  assert.deepEqual(snapshot(s).instructions.map((i) => i.status), ['done', 'queued']);
  snapshot(s).instructions[0].status = 'x';
  assert.equal(snapshot(s).instructions[0].status, 'done');
});

test('各 agent_type が名簿どおりの席に座り、席ごとの nickname・role・dept を持つ', () => {
  const cases = [
    ['implementer', 'implementer', 'タクミくん', '実装担当', 'dev'],
    ['ui-builder', 'ui-builder', 'ミユさん', '画面・動き担当', 'dev'],
    ['qa-tester', 'qa-tester', 'ミルくん', '動作確認担当', 'dev'],
    ['claude-code-guide', 'researcher', 'リサさん', '調査担当', 'research'],
    ['web-fetch', 'researcher', 'リサさん', '調査担当', 'research'],
    ['Explore', 'researcher', 'リサさん', '調査担当', 'research'],
    ['Plan', 'researcher', 'リサさん', '調査担当', 'research'],
    ['general-purpose', 'general-purpose', 'ユウくん', '万能担当', 'research'],
    ['report-writer', 'report-writer', 'ミナトくん', 'レポート作成担当', '制作部'],
  ];
  for (const [type, id, nickname, role, dept] of cases) {
    const s = createState(roster);
    applyEvent(s, delegate(type));
    applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: type }));
    const m = seat(s, id);
    assert.equal(m.status, 'working', type);
    assert.equal(m.nickname, nickname, type);
    assert.equal(m.role, role, type);
    assert.equal(m.dept, dept, type);
  }
});

test('types の複数対応: 同じ席に別の種類が重なっても席は1つで count が増える', () => {
  const s = createState(roster);
  applyEvent(s, ev('subagent_start', { agentId: 'r1', agentType: 'Explore' }));
  applyEvent(s, ev('subagent_start', { agentId: 'r2', agentType: 'web-fetch' }));
  const m = seat(s, 'researcher');
  assert.equal(m.status, 'working');
  assert.equal(m.count, 2);
  assert.equal(m.role, '調査担当');
  applyEvent(s, ev('subagent_done', { agentId: 'r2', agentType: 'web-fetch', text: 'できました' }));
  assert.equal(seat(s, 'researcher').count, 1);
  applyEvent(s, ev('subagent_done', { agentId: 'r1', agentType: 'Explore', text: 'できました' }));
  applyEvent(s, ev('stop', { text: '報告' }));
  assert.equal(seat(s, 'researcher').count, 0);
  assert.equal(seat(s, 'researcher').status, 'idle');
});

test('名簿の呼び名は snapshot に出ない用語を含まない', () => {
  const sn = snapshot(createState(roster));
  assert.equal(sn.nicknames['実装担当'], 'タクミくん');
  assert.equal(sn.nicknames['レポート作成担当'], 'ミナトくん');
});

test('旧形式の roster(type のみ・helperSeats が数)でも動く(明示したときだけ応援席ができる)', () => {
  const old = { members: [{ type: 'bucho', name: '部長', dept: 'x' }, { type: 'a', name: 'A担当', nickname: 'Aくん', dept: 'x' }], helperSeats: 2 };
  const s = createState(old);
  applyEvent(s, delegate('a'));
  applyEvent(s, delegate('a'));
  const sn = snapshot(s);
  assert.equal(sn.members.find((m) => m.seat === 'a').nickname, 'Aくん');
  assert.equal(sn.members.filter((m) => m.seat.startsWith('helper-')).length, 2);
  assert.equal(sn.members.find((m) => m.seat === 'helper-1').role, 'A担当');
});

test('quota: 正常・片方欠け・不正値・期限切れ', () => {
  const s = createState(roster);
  assert.equal(snapshot(s).quota, null);
  const now = 2_000_000_000_000;
  const q = (o) => ev('quota', { ts: now - 5, ...o });
  applyEvent(s, q({ fiveHour: { pct: 42.6, resetsAt: now / 1000 + 3600 }, sevenDay: { pct: 10, resetsAt: now / 1000 + 86400 } }));
  assert.deepEqual(snapshot(s, now).quota, { fiveHour: { pct: 43, resetsAt: now / 1000 + 3600 }, sevenDay: { pct: 10, resetsAt: now / 1000 + 86400 }, updatedAt: now - 5 });
  // 片方だけ
  applyEvent(s, q({ fiveHour: { pct: 5, resetsAt: now / 1000 + 60 } }));
  assert.deepEqual(snapshot(s, now).quota.sevenDay, null);
  // 不正値: pct は丸め、数値以外の枠は捨て、resetsAt が数値でなければ null
  applyEvent(s, q({ fiveHour: { pct: 250, resetsAt: 'x' }, sevenDay: { pct: 'a', resetsAt: 1 } }));
  assert.deepEqual(snapshot(s, now).quota.fiveHour, { pct: 100, resetsAt: null });
  assert.equal(snapshot(s, now).quota.sevenDay, null);
  applyEvent(s, q({ fiveHour: { pct: -3, resetsAt: now / 1000 + 10 } }));
  assert.equal(snapshot(s, now).quota.fiveHour.pct, 0);
  // 期限切れ: 5時間枠だけ切れても週間枠は残り、両方切れれば null
  applyEvent(s, q({ fiveHour: { pct: 90, resetsAt: now / 1000 - 1 }, sevenDay: { pct: 30, resetsAt: now / 1000 + 100 } }));
  assert.equal(snapshot(s, now).quota.fiveHour, null);
  assert.equal(snapshot(s, now).quota.sevenDay.pct, 30);
  assert.equal(snapshot(s, now + 200_000).quota, null);
  applyEvent(s, q({}));
  assert.equal(snapshot(s, now).quota, null);
});

test('環境影響チェック部・アクセス審査部の2人が名簿・snapshot に出て、既定の席と色を持ち、レビュー中になる', () => {
  const want = [
    ['pc-impact-checker', 'ヒロトさん', '環境影響チェック部', '#8fd0c0'],
    ['access-auditor', 'サトルくん', 'アクセス審査部', '#e0b070'],
  ];
  for (const [type, nickname, dept, color] of want) {
    const m = roster.members.find((x) => x.type === type);
    assert.ok(m, type);
    assert.equal(m.nickname, nickname);
    assert.equal(m.dept, dept);
    assert.equal(m.color, color);
  }
  assert.equal(roster.members.filter((x) => x.dept === '検証部').length, 6);
  const s = createState(roster);
  assert.ok(snapshot(s).members.some((m) => m.seat === 'pc-impact-checker' && m.dept === '環境影響チェック部'));
  assert.ok(snapshot(s).members.some((m) => m.seat === 'access-auditor' && m.dept === 'アクセス審査部'));
  for (const type of ['pc-impact-checker', 'access-auditor']) {
    applyEvent(s, delegate(type, '確認'));
    applyEvent(s, ev('subagent_start', { agentId: `r-${type}`, agentType: type }));
    assert.equal(seat(s, type).status, 'working');
    assert.equal(seat(s, type).count, 1);
    assert.ok(snapshot(s).reviewing, `${type} reviewing`);
    applyEvent(s, ev('subagent_done', { agentId: `r-${type}`, agentType: type, text: 'できました' }));
  }
});
