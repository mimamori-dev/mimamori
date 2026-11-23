import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './helpers.mjs';
import { findTailscaleIp, loadOrCreateToken } from '../lib/remote-config.mjs';

// 遠隔は既定で無効。このファイルは有効(OFFICE_REMOTE=1)にしたときの動作を確かめる
process.env.OFFICE_REMOTE = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-remote-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = 'test-token-0123456789abcdef';

async function withRemote(fn) {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  // テストでは Tailscale の代わりに 127.0.0.1 の別ポートを使う
  assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
  try { await fn(s, s.remotePort()); } finally { await s.close(); }
}

const req = (port, p, { method = 'GET', headers = {}, host } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } }, (x) => {
    x.resume();
    x.on('end', () => resolve({ status: x.statusCode, headers: x.headers }));
  });
  r.on('error', reject);
  r.end();
});

test('合言葉なし・違う合言葉は 403、理由は返さない', async () => {
  await withRemote(async (_s, rp) => {
    assert.equal((await req(rp, '/')).status, 403);
    assert.equal((await req(rp, '/?k=wrong-token-0123456789abcdef')).status, 403);
    assert.equal((await req(rp, '/', { headers: { Cookie: 'office_key=nope' } })).status, 403);
  });
});

test('正しい合言葉は Cookie に移して 302、Cookie があれば画面を返す', async () => {
  await withRemote(async (_s, rp) => {
    const r = await req(rp, `/?k=${TOKEN}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const setCookie = String(r.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const ok = await req(rp, '/', { headers: { Cookie: `office_key=${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  });
});

test('遠隔は閲覧専用: POST /event は合言葉があっても 403', async () => {
  await withRemote(async (_s, rp) => {
    const r = await req(rp, '/event', { method: 'POST', headers: { Cookie: `office_key=${TOKEN}`, 'Content-Type': 'application/json' } });
    assert.equal(r.status, 403);
  });
});

test('遠隔では /health・/remote-info・QR 配信を出さない', async () => {
  await withRemote(async (_s, rp) => {
    const h = { Cookie: `office_key=${TOKEN}` };
    assert.equal((await req(rp, '/health', { headers: h })).status, 404);
    assert.equal((await req(rp, '/remote-info', { headers: h })).status, 404);
    assert.equal((await req(rp, '/vendor/qr/qrcode.mjs', { headers: h })).status, 404);
  });
});

test('Host が想定外なら合言葉があっても 403', async () => {
  await withRemote(async (_s, rp) => {
    const r = await req(rp, '/', { headers: { Cookie: `office_key=${TOKEN}` }, host: `evil.example:${rp}` });
    assert.equal(r.status, 403);
  });
});

test('PC 側の /remote-info は遠隔URLを返し、QR 配信も PC 側だけ', async () => {
  await withRemote(async (s, rp) => {
    const info = await (await fetch(`http://127.0.0.1:${s.port}/remote-info`)).json();
    assert.equal(info.url, `http://127.0.0.1:${rp}/?k=${TOKEN}`);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/vendor/qr/qrcode.mjs`)).status, 200);
  });
});

test('遠隔が無効なら /remote-info は null', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    assert.equal((await (await fetch(`http://127.0.0.1:${s.port}/remote-info`)).json()).url, null);
  } finally { await s.close(); }
});

test('enableRemote は 0.0.0.0・短い合言葉を断る', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    assert.equal(await s.enableRemote({ host: '0.0.0.0', token: TOKEN, port: 0 }), false);
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: 'short', port: 0 }), false);
    assert.equal(s.remotePort(), null);
  } finally { await s.close(); }
});

test('Tailscale の宛先(100.64.0.0/10)だけを選ぶ', () => {
  const nic = (address, internal = false) => [{ family: 'IPv4', address, internal }];
  assert.equal(findTailscaleIp({ a: nic('192.168.1.5'), b: nic('100.101.102.103') }), '100.101.102.103');
  assert.equal(findTailscaleIp({ a: nic('100.63.0.1'), b: nic('100.128.0.1') }), null);
  assert.equal(findTailscaleIp({ a: nic('127.0.0.1', true) }), null);
});

test('合言葉は初回に作り、以後は同じものを使う', () => {
  const a = loadOrCreateToken(dir);
  assert.ok(a.length >= 16);
  assert.equal(loadOrCreateToken(dir), a);
});

