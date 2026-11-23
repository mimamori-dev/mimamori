import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer, raw, openSse } from './helpers.mjs';
import { checkDeliverablePath, ALLOWED_EXT } from '../lib/deliverables.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-deliv-'));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
after(() => fs.rmSync(base, { recursive: true, force: true }));
const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';
const J = { 'Content-Type': 'application/json' };
const GRACE = 200;

const mk = (rel, content = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
mk('成果物/月次報告.mp4');
mk('成果物/資料.pptx');
mk('成果物/表.xlsx');
mk('成果物/メモ.txt');
mk('成果物/page.html');
mk('成果物/写真.PNG');
mk('成果物/run.exe');
mk('成果物/run.bat');
mk('成果物/x.ps1');
mk('成果物/x.js');
mk('成果物/x.lnk');
mk('成果物/noext');
mk('成果物/report.pdf.exe');
mk('.git/config.txt');
mk('node_modules/p/readme.md');
mk('成果物/dir.txt/inner.txt');
let linked = false;
try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); linked = true; } catch { /* 権限が無い環境ではスキップ */ }

async function withServer(fn, opts = {}) {
  const opened = [];
  const s = await startTestServer({ port: 0, allowedRoot: base, treeRoot: root, deliverableGraceMs: GRACE, openMinIntervalMs: 0, opener: async (p) => { opened.push(p); return true; }, ...opts });
  try { await fn(s, opened); } finally { await s.close(); }
}
const post = (s, p, body, headers = J) => raw(s.port, p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const reg = async (s, rel, o = {}) => post(s, '/deliverable', { title: '月次報告', path: path.join(root, rel), ...o });
const regId = async (s, rel, o) => { const r = await reg(s, rel, o); assert.equal(r.status, 201, r.text); return JSON.parse(r.text).id; };
const snapOf = async (s) => { const sse = await openSse(s); try { return await sse.snapshot(); } finally { sse.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('checkDeliverablePath: 許可リストの拡張子だけ通り、実行ファイル系・拡張子なし・二重拡張子の実行ファイルは拒否', () => {
  for (const f of ['成果物/月次報告.mp4', '成果物/資料.pptx', '成果物/表.xlsx', '成果物/メモ.txt', '成果物/page.html', '成果物/写真.PNG']) assert.equal(checkDeliverablePath(root, path.join(root, f)).ok, true, f);
  for (const f of ['成果物/run.exe', '成果物/run.bat', '成果物/x.ps1', '成果物/x.js', '成果物/x.lnk', '成果物/noext', '成果物/report.pdf.exe']) assert.equal(checkDeliverablePath(root, path.join(root, f)).ok, false, f);
  for (const e of ['exe', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'lnk', 'msi', 'com', 'scr']) assert.ok(!(e in ALLOWED_EXT), e);
  // 相対パスはルート基準
  const r = checkDeliverablePath(root, '成果物/月次報告.mp4');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'video');
  assert.equal(r.fileName, '月次報告.mp4');
});

test('checkDeliverablePath: ルートの外・トラバーサル・NUL・UNC・ADS・ドライブ相対・ディレクトリ・非表示の場所は拒否。理由にパスを含めない', () => {
  const bad = [
    path.join(outside, 'secret.txt'), '../outside/secret.txt', '成果物/../../outside/secret.txt', `${root}\\..\\outside\\secret.txt`,
    '成果物/メモ.txt\0.exe', '\\\\server\\share\\a.txt', '//server/share/a.txt', '成果物/メモ.txt:evil', 'C:メモ.txt', '成果物/メモ.txt.', '成果物/メモ.txt ',
    '成果物/dir.txt', '成果物', '', '   ', '.git/config.txt', 'node_modules/p/readme.md', '成果物/存在しない.mp4', '成果物/*.mp4',
  ];
  for (const b of bad) {
    const r = checkDeliverablePath(root, b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.ok(!r.reason.includes(outside) && !r.reason.includes('secret'), 'reason');
  }
  for (const b of [null, undefined, 5, {}, [], 'a'.repeat(2000)]) assert.equal(checkDeliverablePath(root, b).ok, false);
  if (linked) {
    assert.equal(checkDeliverablePath(root, path.join(root, 'escape', 'secret.txt')).ok, false); // ジャンクション経由の外部参照
    assert.equal(checkDeliverablePath(root, 'escape/secret.txt').ok, false);
  }
});

test('登録: PC の snapshot には題・種類・ファイル名・一言だけ(パスは出さない)。件数は両方に出る', async () => {
  await withServer(async (s) => {
    const id = await regId(s, '成果物/月次報告.mp4', { title: 'あ'.repeat(80), note: 'い'.repeat(100) });
    const sn = await snapOf(s);
    assert.equal(sn.deliverableCount, 1);
    const d = sn.deliverables[0];
    assert.deepEqual(Object.keys(d).sort(), ['approvedAt', 'confirmAt', 'createdAt', 'fileName', 'id', 'kind', 'note', 'openedAt', 'postText', 'posted', 'postedAt', 'rejectedAt', 'rejectedHasComment', 'removeAt', 'sns', 'status', 'title']);
    assert.equal(d.id, id);
    assert.equal(d.kind, 'video');
    assert.equal(d.fileName, '月次報告.mp4');
    assert.equal(d.title.length, 60);
    assert.equal(d.note.length, 80);
    assert.equal(d.status, 'new');
    assert.ok(!JSON.stringify(sn).includes(root) && !JSON.stringify(sn).includes('outside'));
    // kind の指定は列挙の中だけ。外れたら拡張子から
    const k = await regId(s, '成果物/表.xlsx', { kind: 'doc' });
    const k2 = await regId(s, '成果物/資料.pptx', { kind: 'exe' });
    const items = (await snapOf(s)).deliverables;
    assert.equal(items.find((x) => x.id === k).kind, 'doc');
    assert.equal(items.find((x) => x.id === k2).kind, 'pptx');
  });
});

test('登録の拒否: 題なし・不正なパス・実行ファイル・外部は 400(理由にパスなし)、型違いは 415', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/deliverable', { path: path.join(root, '成果物/表.xlsx') })).status, 400);
    assert.equal((await post(s, '/deliverable', { title: ' ', path: path.join(root, '成果物/表.xlsx') })).status, 400);
    for (const p of [path.join(root, '成果物/run.exe'), path.join(outside, 'secret.txt'), '../outside/secret.txt', '成果物/存在しない.mp4', 5, null]) {
      const r = await post(s, '/deliverable', { title: 't', path: p });
      assert.equal(r.status, 400, String(p));
      assert.ok(!r.text.includes('secret') && !r.text.includes(base));
    }
    assert.equal((await post(s, '/deliverable', 'not json')).status, 400);
    assert.equal((await post(s, '/deliverable', { title: 't', path: 'x' }, {})).status, 415);
    assert.equal((await snapOf(s)).deliverableCount, 0);
  });
});

