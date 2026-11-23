import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw } from './helpers.mjs';

process.env.OFFICE_REMOTE = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ext-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mk = (name, src, files = {}) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, 'public'), { recursive: true });
  fs.writeFileSync(path.join(d, 'ext.mjs'), src);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  return d;
};
const GOOD = `export default {
  routes: {
    'GET /ext/hello': (req, res, ctx) => ctx.json(res, 200, { id: ctx.info.id, data: ctx.dataDir.endsWith('data') }),
    'POST /ext/echo': (req, res, ctx) => ctx.readSmallJson(req, res, 1024, (b) => ctx.json(res, 200, b)),
    'GET /ext/boom': () => { throw new Error('x'); },
    'GET /ext/aboom': async () => { throw new Error('y'); },
    'GET /ext/secret': (req, res, ctx) => ctx.json(res, 200, { s: 1 }),
  },
  remoteAllowed: ['GET /ext/hello'],
  panelsJs: true,
};`;
const withExt = async (dir, fn) => {
  const s = await startTestServer({ port: 0, allowedRoot: tmp, ...(dir ? { extDir: dir } : {}) });
  try { await fn(s); } finally { await s.close(); }
};
const JSONH = { 'Content-Type': 'application/json' };

test('拡張なし: 拡張の経路は 404、本体は動く', async () => {
  await withExt(null, async (s) => {
    assert.equal((await raw(s.port, '/ext/hello')).status, 404);
    assert.equal((await raw(s.port, '/ext/panels.js')).status, 404);
    assert.equal((await raw(s.port, '/health')).status, 200);
  });
});

test('拡張あり: GET/POST・ctx・panels 配信', async () => {
  const d = mk('good', GOOD, { 'public/panels.js': 'console.log(1)', 'public/panels.css': 'x{}' });
  await withExt(d, async (s) => {
    const r = await raw(s.port, '/ext/hello');
    assert.deepEqual(JSON.parse(r.text), { id: 'demo', data: true });
    const e = await raw(s.port, '/ext/echo', { method: 'POST', headers: JSONH, body: '{"a":1}' });
    assert.deepEqual(JSON.parse(e.text), { a: 1 });
    assert.equal((await raw(s.port, '/ext/panels.js')).text, 'console.log(1)');
    assert.equal((await raw(s.port, '/ext/panels.css')).status, 404); // panelsCss を宣言していない
    assert.equal((await raw(s.port, '/ext/nothing')).status, 404);
  });
});

test('拡張の handler が例外でも本体は動き続ける(500)', async () => {
  const d = mk('boom', GOOD);
  await withExt(d, async (s) => {
    assert.equal((await raw(s.port, '/ext/boom')).status, 500);
    assert.equal((await raw(s.port, '/ext/aboom')).status, 500);
    assert.equal((await raw(s.port, '/health')).status, 200);
  });
});

test('壊れた拡張(構文エラー・形が違う)でも起動し、拡張なしで動く', async () => {
  for (const [n, src] of [['syn', 'export default {{{'], ['shape', 'export default 5']]) {
    const d = mk(n, src);
    await withExt(d, async (s) => {
      assert.equal((await raw(s.port, '/health')).status, 200);
      assert.equal((await raw(s.port, '/ext/hello')).status, 404);
    });
  }
});

test('panels のパストラバーサルは配信しない(ファイルが無ければ 404)', async () => {
  const d = mk('trav', GOOD, { 'secret.txt': 'top' });
  await withExt(d, async (s) => {
    assert.equal((await raw(s.port, '/ext/panels.js')).status, 404); // ファイル無し
    for (const p of ['/ext/panels.js/../../secret.txt', '/ext/%2e%2e/secret.txt', '/ext/..%2fsecret.txt', '/ext/panels.js%00']) {
      const r = await raw(s.port, p);
      assert.notEqual(r.text, 'top');
      assert.ok([404, 405].includes(r.status), `${p} -> ${r.status}`);
    }
  });
});

test('遠隔: 許可リストに無い拡張の経路は 403、あるものだけ通る', async () => {
  const d = mk('remote', GOOD, { 'public/panels.js': 'p' });
  const TOKEN = 'test-token-0123456789abcdef';
  await withExt(d, async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const rp = s.remotePort();
    const get = (p) => raw(rp, p, { headers: { Host: `127.0.0.1:${rp}`, Cookie: `office_key=${TOKEN}` } });
    assert.equal((await get('/ext/hello')).status, 200);
    assert.equal((await get('/ext/secret')).status, 403);
    assert.equal((await get('/ext/panels.js')).status, 403);
    assert.equal((await raw(rp, '/ext/echo', { method: 'POST', headers: { ...JSONH, Host: `127.0.0.1:${rp}`, Cookie: `office_key=${TOKEN}` }, body: '{}' })).status, 403);
    assert.equal((await raw(rp, '/ext/hello', { headers: { Host: `127.0.0.1:${rp}` } })).status, 403); // 合言葉なし
  });
});
