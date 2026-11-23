import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createState, applyEvent, snapshot, seatOfAgent, addLog, enqueueInstruction, markAssigningBubble, markAnswerRead, addDeliverable, markDeliverable, noteDeliverableOpened, beginDeliverableVerdict, confirmDeliverableVerdict, validOtherText, undoDeliverable, removeDeliverable, findDeliverable, restoreSnsDeliverable, setSnsPosted, resolveTerminalDecisions, POST_TEXT_MAX, addOfficeDecision, chooseDecision, chooseDecisionOther, cancelDecisionChoice, confirmDecision, resolveDecision, replyOpenDecisions } from './lib/state.mjs';
import { createInbox, validText, BODY_MAX as INSTRUCTION_BODY_MAX } from './lib/inbox.mjs';
import { shorten, clipInstruction, promptText } from './lib/describe.mjs';
import { createUsageMeter } from './lib/usage-meter.mjs';
import { createCommandRunner, defaultCommands } from './lib/commands.mjs';
import { listTree } from './lib/tree.mjs';
import { createTalkReader } from './lib/talk.mjs';
import { checkDeliverablePath, openWithDefaultApp, KINDS } from './lib/deliverables.mjs';
import { loadSns, saveSns } from './lib/sns-store.mjs';
import { sanitizeEvent } from './lib/guard.mjs';
import { DEFAULT_PROJECT, loadProjects, transcriptInProject, projectsFromOrigin } from './lib/projects.mjs';
import { createTts, TTS_TEXT_MAX, TTS_BODY_MAX } from './lib/tts.mjs';
import { isRemoteEnabled, startRemoteWatcher } from './lib/remote-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));
const BODY_MAX = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const STATIC_ROUTES = [
  ['/static/', 'public'],
  ['/vendor/three/', 'node_modules/three/build'],
  ['/vendor/addons/', 'node_modules/three/examples/jsm'],
];
// QR は PC 側の画面でしか使わないので、遠隔(スマホ)には配らない
const LOCAL_ONLY_ROUTES = [['/vendor/qr/', 'node_modules/qrcode-generator/dist']];
const COOKIE = 'office_key';
const COOKIE_MAX_AGE_SEC = 30 * 24 * 3600; // 30日。端末紛失・合言葉漏れに備え、1年は長すぎる
// Cookie の値に世代番号を含める。世代を上げると既存の Cookie は全て無効(0 は旧形式: 合言葉そのまま)
const cookieValue = (token, generation) => (generation > 0 ? `g${generation}.${token}` : token);
// 画面のファイル一覧・成果物登録の基準フォルダ。既定はこのフォルダ。変えたいときは環境変数 OFFICE_PROJECT_ROOT
const PROJECT_ROOT = process.env.OFFICE_PROJECT_ROOT ? path.resolve(process.env.OFFICE_PROJECT_ROOT) : here;
const COMMAND_BODY_MAX = 1024;
const DECISION_BODY_MAX = 8 * 1024;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const sameKey = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(sha(a), sha(b));
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

// 「投稿済みにする」から掲示板のカードが自動で消えるまでの猶予(この間は「未投稿に戻す」で取り消せる)
export const SNS_POSTED_GRACE_MS = 3 * 60 * 1000;

