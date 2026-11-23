import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addHooks, removeHooks, hookCommand, installedEvents, EVENTS, HOOK_SCRIPT } from '../tools/install-hooks.mjs';
import { createProject } from '../tools/new-project.mjs';
import { runDoctor, maskHome, portFree } from '../tools/doctor.mjs';
import { loadProjects } from '../lib/projects.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tools-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const tmp = (name) => fs.mkdtempSync(path.join(base, `${name}-`));
const run = (script, args, input) => spawnSync(process.execPath, [path.join(root, script), ...args], { input, encoding: 'utf8' });

test('install-hooks: 既存の hook を壊さず追加し、2回目は重複させない', () => {
  const cmd = hookCommand();
  const orig = { statusLine: { type: 'command', command: 'x' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'y' }] }] } };
  const a = addHooks(orig, cmd);
  assert.equal(a.added.length, EVENTS.length);
  assert.deepEqual(a.settings.hooks.PostToolUse, orig.hooks.PostToolUse);
  assert.equal(a.settings.hooks.Stop.length, 2);
  assert.equal(a.settings.hooks.Stop[0].hooks[0].command, 'other');
  assert.deepEqual(a.settings.statusLine, orig.statusLine);
  assert.equal(orig.hooks.Stop.length, 1, '入力は変更しない');
  assert.equal(addHooks(a.settings, cmd).added.length, 0);
  assert.equal(a.settings.hooks.PreToolUse[0].matcher, '*');
  assert.equal(a.settings.hooks.SessionStart[0].hooks[0].async, undefined);
  assert.equal(a.settings.hooks.Stop[1].hooks[0].async, true);
  assert.equal(installedEvents(a.settings, cmd).length, EVENTS.length);
});

test('install-hooks: uninstall は自分の hook だけを取り除き、元に戻る', () => {
  const cmd = hookCommand();
  const orig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
  const back = removeHooks(addHooks(orig, cmd).settings, cmd);
  assert.deepEqual(back.settings, orig);
  assert.deepEqual(removeHooks(addHooks({}, cmd).settings, cmd).settings, {});
  assert.equal(removeHooks({}, cmd).removed.length, 0);
});

test('install-hooks: スペース・日本語のパスはダブルクォートで囲み、危険な文字は拒否', () => {
  assert.equal(hookCommand('C:\\Users\\a b\\日本語\\office-hook.mjs'), 'node "C:/Users/a b/日本語/office-hook.mjs"');
  assert.throws(() => hookCommand('/x/a"b/office-hook.mjs'));
  assert.throws(() => hookCommand('/x/$HOME/office-hook.mjs'));
  assert.ok(path.isAbsolute(HOOK_SCRIPT));
});

test('install-hooks CLI: dry-run は書かず、y で書き(既存はバックアップ)、n は書かず、uninstall で戻る', () => {
  const dir = tmp('proj 日本語');
  const file = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  const orig = JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2) + '\n';
  fs.writeFileSync(file, orig);
  let r = run('tools/install-hooks.mjs', ['--project', dir, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+ SessionStart/);
  assert.equal(fs.readFileSync(file, 'utf8'), orig);
  run('tools/install-hooks.mjs', ['--project', dir], 'n\n');
  assert.equal(fs.readFileSync(file, 'utf8'), orig);
  run('tools/install-hooks.mjs', ['--project', dir], '');
  assert.equal(fs.readFileSync(file, 'utf8'), orig, 'EOF は No 扱い');
  r = run('tools/install-hooks.mjs', ['--project', dir], 'y\n');
  assert.equal(r.status, 0, r.stderr);
  const baks = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('settings.json.bak-'));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), baks[0]), 'utf8'), orig);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.equal(installedEvents(s, hookCommand()).length, EVENTS.length);
  r = run('tools/install-hooks.mjs', ['--project', dir, '--yes']);
  assert.match(r.stdout, /導入済み/);
  r = run('tools/install-hooks.mjs', ['--project', dir, '--uninstall', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(ls)'] } });
});

test('install-hooks CLI: 壊れた settings.json は何も変えず失敗、無ければ作る', () => {
  const bad = tmp('bad');
  fs.mkdirSync(path.join(bad, '.claude'));
  fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{oops');
  const r = run('tools/install-hooks.mjs', ['--project', bad, '--yes']);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(bad, '.claude', 'settings.json'), 'utf8'), '{oops');
  const fresh = tmp('fresh');
  assert.equal(run('tools/install-hooks.mjs', ['--project', fresh, '--yes']).status, 0);
  assert.ok(fs.existsSync(path.join(fresh, '.claude', 'settings.json')));
  assert.equal(run('tools/install-hooks.mjs', ['--user', '--project', fresh]).status, 1);
});