test('開く: 登録済みの実パスだけを opener に渡し(クライアントのパスは無視)、開いたあとも消えずに残る', async () => {
  await withServer(async (s, opened) => {
    const id = await regId(s, '成果物/月次報告.mp4');
    const r = await post(s, '/deliverable-open', { id, path: path.join(outside, 'secret.txt'), cmd: 'calc.exe' });
    assert.equal(r.status, 204);
    assert.equal(opened.length, 1);
    assert.equal(fs.realpathSync.native(opened[0]), fs.realpathSync.native(path.join(root, '成果物/月次報告.mp4')));
    const d = (await snapOf(s)).deliverables[0];
    assert.equal(d.status, 'opened');
    assert.equal(typeof d.openedAt, 'number');
    assert.equal(d.removeAt, null);
    assert.equal((await snapOf(s)).deliverableCount, 1); // 承認・差し戻しまでは未承認として数える
    await sleep(GRACE + 300);
    assert.equal((await snapOf(s)).deliverables.length, 1); // 消えない
    assert.equal((await post(s, '/deliverable-open', { id })).status, 204); // 何度でも開ける
    assert.equal(opened.length, 2);
    assert.equal((await snapOf(s)).deliverables[0].status, 'opened');
  });
});

test('元に戻す: 猶予内なら未確認に戻り消えない。「見た(消す)」は開かずに確認済みにする', async () => {
  await withServer(async (s, opened) => {
    const a = await regId(s, '成果物/資料.pptx');
    const b = await regId(s, '成果物/表.xlsx');
    assert.equal((await post(s, '/deliverable-undo', { id: a })).status, 409); // 未確認は戻せない
    assert.equal((await post(s, '/deliverable-open', { id: a })).status, 204);
    assert.equal((await post(s, '/deliverable-undo', { id: a })).status, 204);
    assert.equal((await post(s, '/deliverable-dismiss', { id: b })).status, 204);
    assert.equal(opened.length, 1); // dismiss では開かない
    let items = (await snapOf(s)).deliverables;
    assert.equal(items.find((x) => x.id === a).status, 'new');
    assert.equal(items.find((x) => x.id === b).status, 'dismissed');
    await sleep(GRACE + 300);
    items = (await snapOf(s)).deliverables;
    assert.deepEqual(items.map((x) => x.id), [a]); // a は戻したので残り、b は消えた
    assert.equal((await post(s, '/deliverable-undo', { id: 'v999' })).status, 404);
    assert.equal((await post(s, '/deliverable-dismiss', { id: 5 })).status, 400);
    assert.equal((await post(s, '/deliverable-open', { id: 'v999' })).status, 404);
  });
});

