import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer, raw, openSse, untilEffect } from './helpers.mjs';
import { sanitizeEvent, hasSecret, REDACTED } from '../lib/guard.mjs';
import { loadProjects, claudeDirName, transcriptInProject, projectsFromOrigin, DEFAULT_PROJECT } from '../lib/projects.mjs';
import { checkDeliverablePath } from '../lib/deliverables.mjs';
import { listTree } from '../lib/tree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const officeDir = path.join(here, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-proj-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const J = { 'Content-Type': 'application/json' };

// 2プロジェクトの一時環境: demo(rootK)・apps(rootA)・~/.claude/projects 相当(claude)
function setup() {
  const dir = fs.mkdtempSync(path.join(base, 't-'));
  const rootK = path.join(dir, 'demo-root');
  const rootA = path.join(dir, 'apps-root');
  const claude = path.join(dir, 'claude-projects');
  const pdir = path.join(dir, 'projects');
  for (const d of [rootK, rootA, claude]) fs.mkdirSync(d, { recursive: true });
  for (const id of ['demo', 'apps']) {
    fs.mkdirSync(path.join(pdir, id), { recursive: true });
    fs.copyFileSync(path.join(officeDir, 'projects', id, 'roster.json'), path.join(pdir, id, 'roster.json'));
    fs.writeFileSync(path.join(pdir, id, 'project.json'), JSON.stringify({ id, name: id === 'demo' ? 'サンプル' : 'アプリ作成', color: '#fff', root: id === 'demo' ? null : rootA }));
  }
  return { dir, rootK, rootA, claude, pdir };
}
async function withServer(fn, opts = {}) {
  const env = setup();
  const s = await startTestServer({ port: 0, allowedRoot: env.claude, treeRoot: env.rootK, projectsDir: env.pdir, deliverableGraceMs: 100, openMinIntervalMs: 0, opener: async () => true, ...opts });
  try { await fn(s, env); } finally { await s.close(); }
}
const post = (s, p, body) => raw(s.port, p, { method: 'POST', headers: J, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ev = (extra = {}) => ({ ts: Date.now(), kind: 'tool', agentId: null, agentType: null, text: 'Readを使っています', title: '', toolName: 'Read', toolArg: 'a.md', ...extra });
const snapOf = async (s, project) => {
  const sse = await (async () => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.port}/events${project ? `?project=${project}` : ''}`, { signal: ac.signal });
    return { res, ac };
  })();
  try {
    if (sse.res.status !== 200) return { status: sse.res.status };
    const reader = sse.res.body.getReader();
    let buf = '';
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  } finally { sse.ac.abort(); }
};
const toolCount = (snap) => snap.activity.filter((a) => a.kind === 'tool').length;

// ---- guard ----
test('guard: 許可リスト。未知の項目・source・instrId は落ち、許可外の kind は null', () => {
  const out = sanitizeEvent({ ts: 1, kind: 'tool', text: 'x', toolName: 'Read', evil: 'y', source: 'office', instrId: 'i1', cwd: 'C:/a', project: 'apps' });
  assert.deepEqual(out, { ts: 1, kind: 'tool', text: 'x', toolName: 'Read', cwd: 'C:/a', project: 'apps' });
  assert.equal(sanitizeEvent({ kind: 'inbox' }), null);
  assert.equal(sanitizeEvent({ kind: 'nope' }), null);
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent([]), null);
});

test('guard: .env・.dev.vars・KEY=・TOKEN=・SECRET・Bearer・秘密鍵は伏せ字、ふつうの文は残る', () => {
  for (const s of ['.env', 'C:\\a\\b\\.env', '.env.local', 'cat .env.production', '.dev.vars', 'x/.dev.vars.example', 'API_KEY=abc123', 'export GH_TOKEN=xyz', 'CLIENT_SECRET = s3cret', 'Authorization: Bearer abcdefgh12345678', '"api_key": "abc"', '-----BEGIN RSA PRIVATE KEY-----', 'ghp_' + 'a'.repeat(30)]) {
    assert.equal(hasSecret(s), true, s);
  }
  for (const s of ['environment.md を読んでいます', 'Readを使っています', '.envrc は別物', 'monkey business', 'token を数える機能を作る', 'キーを押す', 'a.md', 'コマンド実行: npm test']) {
    assert.equal(hasSecret(s), false, s);
  }
  const out = sanitizeEvent({ ts: 1, kind: 'tool', text: '.envを読んでいます', toolArg: '.env', body: 'DB_PASSWORD=hunter2', title: 'ok', questions: [{ question: 'TOKEN=abc を使う?', options: [{ label: 'はい' }] }] });
  assert.equal(out.text, REDACTED);
  assert.equal(out.toolArg, REDACTED);
  assert.equal(out.body, REDACTED);
  assert.equal(out.title, 'ok');
  assert.equal(out.questions[0].question, REDACTED);
  assert.equal(out.questions[0].options[0].label, 'はい');
});

// ---- projects.mjs ----
test('projects: 実際の projects/ は demo(従来の roster.json と同一・ルート未設定)と apps(部長1席・ルート未設定)', () => {
  const reg = loadProjects({ projectsDir: path.join(officeDir, 'projects'), legacyRosterPath: path.join(officeDir, 'roster.json'), defaultRoot: null });
  assert.ok(reg.has('demo') && reg.has('apps')); // 利用者が new-project で足した分があっても通る
  const legacy = JSON.parse(fs.readFileSync(path.join(officeDir, 'roster.json'), 'utf8'));
  assert.deepEqual(reg.get('demo').roster, legacy);
  assert.equal(fs.readFileSync(path.join(officeDir, 'projects', 'demo', 'roster.json'), 'utf8'), fs.readFileSync(path.join(officeDir, 'roster.json'), 'utf8'));
  assert.equal(reg.get('demo').root, null);
  assert.equal(reg.get('apps').root, null);
  assert.deepEqual(reg.get('apps').roster.members.map((m) => m.type), ['bucho']);
});

test('projects: projects/ が無ければ従来の roster.json から demo だけ作る(互換)', () => {
  const reg = loadProjects({ projectsDir: path.join(base, 'no-such-dir'), legacyRosterPath: path.join(officeDir, 'roster.json'), defaultRoot: base });
  assert.deepEqual([...reg.keys()], [DEFAULT_PROJECT]);
  assert.equal(reg.get('demo').roster.company, JSON.parse(fs.readFileSync(path.join(officeDir, 'roster.json'), 'utf8')).company);
});

test('projects: 壊れた1件・id とフォルダ名の不一致・不正な id は読まず、他は読む', () => {
  const env = setup();
  fs.mkdirSync(path.join(env.pdir, 'bad'));
  fs.writeFileSync(path.join(env.pdir, 'bad', 'project.json'), '{');
  fs.mkdirSync(path.join(env.pdir, 'Mismatch'));
  fs.mkdirSync(path.join(env.pdir, 'other'));
  fs.writeFileSync(path.join(env.pdir, 'other', 'project.json'), JSON.stringify({ id: 'zzz' }));
  fs.writeFileSync(path.join(env.pdir, 'other', 'roster.json'), JSON.stringify({ members: [] }));
  const reg = loadProjects({ projectsDir: env.pdir, legacyRosterPath: path.join(officeDir, 'roster.json'), defaultRoot: env.rootK });
  assert.ok(reg.has('demo') && reg.has('apps')); // 利用者が new-project で足した分があっても通る
});

test('projects: transcript のフォルダ名は、ルートの名前か、- に続くサブフォルダ名だけがそのプロジェクトのもの', () => {
  const root = path.join(base, 'a b', '日本');
  const name = claudeDirName(root);
  assert.match(name, /^[A-Za-z0-9-]+$/);
  const cl = path.join(base, 'cl');
  assert.equal(transcriptInProject(cl, root, path.join(cl, name, 's.jsonl')), true);
  assert.equal(transcriptInProject(cl, root, path.join(cl, name + '-sub', 's.jsonl')), true);
  assert.equal(transcriptInProject(cl, root, path.join(cl, name + 'x', 's.jsonl')), false);
  assert.equal(transcriptInProject(cl, root, path.join(cl, 'other', 's.jsonl')), false);
  assert.equal(transcriptInProject(cl, root, path.join(cl, '..', name, 's.jsonl')), false);
  assert.equal(transcriptInProject(cl, null, path.join(cl, name, 's.jsonl')), false);
});

test('projects: cwd と transcript_path から導く。別々のプロジェクトを指せば2件、不明は空', () => {
  const env = setup();
  const reg = loadProjects({ projectsDir: env.pdir, legacyRosterPath: path.join(officeDir, 'roster.json'), defaultRoot: env.rootK });
  const tr = (root) => path.join(env.claude, claudeDirName(root), 's.jsonl');
  assert.deepEqual(projectsFromOrigin(reg, env.claude, { cwd: path.join(env.rootA, 'sub') }), ['apps']);
  assert.deepEqual(projectsFromOrigin(reg, env.claude, { transcriptPath: tr(env.rootK) }), ['demo']);
  assert.deepEqual(projectsFromOrigin(reg, env.claude, { cwd: env.rootK, transcriptPath: tr(env.rootA) }).sort(), ['apps', 'demo']);
  assert.deepEqual(projectsFromOrigin(reg, env.claude, { cwd: path.join(env.dir, 'elsewhere') }), []);
  assert.deepEqual(projectsFromOrigin(reg, env.claude, {}), []);
});

// ---- 成果物パスの名指し拒否 ----
test('成果物パス: .env 系・.dev.vars 系・*.pem・*.key・secrets フォルダ・それらへのシンボリックリンクを拒否する', () => {
  const env = setup();
  const w = (rel, text = '{}') => { const f = path.join(env.rootA, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  w('ok.md', 'x');
  for (const rel of ['.env.json', '.env.local.md', '.dev.vars.json', '.dev.vars.example.md', 'a.pem', 'b.key', 'secrets/x.json', 'Secrets/y.md']) w(rel);
  assert.equal(checkDeliverablePath(env.rootA, 'ok.md').ok, true);
  for (const rel of ['.env.json', '.env.local.md', '.dev.vars.json', '.dev.vars.example.md', 'a.pem', 'b.key', 'secrets/x.json', 'Secrets/y.md']) {
    assert.equal(checkDeliverablePath(env.rootA, rel).ok, false, rel);
  }
  // 無害な名前のリンクから .env.json へ、プロジェクト外へ
  const outside = path.join(env.dir, 'outside.md');
  fs.writeFileSync(outside, 'x');
  let linked = false;
  try {
    fs.symlinkSync(path.join(env.rootA, '.env.json'), path.join(env.rootA, 'innocent.json'));
    fs.symlinkSync(outside, path.join(env.rootA, 'out.md'));
    linked = true;
  } catch { /* シンボリックリンクを作れない環境では省略 */ }
  if (linked) {
    assert.equal(checkDeliverablePath(env.rootA, 'innocent.json').ok, false);
    assert.equal(checkDeliverablePath(env.rootA, 'out.md').ok, false);
  }
  assert.equal(checkDeliverablePath(env.rootA, path.join(env.rootK, 'x.md')).ok, false);
});

test('ファイルツリー: .env 系・secrets・*.pem・*.key は一覧に出ない', () => {
  const env = setup();
  for (const rel of ['a.md', '.env', '.env.local', '.dev.vars', 'k.pem', 'k.key']) fs.writeFileSync(path.join(env.rootA, rel), 'x');
  fs.mkdirSync(path.join(env.rootA, 'secrets'));
  const names = listTree(env.rootA, '').body.entries.map((e) => e.name);
  assert.deepEqual(names, ['a.md']);
  assert.equal(listTree(env.rootA, 'secrets').status, 404);
});

// ---- サーバー ----
test('後方互換: project 省略のイベントは demo になり、/events の既定も demo。apps は変わらない', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/event', ev())).status, 204);
    const k = await snapOf(s);
    const k2 = await snapOf(s, 'demo');
    const a = await snapOf(s, 'apps');
    assert.equal(toolCount(k), 1);
    assert.equal(toolCount(k2), 1);
    assert.equal(toolCount(a), 0);
    assert.equal(k.members.length, JSON.parse(fs.readFileSync(path.join(officeDir, 'roster.json'), 'utf8')).members.length);
    assert.equal(a.members.length, 1);
  });
});

test('project 付きのイベントはそのプロジェクトだけに入る', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/event', ev({ project: 'apps' }))).status, 204);
    assert.equal((await post(s, '/event', ev({ project: 'apps' }))).status, 204);
    assert.equal(toolCount(await snapOf(s, 'apps')), 2);
    assert.equal(toolCount(await snapOf(s)), 0);
  });
});

test('未登録・型違いの project、許可外の kind は捨てる(404/404/400)', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/event', ev({ project: 'nope' }))).status, 404);
    assert.equal((await post(s, '/event', ev({ project: 7 }))).status, 404);
    assert.equal((await post(s, '/event', ev({ project: 'APPS' }))).status, 404);
    assert.equal((await post(s, '/event', ev({ kind: 'deliverable' }))).status, 400);
    assert.equal(toolCount(await snapOf(s)), 0);
    assert.equal(toolCount(await snapOf(s, 'apps')), 0);
    assert.equal((await snapOf(s, 'nope')).status, 404);
  });
});

test('宣言と cwd / transcript_path から導いたプロジェクトが食い違うイベントは捨てる(409)。一致・不明は通す', async () => {
  await withServer(async (s, env) => {
    // 宣言なし(=demo)なのに apps のフォルダから来た
    assert.equal((await post(s, '/event', ev({ cwd: path.join(env.rootA, 'x') }))).status, 409);
    // apps を名乗るが demo のフォルダから来た
    assert.equal((await post(s, '/event', ev({ project: 'apps', cwd: env.rootK }))).status, 409);
    // transcript の所属が違う
    assert.equal((await post(s, '/event', ev({ project: 'apps', transcriptPath: path.join(env.claude, claudeDirName(env.rootK), 's.jsonl') }))).status, 409);
    // cwd と transcript が互いに食い違う
    assert.equal((await post(s, '/event', ev({ project: 'apps', cwd: env.rootA, transcriptPath: path.join(env.claude, claudeDirName(env.rootK), 's.jsonl') }))).status, 409);
    assert.equal(toolCount(await snapOf(s)) + toolCount(await snapOf(s, 'apps')), 0);
    // 一致
    assert.equal((await post(s, '/event', ev({ project: 'apps', cwd: path.join(env.rootA, 'sub'), transcriptPath: path.join(env.claude, claudeDirName(env.rootA), 's.jsonl') }))).status, 204);
    assert.equal((await post(s, '/event', ev({ cwd: env.rootK }))).status, 204);
    // どのプロジェクトのルートでもない cwd は判別できないので通す
    assert.equal((await post(s, '/event', ev({ project: 'apps', cwd: path.join(env.dir, 'elsewhere') }))).status, 204);
    assert.equal(toolCount(await snapOf(s, 'apps')), 2);
    assert.equal(toolCount(await snapOf(s)), 1);
  });
});

test('認証情報らしい文字列は、画面の状態にも活動ログにも残らない。内部項目・未知の項目も入らない', async () => {
  await withServer(async (s) => {
    const secret = 'sk-' + 'Z'.repeat(30);
    await post(s, '/event', ev({ toolName: 'Read', toolArg: '.dev.vars', text: '.dev.varsを読んでいます' }));
    await post(s, '/event', ev({ toolName: 'Bash', toolArg: `export CF_API_TOKEN=${secret}`, text: `コマンド実行: export CF_API_TOKEN=${secret}` }));
    await post(s, '/event', { ts: Date.now(), kind: 'prompt', agentId: null, agentType: null, text: '依頼', title: 'DB_PASSWORD=hunter2', body: `Authorization: Bearer ${secret}`, source: 'office', instrId: 'i1', surprise: 'x' });
    const snap = await snapOf(s);
    const all = JSON.stringify(snap);
    for (const bad of ['.dev.vars', 'CF_API_TOKEN', secret, 'hunter2', 'surprise']) assert.equal(all.includes(bad), false, bad);
    assert.equal(all.includes(REDACTED), true);
    assert.equal(snap.instruction.source, 'terminal'); // source は外から名乗れない
  });
});

test('状態は別: 判断カード・指示キュー・成果物・使用量が他方に出ない。別プロジェクトの id は 404', async () => {
  await withServer(async (s, env) => {
    const card = { header: 'h', question: 'どちら?', options: [{ label: 'A' }, { label: 'B' }] };
    const r = await post(s, '/decision?project=apps', card);
    assert.equal(r.status, 201);
    const id = JSON.parse(r.text).id;
    assert.equal((await snapOf(s, 'apps')).decisions.length, 1);
    assert.equal((await snapOf(s)).decisions.length, 0);
    // demo の画面操作で apps のカード id は動かない
    assert.equal((await post(s, '/answer', { id, choice: 'A' })).status, 404);
    assert.equal((await post(s, '/decision-resolve', { id })).status, 404);
    assert.equal((await post(s, '/decision-resolve?project=nope', { id })).status, 404);
    // 指示キュー
    assert.equal((await post(s, '/instruction?project=apps', { text: 'アプリの指示' })).status, 202);
    assert.equal((await snapOf(s, 'apps')).inbox.pending, 1);
    assert.equal((await snapOf(s)).inbox.pending, 0);
    // 成果物: apps のルートのファイルは apps にだけ登録でき、id は他方で 404
    fs.writeFileSync(path.join(env.rootA, 'r.md'), 'x');
    fs.writeFileSync(path.join(env.rootK, 'k.md'), 'x');
    const d = await post(s, '/deliverable?project=apps', { title: '資料', path: 'r.md' });
    assert.equal(d.status, 201);
    const did = JSON.parse(d.text).id;
    assert.equal((await snapOf(s, 'apps')).deliverables.length, 1);
    assert.equal((await snapOf(s)).deliverables.length, 0);
    assert.equal((await post(s, '/deliverable-open', { id: did })).status, 404);
    assert.equal((await post(s, '/deliverable-approve', { id: did })).status, 404);
    assert.equal((await post(s, '/deliverable-open?project=apps', { id: did })).status, 204);
    // apps のルートから見て外(demo のファイル)は登録できない。demo 側は自分のルートだけ
    assert.equal((await post(s, '/deliverable?project=apps', { title: '資料', path: path.join(env.rootK, 'k.md') })).status, 400);
    assert.equal((await post(s, '/deliverable', { title: '資料', path: path.join(env.rootA, 'r.md') })).status, 400);
    assert.equal((await post(s, '/deliverable', { title: '資料', path: 'k.md' })).status, 201);
  });
});

test('成果物: .env 系などは登録できない。ルート未設定のプロジェクトは登録できない(固定文)', async () => {
  await withServer(async (s, env) => {
    for (const rel of ['.env.json', '.dev.vars.json', 'k.pem']) fs.writeFileSync(path.join(env.rootA, rel), '{}');
    for (const rel of ['.env.json', '.dev.vars.json', 'k.pem']) {
      const r = await post(s, '/deliverable?project=apps', { title: 't', path: rel });
      assert.equal(r.status, 400, rel);
      assert.equal(r.text.includes(rel), false);
    }
  });
  // ルート未設定
  const env = setup();
  fs.writeFileSync(path.join(env.pdir, 'apps', 'project.json'), JSON.stringify({ id: 'apps', name: 'アプリ作成', color: '#fff', root: null }));
  const s = await startTestServer({ port: 0, allowedRoot: env.claude, treeRoot: env.rootK, projectsDir: env.pdir });
  try {
    fs.writeFileSync(path.join(env.rootK, 'k.md'), 'x');
    const r = await post(s, '/deliverable?project=apps', { title: 't', path: path.join(env.rootK, 'k.md') });
    assert.equal(r.status, 400);
    assert.match(r.text, /未設定/);
    assert.equal((await raw(s.port, '/tree?project=apps')).status, 404);
    assert.equal((await raw(s.port, '/tree')).status, 200);
  } finally { await s.close(); }
});

test('transcript: apps は自分のフォルダのものだけ数える。demo は従来どおり allowedRoot 全体(narrowTranscripts で絞れる)', async () => {
  const line = (id, n) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5', usage: { input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n';
  const usageOf = async (s, project) => (await snapOf(s, project)).usage.tokens.total;
  const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  await withServer(async (s, env) => {
    const mine = path.join(env.claude, claudeDirName(env.rootA), 'a.jsonl');
    const other = path.join(env.claude, 'someone-else', 'b.jsonl');
    for (const f of [mine, other]) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
    fs.writeFileSync(mine, line('m1', 100));
    fs.writeFileSync(other, line('o1', 7000));
    await post(s, '/event', ev({ project: 'apps', transcriptPath: other }));
    await post(s, '/event', ev({ project: 'apps', transcriptPath: mine }));
    assert.equal(await until(async () => (await usageOf(s, 'apps')) === 100), true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await usageOf(s, 'apps'), 100);
    assert.equal(await usageOf(s), 0);
    // demo の既定は allowedRoot 全体(他の名前のフォルダでも数える = 現在の動作)
    await post(s, '/event', ev({ transcriptPath: other }));
    assert.equal(await until(async () => (await usageOf(s)) === 7000), true);
  });
  await withServer(async (s, env) => {
    const other = path.join(env.claude, 'someone-else', 'b.jsonl');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, line('o1', 7000));
    await post(s, '/event', ev({ transcriptPath: other }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await usageOf(s), 0); // narrow: demo も自分のフォルダだけ
    const mine = path.join(env.claude, claudeDirName(env.rootK), 'k.jsonl');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, line('k1', 50));
    await post(s, '/event', ev({ transcriptPath: mine }));
    assert.equal(await until(async () => (await usageOf(s)) === 50), true);
  }, { narrowTranscripts: true });
});

test('/projects は表示名と色だけを返し、ルートのパスを出さない。SSE は選んだ1つだけを配る', async () => {
  await withServer(async (s, env) => {
    const r = await raw(s.port, '/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).map((p) => p.id).sort(), ['apps', 'demo']);
    assert.equal(r.text.includes(env.rootA), false);
    const sseA = await (async () => { const ac = new AbortController(); const res = await fetch(`http://127.0.0.1:${s.port}/events?project=apps`, { signal: ac.signal }); return { res, ac, reader: res.body.getReader() }; })();
    const sseK = await openSse(s);
    try {
      await sseA.reader.read(); // 最初の snapshot
      await post(s, '/event', ev());
      await sseK.office((d) => d.event.kind === 'tool'); // demo の購読には届く
      const got = await Promise.race([sseA.reader.read(), new Promise((r2) => setTimeout(() => r2('none'), 400))]);
      assert.equal(got, 'none'); // apps の購読には届かない
    } finally { sseA.ac.abort(); sseK.close(); }
  });
});

