import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw, openSse } from './helpers.mjs';
import { loadSns, saveSns } from '../lib/sns-store.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sns-'));
const root = path.join(base, 'root');
after(() => fs.rmSync(base, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';
const J = { 'Content-Type': 'application/json' };
const mk = (rel) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
mk('SNS/成果物/画像.png');
mk('SNS/成果物/動画.mp4');
mk('.env');
mk('.env.json');
let n = 0;
const newFile = () => path.join(base, `q${n++}`, 'data', 'sns-queue.json');

async function withServer(fn, opts = {}) {
  const snsFile = opts.snsFile ?? newFile();
  const s = await startTestServer({ port: 0, allowedRoot: base, treeRoot: root, deliverableGraceMs: 100, openMinIntervalMs: 0, opener: async () => true, snsFile, ...opts });
  try { await fn(s, snsFile); } finally { await s.close(); }
}
const post = (s, p, body) => raw(s.port, p, { method: 'POST', headers: J, body: JSON.stringify(body) });
const reg = (s, rel, o = {}) => post(s, '/deliverable', { title: 'SNS素材', path: path.join(root, rel), ...o });
const snapOf = async (s) => { const sse = await openSse(s); try { return await sse.snapshot(); } finally { sse.close(); } };

test('登録: sns:true と category:"sns" で SNS用になり、省略時は従来どおり。投稿文は保存される', async () => {
  await withServer(async (s) => {
    const a = await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: '今日の一枚です\n#sample' });
    assert.equal(a.status, 201, a.text);
    assert.equal((await reg(s, 'SNS/成果物/動画.mp4', { category: 'sns' })).status, 201);
    assert.equal((await reg(s, 'SNS/成果物/動画.mp4')).status, 201);
    const sn = await snapOf(s);
    const [d1, d2, d3] = sn.deliverables;
    assert.deepEqual([d1.sns, d2.sns, d3.sns], [true, true, false]);
    assert.equal(d1.postText, '今日の一枚です\n#sample');
    assert.equal(d1.posted, false);
    assert.equal(d3.postText, '');
    assert.deepEqual(sn.snsCounts, { pending: 2, posted: 0 });
  });
});

test('投稿文の上限: 300字ちょうどは通り、301字・文字列以外・SNS用でない登録は 400', async () => {
  await withServer(async (s) => {
    assert.equal((await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: 'あ'.repeat(300) })).status, 201);
    assert.equal((await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: 'あ'.repeat(301) })).status, 400);
    assert.equal((await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: 123 })).status, 400);
    assert.equal((await reg(s, 'SNS/成果物/画像.png', { sns: 'yes', postText: 'a' })).status, 400);
    assert.equal((await reg(s, 'SNS/成果物/画像.png', { postText: 'sns:true が無い' })).status, 400);
    assert.equal((await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: 'a\u0000b' })).status, 400);
    assert.equal((await snapOf(s)).deliverables.length, 1);
  });
});

test('パス検証はSNS用でも同じ: プロジェクトの外・.env系・実行ファイルは拒否', async () => {
  await withServer(async (s) => {
    for (const p of [path.join(base, 'outside.png'), path.join(root, '.env'), path.join(root, '.env.json')]) {
      const r = await post(s, '/deliverable', { title: 't', path: p, sns: true, postText: 'x' });
      assert.equal(r.status, 400, p);
    }
    assert.equal((await snapOf(s)).deliverables.length, 0);
  });
});