test('new-project: 規則に合う id だけ作り、重複・不正は拒否し、作ったものは読み込める', () => {
  const pdir = tmp('pj');
  fs.cpSync(path.join(root, 'projects', '_template'), path.join(pdir, '_template'), { recursive: true });
  const dest = createProject('my-app_1', pdir);
  const warns = [];
  const reg = loadProjects({ projectsDir: pdir, legacyRosterPath: path.join(root, 'roster.json'), defaultRoot: null, warn: (m) => warns.push(m) });
  assert.ok(reg.has('my-app_1'));
  assert.deepEqual(warns, [], '_template は警告なしで読み飛ばす');
  assert.ok(fs.existsSync(dest));
  assert.throws(() => createProject('my-app_1', pdir), /すでに/);
  for (const bad of ['', 'A', '1a', 'a b', '../x', 'a'.repeat(33), undefined]) assert.throws(() => createProject(bad, pdir), /id は/);
  assert.ok(createProject('a'.repeat(32), pdir));
  assert.equal(run('tools/new-project.mjs', ['Bad']).status, 1);
});

test('projects: 壊れた・規則違反の項目は、理由つきで warn する', () => {
  const pdir = tmp('warn');
  const mk = (id, files) => { fs.mkdirSync(path.join(pdir, id)); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(pdir, id, f), c); };
  mk('broken', { 'project.json': '{', 'roster.json': '{}' });
  mk('Upper', {});
  mk('mismatch', { 'project.json': JSON.stringify({ id: 'other' }), 'roster.json': JSON.stringify({ members: [] }) });
  mk('noroster', { 'project.json': JSON.stringify({ id: 'noroster' }), 'roster.json': JSON.stringify({}) });
  mk('empty', {});
  mk('_template', {});
  mk('good', { 'project.json': JSON.stringify({ id: 'good' }), 'roster.json': JSON.stringify({ members: [] }) });
  const warns = [];
  const reg = loadProjects({ projectsDir: pdir, legacyRosterPath: path.join(root, 'roster.json'), defaultRoot: null, warn: (m) => warns.push(m) });
  assert.deepEqual([...reg.keys()].sort(), ['demo', 'good']);
  const has = (id, re) => warns.some((w) => w.includes(`${id}:`) && re.test(w));
  assert.ok(has('broken', /読めない/));
  assert.ok(has('Upper', /規則/));
  assert.ok(has('mismatch', /id/));
  assert.ok(has('noroster', /members/));
  assert.ok(has('empty', /ファイルがありません/));
  assert.equal(warns.length, 5);
});

test('projects: warn 未指定なら console.warn に出す', () => {
  const pdir = tmp('cw');
  fs.mkdirSync(path.join(pdir, 'Bad'));
  const orig = console.warn;
  const got = [];
  console.warn = (m) => got.push(m);
  try { loadProjects({ projectsDir: pdir, legacyRosterPath: path.join(root, 'roster.json'), defaultRoot: null }); } finally { console.warn = orig; }
  assert.equal(got.length, 1);
});

test('doctor: ホームを ~ に置換し、使用中ポートと hook の有無を表示する', async () => {
  assert.equal(maskHome('C:\\Users\\taro\\x and c:/users/taro/y', 'C:\\Users\\taro'), '~\\x and ~/y');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.equal(await portFree(port), false);
  const home = tmp('home');
  const proj = tmp('dproj');
  const r = await runDoctor({ projectDir: proj, env: { OFFICE_PORT: String(port) }, home });
  srv.close();
  assert.match(r.text, new RegExp(`ポート ${port} \\| 使用中`));
  assert.match(r.text, /hook \| NG/);
  assert.match(r.text, /Node\.js \| OK/);
  assert.ok(!r.text.includes(home), '個人のパスが残らない');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify(addHooks({}, hookCommand()).settings));
  const r2 = await runDoctor({ projectDir: proj, env: {}, home });
  assert.match(r2.text, /hook \| OK/);
});

test('server: 使用中のポートでは案内を出して終了する', async () => {
  if (!fs.existsSync(path.join(root, 'node_modules', 'three'))) return; // node_modules 無しでは別の案内になる
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const r = spawnSync(process.execPath, [path.join(root, 'office-server.mjs')], { env: { ...process.env, OFFICE_PORT: String(port) }, encoding: 'utf8', timeout: 15000 });
  srv.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /使用中/);
  assert.match(r.stderr, /OFFICE_PORT/);
});