test('apps の名簿にない担当(general-purpose)が来ても落ちず、他方に漏れない', async () => {
  await withServer(async (s) => {
    const r1 = await post(s, '/event', ev({ project: 'apps', kind: 'delegate', text: 'general-purposeに依頼します', title: '調査', targetType: 'general-purpose' }));
    const r2 = await post(s, '/event', ev({ project: 'apps', kind: 'subagent_start', agentId: 'ag1', agentType: 'general-purpose', text: '作業を始めます' }));
    assert.equal(r1.status, 204);
    assert.equal(r2.status, 204);
    const a = await snapOf(s, 'apps');
    assert.equal(a.members.length >= 1, true);
    assert.equal((await snapOf(s)).members.some((m) => m.seat === 'general-purpose' && m.status !== 'idle'), false);
  });
});

// ---- hook ----
function runHook(args, stdin, port) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(officeDir, 'office-hook.mjs'), ...args], { env: { ...process.env, OFFICE_PORT: String(port), OFFICE_NO_BROWSER: '1' }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    p.on('close', (code) => resolve(code));
    p.stdin.end(stdin);
  });
}

test('hook: --project を宣言し、cwd を足して送る。省略時は project を送らない(従来どおり demo)。認証情報は送る前に伏せる', async () => {
  await withServer(async (s, env) => {
    const input = (extra) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/x/a.md' }, ...extra });
    assert.equal(await runHook(['--project', 'apps'], input({ cwd: env.rootA }), s.port), 0);
    await untilEffect(async () => runHook(['--project', 'apps'], input({ cwd: env.rootA }), s.port), async () => toolCount(await snapOf(s, 'apps')) >= 1);
    assert.equal(toolCount(await snapOf(s)), 0);
    // apps のフォルダから来たのに宣言がない(=demo)イベントは、サーバーが捨てる
    await runHook([], input({ cwd: env.rootA }), s.port);
    // 宣言なし・cwd が demo → demo
    await untilEffect(async () => runHook([], input({ cwd: env.rootK }), s.port), async () => toolCount(await snapOf(s)) >= 1);
    const secretInput = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/x/.dev.vars' }, cwd: env.rootK });
    await untilEffect(async () => runHook([], secretInput, s.port), async () => JSON.stringify(await snapOf(s)).includes(REDACTED));
    assert.equal(JSON.stringify(await snapOf(s)).includes('.dev.vars'), false);
  });
});