test('開く直前にも検証し直す: 削除・外部へのすり替えは開かず 409。opener の失敗は 502 で未確認のまま', async () => {
  await withServer(async (s, opened) => {
    const f = mk('成果物/消える.mp4');
    const id = await regId(s, '成果物/消える.mp4');
    fs.rmSync(f);
    const r = await post(s, '/deliverable-open', { id });
    assert.equal(r.status, 409);
    assert.ok(!r.text.includes(base));
    assert.equal(opened.length, 0);
    assert.equal((await snapOf(s)).deliverables[0].status, 'new');
  });
  await withServer(async (s) => {
    const id = await regId(s, '成果物/月次報告.mp4');
    assert.equal((await post(s, '/deliverable-open', { id })).status, 502);
    assert.equal((await snapOf(s)).deliverables[0].status, 'new');
  }, { opener: async () => false });
});

test('連打は間隔制限(429)。間隔を空ければ開ける。同時の2回目も開かない', async () => {
  await withServer(async (s, opened) => {
    const a = await regId(s, '成果物/資料.pptx');
    const b = await regId(s, '成果物/表.xlsx');
    const [r1, r2] = await Promise.all([post(s, '/deliverable-open', { id: a }), post(s, '/deliverable-open', { id: b })]);
    assert.deepEqual([r1.status, r2.status].sort(), [204, 429]);
    assert.equal(opened.length, 1);
    await sleep(350);
    const rest = r1.status === 204 ? b : a;
    assert.equal((await post(s, '/deliverable-open', { id: rest })).status, 204);
    assert.equal(opened.length, 2);
  }, { openMinIntervalMs: 300 });
});

test('遠隔(スマホ)は 4 つの API が常に 403、他サイト由来も 403。snapshot・SSE は件数だけで題・ファイル名・パスを出さない', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const id = await regId(s, '成果物/月次報告.mp4', { title: '機密の題1,234,567円' });
    const rp = s.remotePort();
    for (const p of ['/deliverable', '/deliverable-open', '/deliverable-undo', '/deliverable-dismiss', '/deliverable-approve', '/deliverable-reject']) {
      const r = await raw(rp, p, { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify({ id, title: 't', path: path.join(root, '成果物/表.xlsx') }) });
      assert.equal(r.status, 403, p);
      assert.equal((await post(s, p, { id, title: 't', path: path.join(root, '成果物/表.xlsx') }, { ...J, Origin: 'http://evil.example' })).status, 403, p);
      assert.equal((await post(s, p, { id }, { ...J, 'Sec-Fetch-Site': 'cross-site' })).status, 403, p);
      assert.equal((await post(s, p, { id }, { ...J, Host: 'evil.example:1' })).status, 403, p);
    }
    assert.equal((await snapOf(s)).deliverables[0].status, 'new');
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${rp}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = res.body.getReader();
    let buf = '';
    const dec = new TextDecoder();
    (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { /* abort */ } })();
    for (let i = 0; i < 50 && !buf.includes('event: snapshot'); i++) await sleep(40);
    await regId(s, '成果物/表.xlsx', { title: '二つ目の題' });
    for (let i = 0; i < 50 && !buf.includes('"kind":"deliverable"'); i++) await sleep(40);
    await sleep(100);
    ac.abort();
    assert.ok(buf.includes('"deliverableCount":2'));
    for (const w of ['機密の題', '月次報告', '二つ目の題', '表.xlsx', 'mp4', root, '"deliverables"']) assert.ok(!buf.includes(w), w);
  });
});