export function startServer({ port, host = '127.0.0.1', allowedRoot = path.join(os.homedir(), '.claude', 'projects'), now = Date.now, waitMaxSec = 30, assignBubbleMs = 2500, treeRoot = PROJECT_ROOT, commands = null, commandTimeoutMs = 30_000, decisionGraceMs = 5000, deliverableGraceMs = 5000, snsPostedGraceMs = SNS_POSTED_GRACE_MS, openMinIntervalMs = 1000, opener = openWithDefaultApp, projectsDir = process.env.OFFICE_PROJECTS_DIR ? path.resolve(process.env.OFFICE_PROJECTS_DIR) : path.join(here, 'projects'), narrowTranscripts = false, snsFile = path.join(here, 'data', 'sns-queue.json'), remoteAllowed = isRemoteEnabled(), extDir = process.env.OFFICE_EXT_DIR || null, voicevoxUrl = 'http://127.0.0.1:50021', ttsTimeoutMs = 10_000 } = {}) {
  const pricing = readJson('pricing.json');
  // treeRoot は demo(既定のプロジェクト)のルートを上書きする(テスト用)。ほかのプロジェクトのルートは project.json
  const registry = loadProjects({ projectsDir, legacyRosterPath: path.join(here, 'roster.json'), defaultRoot: treeRoot });
  const clients = new Map(); // res -> { remote: 遠隔側の接続か, project: 見ているプロジェクトの id }
  let listenPort = port;
  const runner = createCommandRunner({
    commands: commands ?? defaultCommands({ officeDir: here, projectRoot: PROJECT_ROOT, health: () => ({ ok: true, clients: clients.size, pid: process.pid }) }),
    timeoutMs: commandTimeoutMs,
  });
  let remote = null; // { host, token, allowedHosts, port, server }
  const send = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  function serveFile(res, root, rel) {
    // デコード後に検査する(%2e%2e や %00 を通さない)
    if (rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return notFound(res);
    const file = path.join(here, root, rel);
    if (!file.startsWith(path.join(here, root) + path.sep)) return notFound(res);
    fs.readFile(file, (err, buf) => {
      if (err) return notFound(res);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }
  const notFound = (res) => { res.writeHead(404); res.end(); };

  // 画面(同一オリジン)以外のブラウザ由来を断る。hook・待ち受けは Origin を付けない
  const crossSite = (req) => {
    const h = req.headers;
    // Host は相手が書き換えられるので信用せず、Origin は自分の待ち受け先(固定)と比べる
    const okOrigins = [`http://127.0.0.1:${listenPort}`, `http://localhost:${listenPort}`];
    return (h.origin !== undefined && !okOrigins.includes(h.origin)) || (h['sec-fetch-site'] !== undefined && h['sec-fetch-site'] !== 'same-origin');
  };

  // 読み上げの中継(任意機能)。PC の画面(同一オリジン)だけ。遠隔・他サイトは 403。VOICEVOX が無ければ 503
  const tts = createTts({ baseUrl: voicevoxUrl, timeoutMs: ttsTimeoutMs });
  function handleTtsPost(req, res, isRemote) {
    if (isRemote || crossSite(req)) { res.writeHead(403); res.end(); return; }
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) { res.writeHead(415); res.end(); return; }
    if (Number(req.headers['content-length']) > TTS_BODY_MAX) { res.writeHead(413); res.end(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= TTS_BODY_MAX) chunks.push(c); });
    req.on('end', async () => {
      try {
        if (size > TTS_BODY_MAX) { res.writeHead(413); res.end(); return; }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { res.writeHead(400); res.end(); return; }
        const text = body.text;
        const speaker = body.speaker === undefined ? 11 : body.speaker;
        if (typeof text !== 'string' || !text.trim()) { res.writeHead(400); res.end(); return; }
        if (text.length > TTS_TEXT_MAX) { res.writeHead(413); res.end(); return; }
        if (!Number.isInteger(speaker) || speaker < 0 || speaker > 9999) { res.writeHead(400); res.end(); return; }
        let wav;
        try { wav = await tts.synthesize(text, speaker); } catch { res.writeHead(503, { 'Retry-After': '30' }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
        res.end(wav);
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
  }

  // コマンド窓。許可リストの id だけを実行する(文字列はシェルに渡さない)。PC の画面(同一オリジン)だけ
  function handleCommandPost(req, res) {
    if (crossSite(req)) { res.writeHead(403); res.end(); return; }
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) { res.writeHead(415); res.end(); return; }
    if (Number(req.headers['content-length']) > COMMAND_BODY_MAX) { res.writeHead(413); res.end(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= COMMAND_BODY_MAX) chunks.push(c); });
    req.on('end', async () => {
      try {
        if (size > COMMAND_BODY_MAX) { res.writeHead(413); res.end(); return; }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { res.writeHead(400); res.end(); return; }
        const r = await runner.run(body.id);
        res.writeHead(r.status, r.body ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {});
        res.end(r.body ? JSON.stringify(r.body) : undefined);
      } catch {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
    });
  }

  // 判断カードまわりの小さな JSON 受け口。PC の画面と post-decision.mjs(どちらも 127.0.0.1)だけ
  function readSmallJson(req, res, max, onBody) {
    if (crossSite(req)) { res.writeHead(403); res.end(); return; }
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) { res.writeHead(415); res.end(); return; }
    if (Number(req.headers['content-length']) > max) { res.writeHead(413); res.end(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => {
      try {
        if (size > max) { res.writeHead(413); res.end(); return; }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { res.writeHead(400); res.end(); return; }
        onBody(body);
      } catch {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
    });
  }
  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

  const handler = (isRemote) => (req, res) => {
    try { route(req, res, isRemote); } catch {
      if (!res.headersSent) { res.writeHead(400); }
      res.end();
    }
  };
  // 拡張の差し込み口(OFFICE_EXT_DIR/ext.mjs)。壊れていても本体は止めず、警告だけ出す
  const warn = (msg) => console.warn(`Mimamori: 拡張の警告: ${msg}`);
  const extRoot = extDir ? path.resolve(extDir) : null;
  let ext = null; // { routes: Map('METHOD /path' -> fn), allowed: Set, panelsJs, panelsCss }
  async function loadExt() {
    if (!extRoot) return;
    const file = path.join(extRoot, 'ext.mjs');
    if (!fs.existsSync(file)) return;
    try {
      const def = (await import(pathToFileURL(file).href)).default;
      if (!def || typeof def !== 'object') throw new Error('default export がオブジェクトではありません');
      const routes = new Map();
      for (const [key, fn] of Object.entries(def.routes ?? {})) {
        if (/^(GET|POST) \/[^\s]*$/.test(key) && typeof fn === 'function') routes.set(key, fn); else warn(`routes の項目を無視しました: ${key}`);
      }
      ext = { routes, allowed: new Set(Array.isArray(def.remoteAllowed) ? def.remoteAllowed.filter((k) => typeof k === 'string') : []), panelsJs: def.panelsJs === true, panelsCss: def.panelsCss === true };
    } catch (e) {
      warn(`ext.mjs を読み込めませんでした(拡張なしで続行): ${e?.message ?? e}`);
    }
  }
  const extReady = loadExt(); // 起動(listen)前に読み終える
  const EXT_PANELS = { '/ext/panels.js': ['panels.js', 'panelsJs'], '/ext/panels.css': ['panels.css', 'panelsCss'] };
  // 本体のどの経路にも一致しなかった要求だけ受ける。true を返したら処理済み
  function dispatchExt(req, res, url, proj, isRemote) {
    if (!ext) return false;
    const p = url.pathname;
    const key = `${req.method} ${p}`;
    const panel = req.method === 'GET' ? EXT_PANELS[p] : undefined;
    const fn = ext.routes.get(key);
    if (!fn && !(panel && ext[panel[1]])) return false;
    // 遠隔(スマホ)は、拡張が remoteAllowed に挙げた経路だけ通す(既定は全て 403)
    if (isRemote && !ext.allowed.has(key)) { res.writeHead(403); res.end(); return true; }
    if (panel && !fn) {
      const base = path.join(extRoot, 'public');
      try {
        const real = fs.realpathSync(path.join(base, panel[0]));
        if (!real.startsWith(fs.realpathSync(base) + path.sep)) return notFound(res), true;
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(real)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(real));
      } catch { notFound(res); }
      return true;
    }
    if (!proj) { notFound(res); return true; }
    // POST は副作用を持つので、他サイト由来は本体側で断る(GET は拡張が必要なら ctx.crossSite を自分で呼ぶ)
    if (req.method === 'POST' && crossSite(req)) { res.writeHead(403); res.end(); return true; }
    const ctx = { info: proj.info, inbox: proj.inbox, state: proj.state, now, json, readSmallJson, enqueueInstruction, opener, crossSite, openGate: proj.openGate, validOtherText, extDir: extRoot, dataDir: path.join(extRoot, 'data') };
    const fail = (e) => { warn(`${key} が失敗しました: ${e?.message ?? e}`); if (!res.headersSent) res.writeHead(500); res.end(); };
    try { Promise.resolve(fn(req, res, ctx)).catch(fail); } catch (e) { fail(e); }
    return true;
  }

  const server = http.createServer(handler(false));

  // 遠隔(Tailscale 経由のスマホ)は、合言葉を持つ閲覧だけ通す。通らなければ理由を伝えず 403
  const REMOTE_POST_PER_MIN = 10;
  const remotePosts = []; // 受け付けた指示POSTの時刻(直近1分の回数制限)
  function remoteGate(req, res, url) {
    const hostOk = [remote.host, ...remote.allowedHosts].some((h) => req.headers.host === `${h}:${remote.port}`);
    const viaCookie = sameKey(cookieOf(req, COOKIE), cookieValue(remote.token, remote.generation));
    const viaQuery = sameKey(url.searchParams.get('k'), remote.token);
    // 唯一の例外: POST /instruction。Cookie 必須(?k= だけは不可)・Origin か Referer が自分の遠隔ホストと一致
    if (req.method === 'POST' && url.pathname === '/instruction') {
      const self = `http://${req.headers.host}`;
      const o = req.headers.origin;
      const ref = String(req.headers.referer ?? '');
      const sameOrigin = o !== undefined ? o === self : (ref === self || ref.startsWith(`${self}/`));
      const site = req.headers['sec-fetch-site'];
      if (!hostOk || !viaCookie || !sameOrigin || (site !== undefined && site !== 'same-origin')) { res.writeHead(403); res.end(); return false; }
      // 遠隔から指示を送れるのは既定プロジェクトだけ(?project= で他を指定されたら 403)
      if ((url.searchParams.get('project') ?? DEFAULT_PROJECT) !== DEFAULT_PROJECT) { res.writeHead(403); res.end(); return false; }
      const t = now();
      while (remotePosts.length && t - remotePosts[0] > 60_000) remotePosts.shift();
      if (remotePosts.length >= REMOTE_POST_PER_MIN) { res.writeHead(429, { 'Retry-After': '60' }); res.end(); return false; }
      remotePosts.push(t);
      return true;
    }
    if (!hostOk || req.method !== 'GET' || !(viaCookie || viaQuery)) { res.writeHead(403); res.end(); return false; }
    if (!viaCookie) {
      // URL の合言葉は Cookie に移して、履歴に残る URL から外す
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${cookieValue(remote.token, remote.generation)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}`, Location: url.pathname, 'Cache-Control': 'no-store' });
      res.end(); return false;
    }
    res.setHeader('Referrer-Policy', 'no-referrer');
    return true;
  }

  // プロジェクトごとに、状態・使用量・指示キュー・判断カード・成果物を別に持つ(混ぜない)
  function makeProject(info) {
    const state = createState(info.roster);
    const meter = createUsageMeter({ pricing, allowedRoot });
    const talk = createTalkReader({ allowedRoot });
    const inbox = createInbox({ now, waitMaxSec });
    // transcript は、このプロジェクトのフォルダのものだけを読む(他プロジェクトの会話・使用量を読ませない)。
    // demo は従来どおり allowedRoot 全体(既存の動作を保つ)。本番の起動では narrowTranscripts で demo も絞る
    const narrow = info.id !== DEFAULT_PROJECT || narrowTranscripts;
    const transcriptOk = (p) => !narrow || transcriptInProject(allowedRoot, info.root, p);
    const mineOnly = (fn) => { for (const [c, v] of clients) if (v.project === info.id) fn(c, v); };
    const broadcast = (name, data) => mineOnly((c) => send(c, name, data));
    const snap = (isRemote = false) => ({ ...snapshot(state, now(), { local: !isRemote }), snsGraceMs: snsPostedGraceMs, usage: meter.totals(), inbox: { pending: inbox.pending(), listening: inbox.listening(), canSend: !isRemote, ...(isRemote && remote ? { canInstruct: true } : {}) } }); // canInstruct: 遠隔でも指示の送信だけは可(canSend は判断カード等の PC 専用操作の目印のまま)
    // 部長の発言(say)の本文は SSE のイベントにも載せない(画面は PC の snapshot.talk から読む)
    const broadcastOffice = (event) => {
      // 発言の本文・ToDo の進行中の見出しは、SSE のイベントには載せない(画面は PC の snapshot から読む)
      const e = event?.kind === 'say' ? { ...event, text: '' } : event?.kind === 'todo' ? { ...event, todoCurrent: '' } : event;
      mineOnly((c, v) => send(c, 'office', { event: e, snapshot: snap(v.remote) }));
    };
    // 「指示を受けました」を少し見せてから、最初の依頼・作業が出るまでは「タスクを振っています」にする
    const assignTimers = new Set();
    function scheduleAssignBubble() {
      const t = setTimeout(() => {
        assignTimers.delete(t);
        if (markAssigningBubble(state)) broadcastOffice({ ts: now(), kind: 'inbox', agentId: null, agentType: null, text: '', title: '' });
      }, assignBubbleMs);
      t.unref();
      assignTimers.add(t);
    }
  
    // 表示は壊さない: 追跡の失敗は握りつぶす
    const SAFE_ID = /^[A-Za-z0-9_-]+$/;
    let chain = Promise.resolve(); // 直列化: 前ターンの遅れた集計が次ターンと重ならないように
    function trackUsage(ev, subSeat) {
      chain = chain.then(async () => {
        try {
          if (ev.transcriptPath && transcriptOk(ev.transcriptPath)) await meter.track(ev.transcriptPath, 'bucho');
          // ターミナルでの部長の発言を、前回の読み位置より後だけ取り出す(失敗しても表示は止めない)
          if (typeof ev.transcriptPath === 'string' && ev.kind !== 'say' && transcriptOk(ev.transcriptPath)) {
            for (const text of await talk.read(ev.transcriptPath)) {
              const say = { ts: now(), kind: 'say', agentId: null, agentType: null, text, title: '' };
              applyEvent(state, say);
              broadcastOffice(say);
            }
          }
          if (typeof ev.agentId === 'string' && SAFE_ID.test(ev.agentId) && transcriptOk(ev.agentTranscriptPath ?? ev.transcriptPath)) {
            const sub = ev.agentTranscriptPath
              ?? (ev.transcriptPath ? `${String(ev.transcriptPath).replace(/\.jsonl$/, '')}/subagents/agent-${ev.agentId}.jsonl` : null);
            // 席に座れなかった担当も合計には数える
            if (sub) await meter.track(sub, subSeat ?? 'overflow');
          }
          broadcast('usage', meter.totals());
        } catch { /* ignore */ }
      });
    }
    // イベントの受け入れ(許可リスト・伏せ字・プロジェクトの照合は handleEventPost で済んでいる)
    function ingest(ev, res) {
      if (ev.kind === 'prompt') meter.resetTurn(); // snapshot より前に新しいターンへ
      // 解除(subagent_done)の前後どちらかで席が分かれば、最後の使用量も正しい席に数える
      const before = seatOfAgent(state, ev.agentId);
      applyEvent(state, ev);
      const subSeat = seatOfAgent(state, ev.agentId) ?? before;
      res.writeHead(204); res.end();
      broadcastOffice(ev);
      if (ev.kind === 'prompt' && !ev.agentId) scheduleAssignBubble();
      // ターミナルでの社長の入力(UserPromptSubmit は kind=prompt で届く。画面経由の指示は /event を通らない)で、terminal カードを閉じる。
      // 担当(agentId あり)や、通知・内部配管(<task-notification 等)の文は本物の入力ではないので対象外
      if (ev.kind === 'prompt' && !ev.agentId && !/^\s*<(task-notification|system-reminder)/i.test(String(ev.body ?? ev.title ?? '')) && resolveTerminalDecisions(state)) broadcastOffice(decisionEvent());
      trackUsage(ev, subSeat);
    }
    // fromRemote: 遠隔(スマホ)経由。同一オリジン・合言葉・回数の検査は remoteGate 側で済んでいる
    function handleInstructionPost(req, res, fromRemote = false) {
      const h = req.headers;
      if (!fromRemote && crossSite(req)) { res.writeHead(403); res.end(); return; }
      if (!/^application\/json\s*(;|$)/i.test(String(h['content-type'] ?? ''))) { res.writeHead(415); res.end(); return; }
      const reject413 = () => { res.writeHead(413, { Connection: 'close' }); res.end(() => setTimeout(() => req.destroy(), 100).unref()); };
      if (Number(h['content-length']) > INSTRUCTION_BODY_MAX) return reject413();
      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on('data', (c) => {
        if (rejected) return;
        size += c.length;
        if (size > INSTRUCTION_BODY_MAX) { rejected = true; reject413(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
          const text = body && typeof body === 'object' && !Array.isArray(body) ? validText(body.text) : null;
          if (text === null) { res.writeHead(400); res.end(); return; }
          if (inbox.isFull()) { res.writeHead(429); res.end(); return; }
          const id = inbox.enqueue(text, enqueueInstruction(state, text, now()), null, fromRemote ? 'remote' : null);
          const replied = replyOpenDecisions(state); // 自由記入の確認事項への回答とみなす
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id }));
          if (replied) broadcastOffice(decisionEvent());
          broadcastOffice({ ts: now(), kind: 'inbox', agentId: null, agentType: null, text: '', title: '' }); // 受け取り待ちの件数を画面へ(本文は含めない)
        } catch {
          if (!res.headersSent) res.writeHead(400);
          res.end();
        }
      });
    }
  
    // 画面の「既読」ボタン。指示の入口と同じく同一オリジンだけ
    function handleAnswerRead(req, res) {
      const h = req.headers;
      if (crossSite(req)) { res.writeHead(403); res.end(); return; }
      if (!/^application\/json\s*(;|$)/i.test(String(h['content-type'] ?? ''))) { res.writeHead(415); res.end(); return; }
      if (Number(h['content-length']) > 1024) { res.writeHead(413); res.end(); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= 1024) chunks.push(c); });
      req.on('end', () => {
        try {
          if (size > 1024) { res.writeHead(413); res.end(); return; }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
          if (!body || typeof body !== 'object' || typeof body.id !== 'string') { res.writeHead(400); res.end(); return; }
          if (!markAnswerRead(state, body.id)) { res.writeHead(404); res.end(); return; }
          res.writeHead(204); res.end();
          broadcastOffice({ ts: now(), kind: 'answer-read', agentId: null, agentType: null, text: '', title: '' });
        } catch {
          if (!res.headersSent) res.writeHead(400);
          res.end();
        }
      });
    }
    const decisionEvent = () => ({ ts: now(), kind: 'decision', agentId: null, agentType: null, text: '', title: '' });
    // 部長(post-decision.mjs)が判断カードを出す
    function handleDecisionPost(req, res) {
      readSmallJson(req, res, DECISION_BODY_MAX, (body) => {
        const id = addOfficeDecision(state, body, now());
        if (id === null) { res.writeHead(400); res.end(); return; }
        if (id === 'full') { res.writeHead(429); res.end(); return; }
        json(res, 201, { id });
        broadcastOffice(decisionEvent());
      });
    }
  
    // 社長が選択肢をクリック。すぐには確定せず、猶予のあと受信箱へ入れる
    const confirmTimers = new Map(); // decisionId -> timer
    function handleAnswerPost(req, res) {
      // other は500文字(日本語で約1.5KB、エスケープ込みでさらに増える)まで受けるので、上限は4KB
      readSmallJson(req, res, 4096, (body) => {
        if (typeof body.id !== 'string') { res.writeHead(400); res.end(); return; }
        const hasOther = Object.hasOwn(body, 'other');
        if (hasOther && Object.hasOwn(body, 'choice')) { res.writeHead(400); res.end(); return; } // どちらか一方だけ
        const confirmAt = now() + decisionGraceMs;
        const r = hasOther ? chooseDecisionOther(state, body.id, body.other, confirmAt) : chooseDecision(state, body.id, body.choice, confirmAt);
        if (r === 'notfound') { res.writeHead(404); res.end(); return; }
        if (r === 'invalid') { res.writeHead(400); res.end(); return; }
        if (r === 'conflict') { res.writeHead(409); res.end(); return; }
        if (inbox.isFull()) { cancelDecisionChoice(state, body.id); res.writeHead(429); res.end(); return; }
        const t = setTimeout(() => {
          confirmTimers.delete(body.id);
          const text = confirmDecision(state, body.id);
          if (text === null) return;
          // 受信箱(部長だけが読む)には全文、PC の一覧(state.instructions)には入力文を伏せた見出しだけ入れる
          const view = hasOther ? text.slice(0, text.indexOf('その他: ') + 'その他'.length) : null;
          inbox.enqueue(text, enqueueInstruction(state, view ?? text, now()), view);
          broadcastOffice(decisionEvent());
        }, decisionGraceMs);
        t.unref();
        confirmTimers.set(body.id, t);
        json(res, 200, hasOther ? { id: body.id, other: true, confirmAt } : { id: body.id, choice: body.choice, confirmAt });
        broadcastOffice(decisionEvent());
      });
    }
    // ---- 成果物ボード ----
    // 画面・遠隔には出さないパス(id -> 検証済みの実パス)。メモリのみ
    const deliverablePaths = new Map();
    // SNS用のカードだけをファイルに残す(プロジェクトごと)。失敗は握りつぶさず state.snsError に入れて画面に出す(サーバーは落ちない)
    const persistSns = () => {
      try {
        saveSns(snsFile, info.id, state.deliverables.filter((d) => d.sns).map((d) => ({ ...d, path: deliverablePaths.get(d.id) ?? null })).filter((d) => d.path));
        state.snsError = null;
      } catch { state.snsError = 'SNS用の記録を保存できませんでした(再起動すると投稿済みの印が消えます)'; }
    };
    const checkPath = (p) => (info.root ? checkDeliverablePath(info.root, p) : { ok: false, reason: 'このプロジェクトの成果物の場所は未設定です' });
    const removeTimers = new Map();
    let lastOpenAt = -Infinity;
    // 拡張用: 本体の「開く」と同じ最小間隔(時刻も共有)。通れば true で時刻を更新、間隔内なら false
    const openGate = () => { const t = now(); if (t - lastOpenAt < openMinIntervalMs) return false; lastOpenAt = t; return true; };
    const deliverableEvent = () => ({ ts: now(), kind: 'deliverable', agentId: null, agentType: null, text: '', title: '' });
    // SNS用の「投稿済み」は postedAt から snsPostedGraceMs 後に掲示板から消す(未投稿に戻せば予約は取り消し)
    const snsTimers = new Map();
    const dropSnsTimer = (id) => { clearTimeout(snsTimers.get(id)); snsTimers.delete(id); };
    const expireSns = (id) => {
      snsTimers.delete(id);
      const d = findDeliverable(state, id);
      if (!d || !d.sns || !d.posted) return;
      removeDeliverable(state, id);
      deliverablePaths.delete(id);
      persistSns();
      broadcastOffice(deliverableEvent());
    };
    const scheduleSnsExpiry = (d) => {
      dropSnsTimer(d.id);
      if (!d.sns || !d.posted || !Number.isFinite(d.postedAt)) return;
      const t = setTimeout(() => expireSns(d.id), Math.max(0, d.postedAt + snsPostedGraceMs - now()));
      t.unref();
      snsTimers.set(d.id, t);
    };
    const scheduleRemove = (id) => {
      clearTimeout(removeTimers.get(id));
      const t = setTimeout(() => {
        removeTimers.delete(id);
        const d = findDeliverable(state, id);
        if (!d || d.status === 'new' || d.status === 'rejected') return;
        const wasSns = d.sns;
        removeDeliverable(state, id);
        deliverablePaths.delete(id);
        if (wasSns) persistSns();
        broadcastOffice(deliverableEvent());
      }, deliverableGraceMs);
      t.unref();
      removeTimers.set(id, t);
    };
  
    // 起動時に、前回までの SNS 用カードを読み込む(パスが今は無効でも残す。開くときに検査し直す)
    try {
      for (const saved of loadSns(snsFile, info.id)) { const d = restoreSnsDeliverable(state, saved); if (d) deliverablePaths.set(d.id, saved.path); }
    } catch { state.snsError = 'SNS用の記録を読み込めませんでした(保存ファイルを確認してください)'; }
    // 猶予を過ぎた投稿済みは起動時に消し、残りは残り時間で予約し直す
    {
      const t0 = now();
      let dropped = false;
      for (const d of [...state.deliverables]) {
        if (!d.sns || !d.posted) continue;
        if (!Number.isFinite(d.postedAt) || t0 - d.postedAt >= snsPostedGraceMs) { removeDeliverable(state, d.id); deliverablePaths.delete(d.id); dropped = true; }
        else scheduleSnsExpiry(d);
      }
      if (dropped) persistSns();
    }

    // 部長(post-deliverable.mjs)が成果物を登録する
    function handleDeliverablePost(req, res) {
      readSmallJson(req, res, DECISION_BODY_MAX, (body) => {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) { res.writeHead(400); res.end(); return; }
        const chk = checkPath(body.path);
        if (!chk.ok) { json(res, 400, { reason: chk.reason }); return; }
        const kind = typeof body.kind === 'string' && KINDS.has(body.kind) ? body.kind : chk.kind;
        const note = typeof body.note === 'string' ? body.note : '';
        const sns = body.sns === true || body.category === 'sns';
        if (body.sns !== undefined && typeof body.sns !== 'boolean') { json(res, 400, { reason: 'sns は true / false で指定してください' }); return; }
        if (body.category !== undefined && typeof body.category !== 'string') { json(res, 400, { reason: 'category が不正です' }); return; }
        let postText = '';
        if (body.postText !== undefined && body.postText !== null) {
          if (typeof body.postText !== 'string') { json(res, 400, { reason: '投稿文が不正です' }); return; }
          postText = body.postText.replace(/\r\n/g, '\n').trim();
          if (Array.from(postText).length > POST_TEXT_MAX) { json(res, 400, { reason: `投稿文は${POST_TEXT_MAX}文字までです` }); return; }
          if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(postText)) { json(res, 400, { reason: '投稿文に使えない文字があります' }); return; }
        }
        if (postText && !sns) { json(res, 400, { reason: '投稿文はSNS用(sns: true)のときだけ付けられます' }); return; }
        const { item, evicted } = addDeliverable(state, { title, kind, fileName: chk.fileName, note, sns, postText }, now());
        deliverablePaths.set(item.id, chk.real);
        for (const id of evicted) { deliverablePaths.delete(id); clearTimeout(removeTimers.get(id)); removeTimers.delete(id); dropVerdict(id); }
        if (sns || evicted.length) persistSns();
        json(res, 201, { id: item.id });
        broadcastOffice(deliverableEvent());
      });
    }
  
    // 承認・差し戻しの猶予タイマーと、差し戻しコメント(メモリのみ。ここ以外に本文を置かない)
    const verdictTimers = new Map(); // deliverableId -> timer
    const rejectComments = new Map(); // deliverableId -> comment
    const dropVerdict = (id) => { clearTimeout(verdictTimers.get(id)); verdictTimers.delete(id); rejectComments.delete(id); };
    const COMMENT_MAX = 300;
  
    // 承認・差し戻しを押した。すぐには確定せず、猶予のあと受信箱へ入れる(取り消せる)
    function beginVerdict(res, d, verdict, comment) {
      const confirmAt = now() + deliverableGraceMs;
      if (inbox.isFull()) { res.writeHead(429); res.end(); return; }
      const r = beginDeliverableVerdict(state, d.id, verdict, comment !== null, confirmAt);
      if (r === 'notfound') { res.writeHead(404); res.end(); return; }
      if (r === 'conflict') { res.writeHead(409); res.end(); return; }
      if (comment !== null) rejectComments.set(d.id, comment); else rejectComments.delete(d.id);
      const id = d.id;
      const t = setTimeout(() => {
        verdictTimers.delete(id);
        const c = rejectComments.get(id) ?? null;
        rejectComments.delete(id);
        const v = confirmDeliverableVerdict(state, id, now());
        if (!v) return;
        // 受信箱(部長だけが読む)には全文。画面・ログ・指示一覧に出す文(view)には差し戻しコメントを伏せる
        const head = v.approved ? '【成果物の承認】' + v.title : '【成果物の差し戻し】' + v.title;
        const text = c !== null ? head + ': ' + c : head;
        const view = c !== null ? head + ': (コメントあり)' : null;
        inbox.enqueue(text, enqueueInstruction(state, view ?? text, now()), view);
        broadcastOffice(deliverableEvent());
      }, deliverableGraceMs);
      t.unref();
      verdictTimers.set(id, t);
      json(res, 200, { id, confirmAt });
      broadcastOffice(deliverableEvent());
    }
  
    // 開く・見た(消す)・元に戻す・承認・差し戻し。id だけを受け、パスはクライアントから受け取らない
    function handleDeliverableAct(req, res, p) {
      // 差し戻しコメントは300文字(日本語で約0.9KB、エスケープ込みでさらに増える)まで受けるので、上限は4KB
      readSmallJson(req, res, 4096, async (body) => {
        try {
          if (typeof body.id !== 'string') { res.writeHead(400); res.end(); return; }
          // 入力の検査は状態の検査より先(不正な入力は 404/409 より 400)
          let comment = null;
          if (p === '/deliverable-reject' && body.comment !== undefined && body.comment !== null) {
            if (typeof body.comment !== 'string') { res.writeHead(400); res.end(); return; }
            if (body.comment.trim() !== '') { // 空白だけ・空文字は「コメントなし」
              comment = validOtherText(body.comment, COMMENT_MAX);
              if (comment === null) { res.writeHead(400); res.end(); return; }
            }
          }
          const d = findDeliverable(state, body.id);
          if (!d) { res.writeHead(404); res.end(); return; }
          if (p === '/deliverable-approve') { beginVerdict(res, d, 'approve', null); return; }
          if (p === '/deliverable-reject') { beginVerdict(res, d, 'reject', comment); return; }
          if (p === '/deliverable-undo') {
            const was = d.status;
            if (!undoDeliverable(state, d.id)) { res.writeHead(409); res.end(); return; }
            if (was === 'approving' || was === 'rejecting') dropVerdict(d.id);
            clearTimeout(removeTimers.get(d.id));
            removeTimers.delete(d.id);
            res.writeHead(204); res.end();
            broadcastOffice(deliverableEvent());
            return;
          }
          if (p === '/deliverable-posted' || p === '/deliverable-unposted') {
            // 社長が自分で投稿した記録。AI は投稿しない。状態(承認など)とは独立
            if (!d.sns) { res.writeHead(409); res.end(); return; }
            setSnsPosted(state, d.id, p === '/deliverable-posted', now());
            if (d.posted) scheduleSnsExpiry(d); else dropSnsTimer(d.id);
            persistSns();
            res.writeHead(204); res.end();
            broadcastOffice(deliverableEvent());
            return;
          }
          if (p === '/deliverable-dismiss' && d.status !== 'new' && d.status !== 'rejected' || p === '/deliverable-dismiss' && d.sns && d.status !== 'rejected') { res.writeHead(409); res.end(); return; }
          // 開けるのは new / opened と、確定済み(承認済み・差し戻し済み)の履歴。猶予中・消したものは 409
          if (p === '/deliverable-open' && !['new', 'opened', 'approved', 'rejected'].includes(d.status)) { res.writeHead(409); res.end(); return; }
          if (p === '/deliverable-dismiss') {
            markDeliverable(state, d.id, 'dismissed', now(), now() + deliverableGraceMs);
            scheduleRemove(d.id);
            res.writeHead(204); res.end();
            broadcastOffice(deliverableEvent());
            return;
          }
          // open: 開く直前に、登録時と同じ検証をもう一度(差し替え・リンク化への備え)
          const t = now();
          if (t - lastOpenAt < openMinIntervalMs) { res.writeHead(429); res.end(); return; }
          const stored = deliverablePaths.get(d.id);
          const chk = stored ? checkPath(stored) : { ok: false };
          if (!chk.ok || chk.real !== stored) { json(res, 409, { reason: 'ファイルを開けません(移動・変更された可能性があります)' }); return; }
          lastOpenAt = t;
          if (!(await opener(chk.real))) { res.writeHead(502); res.end(); return; }
          noteDeliverableOpened(state, d.id, now()); // 消さずに残す(承認・差し戻しを待つ)
          res.writeHead(204); res.end();
          broadcastOffice(deliverableEvent());
        } catch {
          if (!res.headersSent) res.writeHead(400);
          res.end();
        }
      });
    }
    // 部長が open / terminal のカードを回答済みにする(choice は画面のクリックで答える)
    function handleDecisionResolve(req, res) {
      readSmallJson(req, res, 1024, (body) => {
        if (typeof body.id !== 'string') { res.writeHead(400); res.end(); return; }
        const r = resolveDecision(state, body.id);
        if (r === 'notfound') { res.writeHead(404); res.end(); return; }
        if (r === 'conflict') { res.writeHead(409); res.end(); return; }
        res.writeHead(204); res.end();
        broadcastOffice(decisionEvent());
      });
    }
  
    function handleAnswerCancel(req, res) {
      readSmallJson(req, res, 1024, (body) => {
        if (typeof body.id !== 'string') { res.writeHead(400); res.end(); return; }
        const r = cancelDecisionChoice(state, body.id);
        if (r === 'notfound') { res.writeHead(404); res.end(); return; }
        if (r === 'conflict') { res.writeHead(409); res.end(); return; }
        clearTimeout(confirmTimers.get(body.id));
        confirmTimers.delete(body.id);
        res.writeHead(204); res.end();
        broadcastOffice(decisionEvent());
      });
    }
    function handleInstructionNext(req, res, url) {
      if (crossSite(req)) { res.writeHead(403); res.end(); return; }
      const wasListening = inbox.listening();
      const waitSec = url.searchParams.has('wait') ? Number(url.searchParams.get('wait')) : 25;
      inbox.listen(res, waitSec, {
        timeout: () => { res.writeHead(204); res.end(); },
        deliver: (item) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ id: item.id, text: item.text, ts: item.ts, ...(item.source ? { source: item.source } : {}) }));
          const shown = item.view ?? item.text; // 画面・ログに出す文(「その他」の入力文は伏せてある)
          // hook の UserPromptSubmit が動かない通知起動の作業でも、通常の依頼と同じ動きにする
          const ev = { ts: now(), kind: 'prompt', agentId: null, agentType: null, text: promptText(shown), title: shorten(shown, 40), body: clipInstruction(shown), source: 'office', instrId: item.ref, transcriptPath: null, agentTranscriptPath: null };
          meter.resetTurn();
          applyEvent(state, ev);
          scheduleAssignBubble();
          addLog(state, ev.ts, '社長', `社長の指示: ${shorten(shown, 30)}`);
          broadcastOffice(ev);
        },
      });
      if (!wasListening) broadcastOffice({ ts: now(), kind: 'inbox', agentId: null, agentType: null, text: '', title: '' });
    }
    return {
      id: info.id,
      info,
      state,
      inbox,
      openGate,
      snap,
      ingest,
      handleInstructionPost, handleAnswerRead, handleDecisionPost, handleAnswerPost, handleAnswerCancel, handleDecisionResolve, handleDeliverablePost, handleDeliverableAct, handleInstructionNext,
      close() {
        inbox.closeAll();
        for (const t of assignTimers) clearTimeout(t);
        assignTimers.clear();
        for (const t of removeTimers.values()) clearTimeout(t);
        removeTimers.clear();
        for (const t of snsTimers.values()) clearTimeout(t);
        snsTimers.clear();
        for (const t of confirmTimers.values()) clearTimeout(t);
        confirmTimers.clear();
      },
    };
  }
  const projects = new Map([...registry.values()].map((info) => [info.id, makeProject(info)]));

  // フックからのイベント。許可リスト・伏せ字を通し、宣言(project、無ければ demo)を登録済みの id と照合し、
  // hook 入力の cwd / transcript_path から導いたプロジェクトと食い違えば捨てる
  function handleEventPost(req, res) {
    const h = req.headers;
    // ブラウザ経由の他サイトからの注入を断る(hook は Origin を付けない)
    if (h.origin !== undefined || (h['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(h['sec-fetch-site']))) {
      res.writeHead(403); res.end(); return;
    }
    if (!/^application\/json\s*(;|$)/i.test(String(h['content-type'] ?? ''))) {
      res.writeHead(415); res.end(); return;
    }
    const reject413 = () => { res.writeHead(413, { Connection: 'close' }); res.end(() => setTimeout(() => req.destroy(), 100).unref()); }; // 即座に切ると 413 が相手に届く前にリセットされる
    if (Number(h['content-length']) > BODY_MAX) return reject413();
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      size += c.length;
      if (size > BODY_MAX) {
        rejected = true;
        reject413();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        let raw;
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { raw = null; }
        const ev = sanitizeEvent(raw); // source / instrId など内部用の項目もここで落ちる
        if (!ev) { res.writeHead(400); res.end(); return; }
        const declared = ev.project ?? DEFAULT_PROJECT;
        const proj = typeof declared === 'string' ? projects.get(declared) : undefined;
        if (!proj) { res.writeHead(404); res.end(); return; }
        if (projectsFromOrigin(registry, allowedRoot, { cwd: ev.cwd, transcriptPath: ev.transcriptPath }).some((id) => id !== proj.id)) { res.writeHead(409); res.end(); return; }
        delete ev.project;
        delete ev.cwd;
        proj.ingest(ev, res);
      } catch {
        // 'end' はルーターの try/catch の外なので、ここで止めないとプロセスごと落ちる
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
    });
  }

  function route(req, res, isRemote = false) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // プロジェクトは ?project=(省略は demo)。登録されていなければ、プロジェクトごとの経路は 404
    const proj = projects.get(url.searchParams.get('project') ?? DEFAULT_PROJECT);
    // 指示の送受信は PC 側(127.0.0.1)だけ。遠隔は合言葉があっても常に 403
    if (isRemote && ((p === '/instruction' && req.method !== 'POST') || p.startsWith('/instruction/') || p === '/answer-read' || p === '/decision' || p === '/answer' || p === '/answer-cancel' || p === '/decision-resolve' || p === '/deliverable' || p === '/deliverable-open' || p === '/deliverable-undo' || p === '/deliverable-dismiss' || p === '/deliverable-approve' || p === '/deliverable-reject' || p === '/deliverable-posted' || p === '/deliverable-unposted' || p === '/commands' || p === '/command' || p === '/tree')) { res.writeHead(403); res.end(); return; }
    if (isRemote) {
      if (!remote || !remoteGate(req, res, url)) return;
      if (p === '/health' || p === '/remote-info' || LOCAL_ONLY_ROUTES.some(([pre]) => p.startsWith(pre))) { res.writeHead(404); res.end(); return; }
    } else {
      const hostHeader = String(req.headers.host ?? '');
      if (hostHeader !== `127.0.0.1:${listenPort}` && hostHeader !== `localhost:${listenPort}`) {
        res.writeHead(403); res.end(); return;
      }
    }
    if (req.method === 'GET' && p === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: clients.size, pid: process.pid }));
    } else if (req.method === 'POST' && p === '/event') {
      handleEventPost(req, res);
    } else if (req.method === 'POST' && p === '/instruction') {
      if (proj) proj.handleInstructionPost(req, res, isRemote); else notFound(res);
    } else if (req.method === 'POST' && p === '/answer-read') {
      if (proj) proj.handleAnswerRead(req, res); else notFound(res);
    } else if (req.method === 'POST' && p === '/decision') {
      if (proj) proj.handleDecisionPost(req, res); else notFound(res);
    } else if (req.method === 'POST' && p === '/deliverable') {
      if (proj) proj.handleDeliverablePost(req, res); else notFound(res);
    } else if (req.method === 'POST' && (p === '/deliverable-open' || p === '/deliverable-undo' || p === '/deliverable-dismiss' || p === '/deliverable-approve' || p === '/deliverable-reject' || p === '/deliverable-posted' || p === '/deliverable-unposted')) {
      if (proj) proj.handleDeliverableAct(req, res, p); else notFound(res);
    } else if (req.method === 'POST' && p === '/decision-resolve') {
      if (proj) proj.handleDecisionResolve(req, res); else notFound(res);
    } else if (req.method === 'POST' && p === '/answer') {
      if (proj) proj.handleAnswerPost(req, res); else notFound(res);
    } else if (req.method === 'POST' && p === '/answer-cancel') {
      if (proj) proj.handleAnswerCancel(req, res); else notFound(res);
    } else if (req.method === 'POST' && p === '/tts') {
      handleTtsPost(req, res, isRemote);
    } else if (req.method === 'POST' && p === '/command') {
      handleCommandPost(req, res);
    } else if (req.method === 'GET' && p === '/commands') {
      if (crossSite(req)) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(runner.list()));
    } else if (req.method === 'GET' && p === '/tree') {
      if (crossSite(req)) { res.writeHead(403); res.end(); return; }
      const r = proj?.info.root ? listTree(proj.info.root, url.searchParams.get('path') ?? '') : { status: 404 };
      res.writeHead(r.status, r.body ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {});
      res.end(r.body ? JSON.stringify(r.body) : undefined);
    } else if (req.method === 'GET' && p === '/instruction/next') {
      if (proj) proj.handleInstructionNext(req, res, url); else notFound(res);
    } else if (req.method === 'GET' && p === '/projects') {
      // 登録済みプロジェクトの一覧(表示名・色だけ。ルートのパスは出さない)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify([...projects.values()].map(({ info }) => ({ id: info.id, name: info.name, color: info.color }))));
    } else if (req.method === 'GET' && p === '/remote-info') {
      if (!remoteAllowed) { res.writeHead(404); res.end(); return; } // 遠隔が無効(OFFICE_REMOTE=1 なし)なら口ごと無い
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ url: remote ? `http://${remote.host}:${remote.port}/?k=${remote.token}` : null }));
    } else if (req.method === 'GET' && p === '/events') {
      if (!proj) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      send(res, 'snapshot', proj.snap(isRemote));
      clients.set(res, { remote: isRemote, project: proj.id });
      req.on('close', () => clients.delete(res));
    } else if (req.method === 'GET') {
      if (p === '/') return serveFile(res, 'public', 'index.html');
      for (const [prefix, root] of [...STATIC_ROUTES, ...(isRemote ? [] : LOCAL_ONLY_ROUTES)]) {
        if (p.startsWith(prefix) && p.length > prefix.length) {
          let rel;
          try { rel = decodeURIComponent(p.slice(prefix.length)); } catch { return notFound(res); }
          return serveFile(res, root, rel);
        }
      }
      if (!dispatchExt(req, res, url, proj, isRemote)) notFound(res);
    } else {
      if (!dispatchExt(req, res, url, proj, isRemote)) { res.writeHead(405); res.end(); }
    }
  }

  // 遠隔用の待ち受けを足す。host はこの PC の Tailscale の宛先だけを渡す(0.0.0.0 は断る)
  function enableRemote({ host: rHost, token, generation = 0, allowedHosts = [], port: rPort = listenPort }) {
    if (remote || !remoteAllowed) return Promise.resolve(false);
    if (!rHost || rHost === '0.0.0.0' || rHost === '::' || typeof token !== 'string' || token.length < 16) return Promise.resolve(false);
    const rs = http.createServer(handler(true));
    return new Promise((resolve) => {
      rs.once('error', () => resolve(false));
      rs.listen(rPort, rHost, () => {
        remote = { host: rHost, token, generation: Number.isInteger(generation) && generation > 0 ? generation : 0, allowedHosts, port: rs.address().port, server: rs };
        resolve(true);
      });
    });
  }

  return extReady.then(() => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      listenPort = server.address().port;
      resolve({
        port: listenPort,
        enableRemote,
        remotePort: () => remote?.port ?? null,
        close: () => new Promise((r) => {
          for (const proj of projects.values()) proj.close();
          for (const c of clients.keys()) c.end();
          clients.clear();
          remote?.server.close();
          remote?.server.closeAllConnections();
          server.close(() => r());
          server.closeAllConnections();
        }),
      });
    });
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.OFFICE_PORT ?? 4317);
  // 3D 表示に使う three が無いと画面が真っ白になる。起動前に案内して止める
  if (!fs.existsSync(path.join(here, 'node_modules', 'three'))) {
    console.error('node_modules がありません(または不完全です)。このフォルダで `npm ci` を実行してから、もう一度起動してください。');
    process.exit(1);
  }
  let handle;
  try {
    handle = await startServer({ port, narrowTranscripts: true });
  } catch (e) {
    if (e?.code === 'EADDRINUSE') console.error(`${port}は使用中です。OFFICE_PORT=… で変更してください(hookやtoolsにも同じ指定が必要)。すでに起動していないかも確認してください。`);
    else if (e?.code === 'ERR_MODULE_NOT_FOUND') console.error(`必要なモジュールが見つかりません。\`npm ci\` を実行してください: ${e.message}`);
    else console.error(`起動できませんでした: ${e?.message ?? e}`);
    process.exit(1);
  }
  console.log(`Mimamori: http://127.0.0.1:${handle.port}/`);
  if (isRemoteEnabled()) {
    console.log('Mimamori: スマホ用の遠隔は有効です(OFFICE_REMOTE=1)。Tailscale が見つかると URL と合言葉が出ます。人に見せないでください');
    startRemoteWatcher(handle, here);
  } else {
    console.log('Mimamori: スマホ用の遠隔は無効です(127.0.0.1 のみ)。有効にするには環境変数 OFFICE_REMOTE=1');
  }
}