test('状態切替: 投稿済みにする → 日時が付く、未投稿に戻す → 消える。承認とは独立。SNS用でないものは 409、存在しない id は 404', async () => {
  await withServer(async (s) => {
    const id = JSON.parse((await reg(s, 'SNS/成果物/画像.png', { sns: true })).text).id;
    const plain = JSON.parse((await reg(s, 'SNS/成果物/動画.mp4')).text).id;
    assert.equal((await post(s, '/deliverable-posted', { id })).status, 204);
    let d = (await snapOf(s)).deliverables.find((x) => x.id === id);
    assert.equal(d.posted, true);
    assert.ok(Number.isFinite(d.postedAt));
    assert.equal(d.status, 'new'); // 承認の状態は変わらない
    // 承認フローも従来どおり動く
    assert.equal((await post(s, '/deliverable-approve', { id })).status, 200);
    await new Promise((r) => setTimeout(r, 250));
    d = (await snapOf(s)).deliverables.find((x) => x.id === id);
    assert.equal(d.status, 'approved');
    assert.equal(d.posted, true);
    assert.equal((await post(s, '/deliverable-unposted', { id })).status, 204);
    d = (await snapOf(s)).deliverables.find((x) => x.id === id);
    assert.deepEqual([d.posted, d.postedAt], [false, null]);
    assert.equal((await post(s, '/deliverable-posted', { id: plain })).status, 409);
    assert.equal((await post(s, '/deliverable-posted', { id: 'v999' })).status, 404);
    assert.equal((await post(s, '/deliverable-posted', {})).status, 400);
    // SNS用は「見た(消す)」で消せない(投稿の記録を誤って失わない)
    assert.equal((await post(s, '/deliverable-dismiss', { id })).status, 409);
  });
});

test('永続化: 再起動しても SNS用だけが残り、投稿済み・投稿文・日時が戻る。通常の成果物は消える。ファイルにパス以外の余計な情報を入れない', async () => {
  const snsFile = newFile();
  let postedAt;
  await withServer(async (s) => {
    const id = JSON.parse((await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: '本文' })).text).id;
    await reg(s, 'SNS/成果物/動画.mp4', { sns: true });
    await reg(s, 'SNS/成果物/動画.mp4'); // 通常
    await post(s, '/deliverable-posted', { id });
    postedAt = (await snapOf(s)).deliverables.find((x) => x.id === id).postedAt;
  }, { snsFile });
  const saved = JSON.parse(fs.readFileSync(snsFile, 'utf8'));
  assert.equal(saved.projects.demo.length, 2);
  assert.deepEqual(Object.keys(saved.projects.demo[0]).sort(), ['createdAt', 'fileName', 'id', 'kind', 'note', 'path', 'postText', 'posted', 'postedAt', 'title']);
  await withServer(async (s) => {
    const sn = await snapOf(s);
    assert.equal(sn.deliverables.length, 2);
    const d = sn.deliverables.find((x) => x.posted);
    assert.equal(d.postText, '本文');
    assert.equal(d.postedAt, postedAt);
    assert.equal(d.status, 'new');
    assert.deepEqual(sn.snsCounts, { pending: 1, posted: 1 });
    assert.equal(sn.snsError, null);
    // 続けて登録しても id が衝突しない
    const r = await reg(s, 'SNS/成果物/画像.png', { sns: true });
    assert.equal(r.status, 201);
    assert.equal(new Set((await snapOf(s)).deliverables.map((x) => x.id)).size, 3);
  }, { snsFile });
});

test('保存・読み込みの失敗は画面に分かる形(snsError)で出て、サーバーは落ちない', async () => {
  // 読み込み失敗: 壊れた JSON
  const bad = newFile();
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{壊れた');
  await withServer(async (s) => {
    const sn = await snapOf(s);
    assert.match(sn.snsError, /読み込めません/);
    assert.equal(sn.deliverables.length, 0);
  }, { snsFile: bad });
  // 書き込み失敗: 保存先の場所がファイルで塞がれている
  const blocked = path.join(base, 'blocked');
  fs.writeFileSync(blocked, 'file');
  await withServer(async (s) => {
    const r = await reg(s, 'SNS/成果物/画像.png', { sns: true });
    assert.equal(r.status, 201);
    assert.match((await snapOf(s)).snsError, /保存できません/);
    assert.ok(await snapOf(s)); // 生きている
  }, { snsFile: path.join(blocked, 'x', 'sns-queue.json') });
});

test('プロジェクトごとに分けて保存する(別のプロジェクトの分を上書きしない)', () => {
  const f = newFile();
  saveSns(f, 'demo', [{ id: 'v1', title: 'a', path: '/p/a.png', posted: true, postedAt: 5 }]);
  saveSns(f, 'apps', [{ id: 'v1', title: 'b', path: '/p/b.png', posted: false }]);
  assert.equal(loadSns(f, 'demo')[0].title, 'a');
  assert.equal(loadSns(f, 'apps')[0].title, 'b');
  saveSns(f, 'demo', []);
  assert.equal(loadSns(f, 'demo').length, 0);
  assert.equal(loadSns(f, 'apps').length, 1);
  assert.deepEqual(loadSns(path.join(base, 'none.json'), 'demo'), []);
});

test('遠隔(スマホ): 投稿済み操作は 403、snapshot は件数だけで題・投稿文・パスを出さない', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const id = JSON.parse((await reg(s, 'SNS/成果物/画像.png', { sns: true, postText: '秘密の下書き', title: '秘密の題' })).text).id;
    const rp = s.remotePort();
    for (const p of ['/deliverable-posted', '/deliverable-unposted']) {
      assert.equal((await raw(rp, p, { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify({ id }) })).status, 403, p);
    }
    assert.equal((await snapOf(s)).deliverables[0].posted, false);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${rp}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let m;
    while (!(m = /event: snapshot\ndata: (.*)\n\n/.exec(buf))) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
    ac.abort();
    const r = { text: m[1] };
    const j = JSON.parse(r.text);
    assert.deepEqual(j.snsCounts, { pending: 1, posted: 0 });
    assert.equal(j.deliverables, undefined);
    assert.ok(!r.text.includes('秘密'));
    assert.ok(!r.text.includes('画像.png'));
  });
});