// ---- 遠隔からの指示送信(POST /instruction だけ許可) ----
const post = (port, p, body, { headers = {}, host, raw } = {}) => new Promise((resolve, reject) => {
  const h = host ?? `127.0.0.1:${port}`;
  const data = raw ?? JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Host: h, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (x) => {
    x.resume();
    x.on('end', () => resolve({ status: x.statusCode }));
  });
  r.on('error', (e) => resolve({ status: 0, error: e.code }));
  r.end(data);
});
const okHeaders = (rp) => ({ Cookie: `office_key=${TOKEN}`, Origin: `http://127.0.0.1:${rp}` });

test('遠隔: 合言葉Cookie+同一Originの POST /instruction は 202 で、PC の待ち受けに届く', async () => {
  await withRemote(async (s, rp) => {
    const r = await post(rp, '/instruction', { text: 'スマホからの指示' }, { headers: okHeaders(rp) });
    assert.equal(r.status, 202);
    const next = await fetch(`http://127.0.0.1:${s.port}/instruction/next`);
    assert.equal(next.status, 200);
    assert.match(JSON.stringify(await next.json()), /スマホからの指示/);
  });
});

test('遠隔: Refererだけが一致しても通る', async () => {
  await withRemote(async (_s, rp) => {
    const r = await post(rp, '/instruction', { text: 'a' }, { headers: { Cookie: `office_key=${TOKEN}`, Referer: `http://127.0.0.1:${rp}/` } });
    assert.equal(r.status, 202);
  });
});

test('遠隔: Cookieなし・?k=だけ・違うCookie・Host違い・Origin違い・Origin/Refererなしは 403', async () => {
  await withRemote(async (_s, rp) => {
    const body = { text: 'x' };
    assert.equal((await post(rp, '/instruction', body, { headers: { Origin: `http://127.0.0.1:${rp}` } })).status, 403);
    assert.equal((await post(rp, `/instruction?k=${TOKEN}`, body, { headers: { Origin: `http://127.0.0.1:${rp}` } })).status, 403);
    assert.equal((await post(rp, '/instruction', body, { headers: { Cookie: 'office_key=nope', Origin: `http://127.0.0.1:${rp}` } })).status, 403);
    assert.equal((await post(rp, '/instruction', body, { headers: okHeaders(rp), host: `evil.example:${rp}` })).status, 403);
    assert.equal((await post(rp, '/instruction', body, { headers: { Cookie: `office_key=${TOKEN}`, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await post(rp, '/instruction', body, { headers: { Cookie: `office_key=${TOKEN}` } })).status, 403);
    assert.equal((await post(rp, '/instruction', body, { headers: { ...okHeaders(rp), 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });
});

test('遠隔: 他のPOST・PUT・DELETEは合言葉とOriginが正しくても 403', async () => {
  await withRemote(async (_s, rp) => {
    for (const p of ['/command', '/decision', '/answer', '/deliverable', '/deliverable-approve', '/decision-resolve', '/event', '/instruction/next']) {
      assert.equal((await post(rp, p, { id: 'x' }, { headers: okHeaders(rp) })).status, 403, p);
    }
    for (const method of ['PUT', 'DELETE']) {
      assert.equal((await req(rp, '/instruction', { method, headers: okHeaders(rp) })).status, 403);
    }
    assert.equal((await req(rp, '/instruction', { headers: okHeaders(rp) })).status, 403); // GET も不可
  });
});

test('遠隔: Content-Type が json でない・巨大本文・不正JSONは断る', async () => {
  await withRemote(async (_s, rp) => {
    assert.equal((await post(rp, '/instruction', null, { headers: { ...okHeaders(rp), 'Content-Type': 'text/plain' }, raw: '{"text":"a"}' })).status, 415);
    const big = await post(rp, '/instruction', null, { headers: okHeaders(rp), raw: JSON.stringify({ text: 'あ'.repeat(5000) }) });
    assert.ok(big.status === 413 || big.status === 0, `status ${big.status}`);
    assert.equal((await post(rp, '/instruction', null, { headers: okHeaders(rp), raw: 'not json' })).status, 400);
  });
});

test('遠隔: 1分に10件を超える連続送信は 429', async () => {
  await withRemote(async (_s, rp) => {
    for (let i = 0; i < 10; i++) assert.equal((await post(rp, '/instruction', { text: `n${i}` }, { headers: okHeaders(rp) })).status, 202);
    assert.equal((await post(rp, '/instruction', { text: 'over' }, { headers: okHeaders(rp) })).status, 429);
  });
});

test('PC ローカルの POST /instruction は従来どおり(Originなしで 202、他サイトOriginは 403)', async () => {
  await withRemote(async (s) => {
    assert.equal((await post(s.port, '/instruction', { text: 'pc' })).status, 202);
    assert.equal((await post(s.port, '/instruction', { text: 'pc' }, { headers: { Origin: 'http://evil.example' } })).status, 403);
  });
});