test('31件目の登録は拒まず、確認済みの古いものから削る(確認済みが無ければやむなく最も古い未確認)', async () => {
  await withServer(async (s) => {
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(await regId(s, '成果物/メモ.txt', { title: `n${i}` }));
    await post(s, '/deliverable-dismiss', { id: ids[5] });
    const extra = await regId(s, '成果物/メモ.txt', { title: 'n30' });
    let items = (await snapOf(s)).deliverables;
    assert.equal(items.length, 30);
    assert.ok(!items.some((x) => x.id === ids[5])); // 確認済みが先に削られた
    assert.ok(items.some((x) => x.id === ids[0]) && items.some((x) => x.id === extra));
    await regId(s, '成果物/メモ.txt', { title: 'n31' });
    items = (await snapOf(s)).deliverables;
    assert.equal(items.length, 30);
    assert.ok(!items.some((x) => x.id === ids[0])); // 確認済みが無いので最も古い未確認
    assert.equal((await post(s, '/deliverable-open', { id: ids[0] })).status, 404);
  });
});

function runTool(port, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, '..', 'tools', 'post-deliverable.mjs')], { env: { ...process.env, OFFICE_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

test('tools/post-deliverable.mjs: 登録して id を出す。拒否・不正入力・サーバー無しは終了コード非0で、パスを出さない', async () => {
  await withServer(async (s) => {
    const ok = await runTool(s.port, JSON.stringify({ title: 'レポート動画', path: path.join(root, '成果物/月次報告.mp4'), note: '合格済み' }));
    assert.equal(ok.code, 0);
    assert.match(ok.out, /^\[成果物 id=v\d+\]\n$/);
    assert.equal((await snapOf(s)).deliverables.length, 1);
    const ng = await runTool(s.port, JSON.stringify({ title: 't', path: path.join(root, '成果物/run.exe') }));
    assert.equal(ng.code, 1);
    assert.equal(ng.out, '');
    assert.ok(ng.err.includes('400') && !ng.err.includes('run.exe'));
    assert.equal((await runTool(s.port, 'not json')).code, 2);
    assert.equal((await snapOf(s)).deliverables.length, 1);
  });
  assert.equal((await runTool(1, JSON.stringify({ title: 't', path: path.join(root, '成果物/表.xlsx') }))).code, 1);
});

// ---- 承認・差し戻し ----
const MARK = 'ひみつコメントZQX';
const nextText = (s, wait = 3) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: s.port, path: `/instruction/next?wait=${wait}`, headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }));
  }).on('error', reject);
});
const item = async (s, id) => (await snapOf(s)).deliverables.find((x) => x.id === id);