test('消す: new は通常のみ・SNS用の未投稿は 409。差し戻し済みは通常もSNS用も消せ、承認済み・猶予中は 409。SNS用を消すと sns-queue.json からも消える。遠隔は 403', async () => {
  await withServer(async (s, snsFile) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const idOf = async (o) => JSON.parse((await reg(s, 'SNS/成果物/画像.png', o)).text).id;
    const st = async (id) => (await snapOf(s)).deliverables.find((x) => x.id === id)?.status;
    const sns1 = await idOf({ sns: true }); // 差し戻す
    const sns2 = await idOf({ sns: true }); // 承認する
    const sns3 = await idOf({ sns: true }); // 未投稿のまま
    const pl1 = await idOf({}); // 通常: 差し戻す
    const pl2 = await idOf({}); // 通常: 未確認のまま
    assert.equal((await post(s, '/deliverable-dismiss', { id: sns3 })).status, 409);
    await post(s, '/deliverable-reject', { id: sns1 });
    await post(s, '/deliverable-approve', { id: sns2 });
    await post(s, '/deliverable-reject', { id: pl1 });
    assert.equal((await post(s, '/deliverable-dismiss', { id: sns1 })).status, 409); // 猶予中
    await sleep(250);
    assert.deepEqual([await st(sns1), await st(sns2), await st(pl1)], ['rejected', 'approved', 'rejected']);
    assert.equal((await snapOf(s)).snsCounts.pending, 2); // 差し戻し済みは未投稿に数えない
    assert.equal((await post(s, '/deliverable-dismiss', { id: sns2 })).status, 409); // 承認済み
    assert.equal(JSON.parse(fs.readFileSync(snsFile, 'utf8')).projects.demo.length, 3);
    assert.equal((await post(s, '/deliverable-dismiss', { id: sns1 })).status, 204);
    assert.equal((await post(s, '/deliverable-dismiss', { id: pl1 })).status, 204);
    assert.equal((await post(s, '/deliverable-dismiss', { id: pl2 })).status, 204);
    await sleep(250);
    const ids = (await snapOf(s)).deliverables.map((x) => x.id);
    assert.deepEqual(ids.sort(), [sns2, sns3].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(snsFile, 'utf8')).projects.demo.map((x) => x.id).sort(), [sns2, sns3].sort());
  });
});

test('消す: 差し戻し済みの「消す」は猶予中に取り消すと差し戻し済みに戻る。遠隔は 403', async () => {
  await withServer(async (s) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const id = JSON.parse((await reg(s, 'SNS/成果物/画像.png', { sns: true })).text).id;
    await post(s, '/deliverable-reject', { id });
    await sleep(250);
    assert.equal((await post(s, '/deliverable-dismiss', { id })).status, 204);
    assert.equal((await post(s, '/deliverable-undo', { id })).status, 204);
    await sleep(250);
    assert.equal((await snapOf(s)).deliverables.find((x) => x.id === id).status, 'rejected');
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const r = await raw(s.remotePort(), '/deliverable-dismiss', { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify({ id }) });
    assert.equal(r.status, 403);
  });
});