test('承認: 猶予中は approving と confirmAt、確定で approved と approvedAt、受信箱に「【成果物の承認】題」。new のままでも承認できる', async () => {
  await withServer(async (s) => {
    const id = await regId(s, '成果物/月次報告.mp4', { title: '月次報告' });
    const t0 = Date.now();
    const r = await post(s, '/deliverable-approve', { id, path: '/etc/passwd' });
    assert.equal(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.equal(j.id, id);
    assert.ok(j.confirmAt >= t0 && j.confirmAt <= t0 + 1000 + 500);
    const d1 = await item(s, id);
    assert.equal(d1.status, 'approving');
    assert.equal(d1.confirmAt, j.confirmAt);
    assert.equal(d1.approvedAt, null);
    assert.equal(d1.prev, undefined);
    assert.equal((await snapOf(s)).deliverableCount, 1); // 猶予中はまだ未確定
    const got = await nextText(s);
    assert.equal(got.status, 200);
    assert.equal(got.body.text, '【成果物の承認】月次報告');
    const d2 = await item(s, id);
    assert.equal(d2.status, 'approved');
    assert.equal(typeof d2.approvedAt, 'number');
    assert.equal(d2.confirmAt, null);
    assert.equal((await snapOf(s)).deliverableCount, 0);
    assert.equal((await post(s, '/deliverable-approve', { id })).status, 409); // 確定後の二重操作
    assert.equal((await post(s, '/deliverable-reject', { id })).status, 409);
    assert.equal((await post(s, '/deliverable-undo', { id })).status, 409); // 確定後は取り消せない
  }, { deliverableGraceMs: 1000 });
});

test('開いたあとに承認でき、確定後の履歴も再度「開く」ことができる(状態は変わらない)', async () => {
  await withServer(async (s, opened) => {
    const id = await regId(s, '成果物/月次報告.mp4');
    assert.equal((await post(s, '/deliverable-open', { id })).status, 204);
    assert.equal((await item(s, id)).status, 'opened');
    assert.equal((await post(s, '/deliverable-approve', { id })).status, 200);
    assert.equal((await post(s, '/deliverable-open', { id })).status, 409); // 猶予中は開けない
    await nextText(s);
    assert.equal((await post(s, '/deliverable-open', { id })).status, 204);
    assert.equal(opened.length, 2);
    const d = await item(s, id);
    assert.equal(d.status, 'approved');
    assert.equal(typeof d.openedAt, 'number');
  }, { deliverableGraceMs: 1000 });
});

test('差し戻し: コメントあり・なし。受信箱は全文、スナップショットは rejectedHasComment だけ', async () => {
  await withServer(async (s) => {
    const a = await regId(s, '成果物/月次報告.mp4', { title: '報告A' });
    const b = await regId(s, '成果物/表.xlsx', { title: '表B' });
    const c = await regId(s, '成果物/資料.pptx', { title: '資料C' });
    const ra = await post(s, '/deliverable-reject', { id: a, comment: `  ${MARK}\r\n二行目  ` });
    assert.equal(ra.status, 200, ra.text);
    assert.ok(!ra.text.includes(MARK));
    const da = await item(s, a);
    assert.equal(da.status, 'rejecting');
    assert.equal(da.rejectedHasComment, true);
    assert.equal((await nextText(s)).body.text, `【成果物の差し戻し】報告A: ${MARK}\n二行目`);
    const da2 = await item(s, a);
    assert.equal(da2.status, 'rejected');
    assert.equal(da2.rejectedHasComment, true);
    assert.equal(typeof da2.rejectedAt, 'number');
    assert.equal((await post(s, '/deliverable-reject', { id: b })).status, 200); // コメント省略
    assert.equal((await nextText(s)).body.text, '【成果物の差し戻し】表B');
    assert.equal((await item(s, b)).rejectedHasComment, false);
    assert.equal((await post(s, '/deliverable-reject', { id: c, comment: '   ' })).status, 200); // 空白だけは「コメントなし」
    assert.equal((await nextText(s)).body.text, '【成果物の差し戻し】資料C');
    assert.equal((await post(s, '/deliverable-reject', { id: c, comment: null })).status, 409);
  });
});

test('差し戻しコメント: 300文字ちょうどは通り、301文字・型違い・タブなどの制御文字・壊れたサロゲートは 400(状態は変わらない)', async () => {
  await withServer(async (s) => {
    const id = await regId(s, '成果物/月次報告.mp4');
    for (const c of ['あ'.repeat(301), '𠮷'.repeat(301), 5, true, ['a'], { a: 1 }, 'a\tb', 'a\u0000b', 'a\u001bb', 'a b', 'x\ud800y']) {
      assert.equal((await post(s, '/deliverable-reject', { id, comment: c })).status, 400, JSON.stringify(c));
    }
    assert.equal((await post(s, '/deliverable-reject', { id, comment: 'x', pad: 'y'.repeat(5000) })).status, 413);
    assert.equal((await post(s, '/deliverable-reject', { id: 5, comment: 'x' })).status, 400);
    assert.equal((await post(s, '/deliverable-reject', { id: 'v999', comment: 'x' })).status, 404);
    assert.equal((await post(s, '/deliverable-approve', { id: 'v999' })).status, 404);
    assert.equal((await post(s, '/deliverable-approve', { id: 5 })).status, 400);
    assert.equal((await post(s, '/deliverable-approve', 'not json')).status, 400);
    assert.equal((await post(s, '/deliverable-approve', { id }, {})).status, 415);
    assert.equal((await item(s, id)).status, 'new');
    assert.equal((await post(s, '/deliverable-reject', { id, comment: 'あ'.repeat(300) })).status, 200);
    assert.equal((await nextText(s)).body.text, `【成果物の差し戻し】月次報告: ${'あ'.repeat(300)}`);
  });
});

test('取り消し: 猶予中の承認・差し戻しは元の状態(new / opened)に戻り、受信箱に入らない。猶予中の別操作は 409', async () => {
  await withServer(async (s) => {
    const a = await regId(s, '成果物/月次報告.mp4');
    const b = await regId(s, '成果物/表.xlsx');
    assert.equal((await post(s, '/deliverable-approve', { id: a })).status, 200);
    assert.equal((await post(s, '/deliverable-approve', { id: a })).status, 409); // 猶予中の二重
    assert.equal((await post(s, '/deliverable-reject', { id: a })).status, 409); // 猶予中の別操作
    assert.equal((await post(s, '/deliverable-dismiss', { id: a })).status, 409);
    assert.equal((await post(s, '/deliverable-undo', { id: a })).status, 204);
    const da = await item(s, a);
    assert.equal(da.status, 'new');
    assert.equal(da.confirmAt, null);
    assert.equal((await post(s, '/deliverable-open', { id: b })).status, 204);
    assert.equal((await post(s, '/deliverable-reject', { id: b, comment: MARK })).status, 200);
    assert.equal((await post(s, '/deliverable-undo', { id: b })).status, 204);
    const db = await item(s, b);
    assert.equal(db.status, 'opened');
    assert.equal(db.rejectedHasComment, false);
    await sleep(1300);
    assert.equal((await nextText(s, 0)).status, 204); // 何も入っていない
    assert.equal((await item(s, a)).status, 'new');
    // 選び直し: コメントは取り消したものが残らない
    assert.equal((await post(s, '/deliverable-reject', { id: b })).status, 200);
    assert.equal((await nextText(s)).body.text, '【成果物の差し戻し】月次報告');
  }, { deliverableGraceMs: 1000 });
});

test('差し戻しコメントの本文は、snapshot・活動ログ・指示一覧・ボード・SSE・遠隔に出ない(受信箱だけ全文)', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
    const rp = s.remotePort();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${rp}/events`, { signal: ac.signal, headers: { Cookie: `office_key=${TOKEN}` } });
    const reader = res.body.getReader();
    let buf = '';
    const dec = new TextDecoder();
    (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { /* abort */ } })();
    try {
      const id = await regId(s, '成果物/月次報告.mp4', { title: '報告' });
      assert.equal((await post(s, '/deliverable-reject', { id, comment: `直す点: ${MARK}` })).status, 200);
      const got = await nextText(s);
      assert.equal(got.body.text, `【成果物の差し戻し】報告: 直す点: ${MARK}`); // 部長には全文
      await sleep(200);
      const pc = JSON.stringify(await snapOf(s)); // PC 向け(活動ログ・指示一覧・ボード・吹き出し・通知ログを含む)
      assert.ok(!pc.includes(MARK), 'PC snapshot');
      assert.ok(pc.includes('(コメントあり)'), '指示一覧には伏せ版が出る');
      assert.ok(!buf.includes(MARK), '遠隔 SSE');
    } finally { ac.abort(); Object.assign(console, orig); }
    assert.ok(!logs.join('\n').includes(MARK));
    const rs = await raw(rp, '/snapshot', { headers: { Cookie: `office_key=${TOKEN}` } });
    if (rs.status === 200) assert.ok(!rs.text.includes(MARK));
  });
});

test('履歴は30件まで: 超えたら承認済み・差し戻し済みの古いものから削り、承認待ちは残す', async () => {
  await withServer(async (s) => {
    const first = await regId(s, '成果物/月次報告.mp4', { title: '最初' });
    const waiting = await regId(s, '成果物/表.xlsx', { title: '待ち' });
    assert.equal((await post(s, '/deliverable-approve', { id: first })).status, 200);
    await nextText(s);
    const ids = [];
    for (let i = 0; i < 29; i++) ids.push(await regId(s, '成果物/メモ.txt', { title: `n${i}` })); // 合計31件
    const items = (await snapOf(s)).deliverables;
    assert.equal(items.length, 30);
    assert.equal(items.find((x) => x.id === first), undefined); // 確定済みの古いものが消えた
    assert.ok(items.find((x) => x.id === waiting));
    assert.equal((await post(s, '/deliverable-open', { id: first })).status, 404);
  });
});

test('他サイト由来・遠隔の承認・差し戻しは 403 で状態を変えない', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const id = await regId(s, '成果物/月次報告.mp4');
    for (const p of ['/deliverable-approve', '/deliverable-reject']) {
      assert.equal((await raw(s.remotePort(), p, { method: 'POST', headers: { ...J, Cookie: `office_key=${TOKEN}` }, body: JSON.stringify({ id, comment: MARK }) })).status, 403, p);
      assert.equal((await post(s, p, { id }, { ...J, Origin: 'http://evil.example' })).status, 403, p);
      assert.equal((await post(s, p, { id }, { ...J, 'Sec-Fetch-Site': 'cross-site' })).status, 403, p);
      assert.equal((await post(s, p, { id }, { ...J, Host: 'evil.example:1' })).status, 403, p);
    }
    assert.equal((await item(s, id)).status, 'new');
  });
});
