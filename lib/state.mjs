const LOG_MAX = 500;
const BOARD_MAX = 50;
const DECISION_MAX = 20;
const BUCHO = 'bucho';
const INSTRUCTIONS_MAX = 10;
const ANSWERS_MAX = 10;
const ANSWER_A_MAX = 300;
const ASSIGNING_TEXT = 'タスクを振っています';
const HELPER_NAME = '応援スタッフ'; // 旧形式(helperSeats あり)の互換用。既定では席を作らない
const FALLBACK_SEAT = 'general-purpose'; // 名簿にない種類の担当を受ける席
const ACTIVITY_MAX = 200;
const TALK_MAX = 100;
const TALK_TEXT_MAX = 1500;
const SUBJECT_MAX = 40;
const ACTIVITY_TEXT_MAX = 120;
const TOOL_ARG_MAX = 80;
// 検証・レビューを役目とする担当。動いている間は「レビュー中」(hook で判る事実だけ)
const REVIEWER_TYPES = new Set(['qa-tester', 'domain-reviewer', 'cost-auditor', 'numbers-checker', 'deliverable-reviewer', 'privacy-checker', 'compliance-checker', 'pc-impact-checker', 'access-auditor']);
// 担当の完了直後に部長がこれらを使っている間を、部長のレビューとみなす
const REVIEW_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell']);

import { sanitizeQuestions, shorten, clipInstruction, clipListText, stopText } from './describe.mjs';

const seatIdOf = (m) => m.seat ?? m.type;
const typesOf = (m) => (Array.isArray(m.types) && m.types.length ? m.types : [m.type]);
// helperSeats は数(旧形式)でも [{ nickname }] でもよい。無い・0 なら席を作らない
const helperList = (roster) => {
  const h = roster.helperSeats ?? 0;
  return Array.isArray(h) ? h.map((x, i) => ({ nickname: x?.nickname ?? `応援${i + 1}` })) : Array.from({ length: h }, (_, i) => ({ nickname: `応援${i + 1}` }));
};
const memberOf = (state, type) => (type ? state.roster.members.find((m) => typesOf(m).includes(type)) : undefined);

export function createState(roster) {
  const seats = new Map();
  for (const m of roster.members) {
    const id = seatIdOf(m);
    seats.set(id, { seat: id, type: m.type, name: m.name, role: m.name, nickname: m.nickname ?? m.name, dept: m.dept, status: 'idle', bubble: '', busy: false, count: 0, cardId: null, progress: null });
  }
  for (const [i, h] of helperList(roster).entries()) {
    seats.set(`helper-${i + 1}`, { seat: `helper-${i + 1}`, type: null, name: HELPER_NAME, role: HELPER_NAME, nickname: h.nickname, dept: 'support', status: 'idle', bubble: '', busy: false, count: 0, cardId: null, progress: null });
  }
  return {
    roster,
    seats,
    board: [],
    decisions: [], // 社長への質問(メモリのみ。答えの中身は扱わない)
    nextDecisionId: 1,
    counters: { tools: 0, delegates: 0, startedAt: null },
    log: [],
    agentCards: new Map(), // agentId -> その担当のカードid
    pending: [], // delegate 済みで、担当自身のイベントがまだ届いていない席
    orphans: [], // 担当の SubagentStart が先に届き、対応する delegate がまだ来ていない席 { agentId, type, seat, cardId }
    delegateSeq: 0, // 委任の通し番号(画面が「委任があった」ことを到着順に依存せず知るため)
    lastDelegation: null, // 直近の委任 { seq, type, seat, ts }。本文は含めない
    bindings: new Map(), // agentId -> seat
    overflow: new Set(), // 席に座れなかった agentId(以後のイベントは無視)
    instruction: null, // 社長の直近の指示(メモリのみ。本文はログに出さない)
    instructions: [], // 指示の一覧(最新10件・古い順。メモリのみ)
    nextInstructionId: 1,
    promptBubble: null, // 直近の「指示を受けました」の吹き出し(まだ書き換わっていないかの判定用)
    promptCardId: null,
    nextCardId: 1,
    answers: [], // 回答掲示板(新しい順・最新10件。メモリのみ)
    nextAnswerId: 1,
    quota: null, // 利用枠(メモリのみ)。{ fiveHour, sevenDay, updatedAt }
    activity: [], // 活動ログ(新しい順・最新200件。メモリのみ。PC側の snapshot にだけ載せる)
    review: null, // 担当の完了後の部長レビュー { cardId, target, by, file, since }。since が null の間は未着手
    reviewerSince: new Map(), // agentId -> レビュー担当が動き出した ts
    deliverables: [], // 成果物ボード(確認用リンク。メモリのみ。パスは持たない=サーバー側の別表)
    nextDeliverableId: 1,
    talk: [], // ターミナルでの部長の発言(古い順・最新100件。メモリのみ。PC側の snapshot にだけ載せる)
    waiting: null, // Notification 由来の確認待ち { kind, text, detail, since }。質問(decisions)は snapshot 時に導く
    heldStop: false, // 部長が応答を終えたが担当がまだ動いている(完了を保留中)
    lastEventTs: null, // 最後のイベントの ts(保険の時間切れ判定用)
    lastTool: null, // 直近の tool イベントの { toolName, toolArg }。許可確認の中身の推定用
  };
}

const nickOf = (state, type) => (memberOf(state, type) ?? memberOf(state, FALLBACK_SEAT))?.nickname ?? HELPER_NAME;
const nameOf = (state, type) => (memberOf(state, type) ?? memberOf(state, FALLBACK_SEAT))?.name ?? HELPER_NAME;

const clipChars = (v, n) => [...String(v ?? '').replace(/\s*\n\s*/g, ' ').trim()].slice(0, n).join('');
const fileOnly = (v) => String(v ?? '').split(/[\\/]/).pop();

function addActivity(state, ts, who, kind, text) {
  state.activity.unshift({ ts, who, kind, text: clipChars(text, ACTIVITY_TEXT_MAX) });
  if (state.activity.length > ACTIVITY_MAX) state.activity.length = ACTIVITY_MAX;
}

// ツールの中身は「Bash: コマンドの先頭」「Read: ファイル名」だけ。出力・本文は載せない
function toolActivityText(ev) {
  const name = typeof ev.toolName === 'string' ? clipChars(ev.toolName, 30) : '';
  if (!name) return ev.text ?? '';
  const arg = typeof ev.toolArg === 'string' ? clipChars(/^(Bash|PowerShell)$/.test(name) ? ev.toolArg : fileOnly(ev.toolArg), TOOL_ARG_MAX) : '';
  return arg ? `${name}: ${arg}` : name;
}

const reviewLabel = (nickname, title) => (title ? `${nickname}『${shorten(title, 30)}』` : nickname);

export function addLog(state, ts, who, text) {
  state.log.push({ ts, who, text });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}

// 席を決めて同時に動く人数(count)を+1する。専属席が空いていればそこ。使用中なら(旧形式の)空き応援席、
// 無ければ同じ席に重ねて座る(count が増えるだけ)。名簿にない種類は万能担当の席。席が無ければ null
function takeSeat(state, type) {
  const m = type && type !== BUCHO ? memberOf(state, type) : null;
  const own = state.seats.get(m ? seatIdOf(m) : FALLBACK_SEAT) ?? null;
  const helper = [...state.seats.values()].find((s) => s.seat.startsWith('helper-') && !s.busy);
  const seat = own && (!own.busy || !helper) ? own : helper;
  if (!seat) return null;
  seat.busy = true;
  seat.count++;
  if (seat.seat.startsWith('helper-')) { seat.name = nameOf(state, type); seat.role = seat.name; }
  return seat;
}

// 件名: 最初の空でない1行を40字まで。取れなければ空文字
export function subject(v, n = SUBJECT_MAX) {
  const line = String(v ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l);
  return line ? [...line].slice(0, n).join('') : '';
}

// カードの件名。取れる順: 指定の件名 → 代わりの文(指示本文・依頼の中身) → 担当名+役割(本当に取れないときだけ)
function titleFor(title, alt, fallback) {
  // 明示の件名は(hook が付けた「…」を含め)そのまま使う。空白だけなら代わりの文へ
  return (typeof title === 'string' && title.trim()) || subject(alt) || fallback;
}

function addCard(state, title, owner) {
  const id = `c${state.nextCardId++}`;
  state.board.push({ id, title: title ?? '', owner, column: 'working' });
  while (state.board.length > BOARD_MAX) {
    const i = state.board.findIndex((c) => c.column === 'done');
    state.board.splice(i >= 0 ? i : 0, 1);
  }
  return id;
}

const card = (state, id) => state.board.find((c) => c.id === id);

// 進捗(TodoWrite 由来の実データだけ)。席と、その担当のカードに同じ % を持たせる
function setProgress(state, seat, cardId, p) {
  seat.progress = p;
  const c = card(state, cardId);
  if (c) { if (p) c.pct = p.pct; else delete c.pct; }
}
function clearProgress(state, seat) {
  if (!seat.progress) return;
  const ids = seat.seat === BUCHO ? [state.promptCardId] : [seat.cardId, ...state.agentCards.values()];
  seat.progress = null;
  for (const id of ids) { const c = card(state, id); if (c) delete c.pct; }
}

function seatFor(state, ev) {
  if (!ev.agentId) return state.seats.get(BUCHO);
  if (state.overflow.has(ev.agentId)) return null;
  const bound = state.bindings.get(ev.agentId);
  if (bound) return bound;
  const type = ev.agentType ?? 'general-purpose';
  const i = state.pending.findIndex((p) => p.type === type);
  let seat;
  let cardId = null;
  if (i >= 0) ({ seat, cardId } = state.pending.splice(i, 1)[0]);
  else {
    seat = takeSeat(state, type);
    if (seat) {
      seat.status = 'working';
      cardId = seat.cardId = addCard(state, titleFor(ev.title, ev.body, `${seat.name}の作業`), seat.name);
      state.orphans.push({ agentId: ev.agentId, type, seat, cardId }); // hook は非同期で順不同: 後から来る delegate がこの席を引き継ぐ
    }
  }
  if (!seat) {
    state.overflow.add(ev.agentId);
    addLog(state, ev.ts, nameOf(state, type), '席が足りず座れません');
    return null;
  }
  state.bindings.set(ev.agentId, seat);
  if (REVIEWER_TYPES.has(seat.type)) state.reviewerSince.set(ev.agentId, ev.ts);
  if (cardId) state.agentCards.set(ev.agentId, cardId);
  return seat;
}

// 委任の通し番号と委任先の席を、状態とイベント(ev.delegation)に残す。画面は到着順に関係なくこれで知る
function noteDelegation(state, ev, type, seatId) {
  const d = { seq: ++state.delegateSeq, type, seat: seatId, ts: typeof ev.ts === 'number' ? ev.ts : null };
  state.lastDelegation = d;
  ev.delegation = { seq: d.seq, type: d.type, seat: d.seat };
}

// 部長自身の次のイベントが来た = 質問はターミナルで答えられた、とみなす
// 画面から答える(source:'office')カードは、部長が裏で作業を続けても答えられたことにしない
function answerPending(state) {
  for (const d of state.decisions) if (d.status === 'pending' && d.source !== 'office') d.status = 'answered';
}

function addDecisions(state, questions, ts) {
  for (const q of questions) state.decisions.push({ id: `d${state.nextDecisionId++}`, ...q, source: 'hook', status: 'pending', askedAt: ts });
  while (state.decisions.length > DECISION_MAX) {
    const i = state.decisions.findIndex((d) => d.status === 'answered');
    state.decisions.splice(i >= 0 ? i : 0, 1);
  }
}

const OFFICE_DECISION_OPEN_MAX = 5;

export const DECISION_MODES = ['choice', 'open', 'terminal'];

// post-decision.mjs 由来のカード。質問1件だけ受ける。
// mode: choice(既定。選択肢2〜4個をクリックで答える)/ open(自由記入の依頼。選択肢0〜4個)/ terminal(ターミナルで答える承認事項。選択肢0〜4個)。
// 不正なら null、開いたままが多すぎれば 'full'
export function addOfficeDecision(state, raw, ts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mode = raw.mode === undefined ? 'choice' : raw.mode;
  if (!DECISION_MODES.includes(mode)) return null;
  if (raw.allowOther !== undefined && typeof raw.allowOther !== 'boolean') return null;
  const [q] = sanitizeQuestions([{ ...raw, multiSelect: false }]);
  if (!q || (mode === 'choice' && q.options.length < 2)) return null;
  const open = state.decisions.filter((d) => d.source === 'office' && d.status === 'pending').length;
  if (open >= OFFICE_DECISION_OPEN_MAX) return 'full';
  const id = `d${state.nextDecisionId++}`;
  // other: 「その他」の自由記入(メモリのみ。snapshot・ログには出さない)。allowOther は choice のカードだけ意味を持つ
  state.decisions.push({ id, ...q, source: 'office', mode, allowOther: mode === 'choice' && raw.allowOther !== false, choice: null, other: null, confirmAt: null, status: 'pending', askedAt: ts });
  while (state.decisions.length > DECISION_MAX) {
    const i = state.decisions.findIndex((d) => d.status === 'answered');
    state.decisions.splice(i >= 0 ? i : 0, 1);
  }
  const bucho = state.seats.get(BUCHO);
  bucho.status = 'waiting';
  bucho.bubble = 'ご判断をお待ちしています';
  const c = card(state, state.promptCardId);
  if (c) c.column = 'waiting';
  addLog(state, ts, '部長', '社長のご確認待ち(画面に表示)'); // 通知ログは遠隔にも載るので、質問の本文は入れない
  return id;
}

// 選択肢をクリックした。取り消し猶予の間は pending のまま choice と confirmAt を持つ。
// 戻り値: 'ok' | 'notfound' | 'invalid'(整数でない・範囲外) | 'conflict'(回答済み・選択中・画面で答えられないカード)
export function chooseDecision(state, id, choice, confirmAt) {
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return 'notfound';
  if (d.source !== 'office' || d.mode !== 'choice') return 'conflict'; // クリックで答えられるのは choice だけ
  if (!Number.isInteger(choice) || choice < 0 || choice >= d.options.length) return 'invalid';
  if (d.status !== 'pending' || d.choice !== null || d.other !== null) return 'conflict';
  d.choice = choice;
  d.confirmAt = confirmAt;
  return 'ok';
}

export const OTHER_MAX = 500;

// 「その他」の入力文を検査して返す。不正なら null。前後の空白を除き、1〜500文字(サロゲートペアは1文字)。
// 改行は許可(CRLF は LF にそろえる)。タブ・その他の制御文字、壊れたサロゲート、行/段落区切りは拒否
export function validOtherText(v, max = OTHER_MAX) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim();
  let n = 0;
  for (const ch of t) { // for-of はサロゲートペアを1文字にまとめる。壊れたサロゲートは単独の半端な文字として出てくる
    const c = ch.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) return null;
    if (c === 0x0a) { n++; continue; }
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return null;
    n++;
  }
  return n >= 1 && n <= max ? t : null;
}

// 「その他」で答えた。猶予・取り消し・確定は choice と同じ。戻り値は chooseDecision と同じ
// 'invalid': 入力文が不正、または allowOther:false のカード
export function chooseDecisionOther(state, id, other, confirmAt) {
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return 'notfound';
  if (d.source !== 'office' || d.mode !== 'choice') return 'conflict';
  const t = validOtherText(other);
  if (t === null || d.allowOther === false) return 'invalid';
  if (d.status !== 'pending' || d.choice !== null || d.other !== null) return 'conflict';
  d.other = t;
  d.confirmAt = confirmAt;
  return 'ok';
}

// 取り消し。選択中でなければ 'conflict'
export function cancelDecisionChoice(state, id) {
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return 'notfound';
  if (d.source !== 'office' || d.status !== 'pending' || (d.choice === null && d.other === null)) return 'conflict';
  d.choice = null;
  d.other = null;
  d.confirmAt = null;
  return 'ok';
}

// 猶予が過ぎたので確定する。受信箱に入れる文を返す(選択中でなければ null)
export function confirmDecision(state, id) {
  const d = state.decisions.find((x) => x.id === id);
  if (!d || d.source !== 'office' || d.status !== 'pending' || (d.choice === null && d.other === null)) return null;
  d.status = 'answered';
  const head = d.header || shorten(d.question, 20);
  addLog(state, d.confirmAt ?? d.askedAt, '社長', 'ご判断を受け取りました'); // 入力文はログに入れない
  if (d.other !== null) {
    d.answeredOther = true;
    const text = `【判断への回答】${head}: その他: ${d.other}`;
    d.other = null; // 本文はここで受信箱用の文字列に渡したら、カードには残さない
    return text;
  }
  return `【判断への回答】${head}: ${d.options[d.choice].label}`;
}

// 部長が「ターミナルで答えてもらった」「答えを受け取った」と、open / terminal のカードを回答済みにする
export function resolveDecision(state, id) {
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return 'notfound';
  if (d.source !== 'office' || d.mode === 'choice' || d.status !== 'pending') return 'conflict';
  d.status = 'answered';
  return 'ok';
}

// ターミナルでの社長の入力(UserPromptSubmit)があった = terminal モードの未解決カードへの回答とみなして閉じる。
// 対象は office 由来の terminal だけ(choice / open は画面で答える)。変えた件数を返す
export function resolveTerminalDecisions(state) {
  let n = 0;
  for (const d of state.decisions) if (d.source === 'office' && d.mode === 'terminal' && d.status === 'pending') { d.status = 'answered'; d.closedByTerminal = true; n++; }
  return n;
}

// 画面の入力欄から指示が届いた = 未回答の open カードへの回答とみなす(どの質問への返事かは分からないので全部)。変えた件数を返す
export function replyOpenDecisions(state) {
  let n = 0;
  for (const d of state.decisions) if (d.source === 'office' && d.mode === 'open' && d.status === 'pending') { d.status = 'answered'; n++; }
  return n;
}

const DELIVERABLE_MAX = 30;
const DELIVERABLE_TITLE_MAX = 60;
const DELIVERABLE_NOTE_MAX = 80;

// 成果物を登録する。item: { title, kind, fileName, note }(検証済み)。直近30件を超えたら、確認済みの古いものから削る。
// 戻り値: { item, evicted: 追い出した id の配列 }
export function addDeliverable(state, item, ts) {
  const d = {
    id: `v${state.nextDeliverableId++}`,
    title: clipChars(item.title, DELIVERABLE_TITLE_MAX),
    kind: item.kind,
    fileName: clipChars(item.fileName, 120),
    note: clipChars(item.note ?? '', DELIVERABLE_NOTE_MAX),
    createdAt: ts,
    status: 'new',
    openedAt: null,
    removeAt: null,
    confirmAt: null, // approving / rejecting(取り消し猶予中)のときだけ
    approvedAt: null,
    rejectedAt: null,
    rejectedHasComment: false, // 差し戻しコメントの本文は持たない(サーバー側の別表。メモリのみ)
    prev: null, // 猶予中に取り消したとき戻る状態(snapshot には出さない)
    sns: item.sns === true, // SNS用(Xなどに社長が自分で投稿するもの)
    postText: item.sns === true ? String(item.postText ?? '') : '', // 投稿文の下書き(検査済み)
    posted: false, // 社長が投稿した記録(AIは投稿しない)
    postedAt: null,
  };
  state.deliverables.push(d);
  const evicted = [];
  while (state.deliverables.length > DELIVERABLE_MAX) {
    // 登録は拒まない。履歴(承認済み・差し戻し済み・消したもの)の古い順 → 開いただけのもの → やむなく最も古いもの
    // SNS用は投稿の記録なので、通常の成果物を先に削る(SNS用は最後の手段で、投稿済み → 古い順)
    const plain = (x) => !x.sns;
    let i = state.deliverables.findIndex((x) => plain(x) && (x.status === 'approved' || x.status === 'rejected' || x.status === 'dismissed'));
    if (i < 0) i = state.deliverables.findIndex((x) => plain(x) && x.status === 'opened');
    if (i < 0) i = state.deliverables.findIndex((x) => plain(x) && x.status === 'new');
    if (i < 0) i = state.deliverables.findIndex((x) => x.sns && x.posted);
    if (i < 0) i = 0;
    evicted.push(state.deliverables.splice(i, 1)[0].id);
  }
  return { item: d, evicted };
}

export const POST_TEXT_MAX = 300;
const KINDS_OK = new Set(['video', 'pdf', 'pptx', 'xlsx', 'html', 'doc', 'image', 'other']);
const clipPost = (v) => [...String(v ?? '')].slice(0, POST_TEXT_MAX).join('');

// 保存済みの SNS 用カードを読み込む(承認の状態は保存しないので new に戻る)。id の重複は無視
export function restoreSnsDeliverable(state, saved) {
  if (findDeliverable(state, saved.id)) return null;
  const n = Number(String(saved.id).replace(/^v/, ''));
  if (Number.isInteger(n) && n >= state.nextDeliverableId) state.nextDeliverableId = n + 1;
  const d = {
    id: String(saved.id), title: clipChars(saved.title, DELIVERABLE_TITLE_MAX), kind: KINDS_OK.has(saved.kind) ? saved.kind : 'other', fileName: clipChars(saved.fileName, 120), note: clipChars(saved.note ?? '', DELIVERABLE_NOTE_MAX),
    createdAt: Number.isFinite(saved.createdAt) ? saved.createdAt : 0, status: 'new', openedAt: null, removeAt: null, confirmAt: null, approvedAt: null, rejectedAt: null, rejectedHasComment: false, prev: null,
    sns: true, postText: clipPost(saved.postText), posted: saved.posted === true, postedAt: saved.posted === true && Number.isFinite(saved.postedAt) ? saved.postedAt : null,
  };
  state.deliverables.push(d);
  return d;
}

// 投稿済みにする・未投稿に戻す(SNS用だけ)。戻り値: 変えたカード | null
export function setSnsPosted(state, id, posted, ts) {
  const d = findDeliverable(state, id);
  if (!d || !d.sns) return null;
  d.posted = posted === true;
  d.postedAt = d.posted ? ts : null;
  return d;
}

export const findDeliverable = (state, id) => state.deliverables.find((d) => d.id === id) ?? null;

// 開いた・見た(消す)。removeAt まで「元に戻す」ができる。new のものだけ
export function markDeliverable(state, id, status, ts, removeAt) {
  const d = findDeliverable(state, id);
  if (!d) return false;
  // 差し戻し済みは「消す」だけ受け付ける(元に戻すときは prev へ)
  if (d.status === 'rejected' && status === 'dismissed') d.prev = 'rejected';
  else if (d.status !== 'new') return false;
  d.status = status;
  d.openedAt = status === 'opened' ? ts : null;
  d.removeAt = removeAt;
  return true;
}

// 開いた時刻を記録する(開くたびに呼んでよい。確定済みのカードの状態は変えない)。new のものだけ opened にする
export function noteDeliverableOpened(state, id, ts) {
  const d = findDeliverable(state, id);
  if (!d || d.status !== 'new') return false;
  d.status = 'opened';
  d.openedAt = ts;
  return true;
}

// 承認・差し戻しの押下。new / opened のものだけ approving / rejecting にし、confirmAt まで取り消せる
// 戻り値: 'ok' | 'notfound' | 'conflict'
export function beginDeliverableVerdict(state, id, verdict, hasComment, confirmAt) {
  const d = findDeliverable(state, id);
  if (!d) return 'notfound';
  if (d.status !== 'new' && d.status !== 'opened') return 'conflict';
  d.prev = d.status;
  d.status = verdict === 'approve' ? 'approving' : 'rejecting';
  d.confirmAt = confirmAt;
  d.rejectedHasComment = verdict === 'reject' && hasComment === true;
  return 'ok';
}

// 猶予が過ぎたので確定する。{ title, approved } を返す(猶予中でなければ null)。ログには題を入れない(通知ログは遠隔にも載る)
export function confirmDeliverableVerdict(state, id, ts) {
  const d = findDeliverable(state, id);
  if (!d || (d.status !== 'approving' && d.status !== 'rejecting')) return null;
  const approved = d.status === 'approving';
  d.status = approved ? 'approved' : 'rejected';
  if (approved) d.approvedAt = ts; else d.rejectedAt = ts;
  d.confirmAt = null;
  d.prev = null;
  addLog(state, ts, '社長', approved ? '成果物の承認を受け取りました' : '成果物の差し戻しを受け取りました');
  return { title: d.title, approved, hasComment: d.rejectedHasComment };
}

// 元に戻す。opened / dismissed、および猶予中の approving / rejecting のもの(後者は押す前の状態へ)
export function undoDeliverable(state, id) {
  const d = findDeliverable(state, id);
  if (!d) return false;
  if (d.status === 'approving' || d.status === 'rejecting') {
    d.status = d.prev === 'opened' ? 'opened' : 'new';
    d.prev = null;
    d.confirmAt = null;
    d.rejectedHasComment = false;
    return true;
  }
  if (d.status !== 'opened' && d.status !== 'dismissed') return false;
  if (d.status === 'dismissed' && d.prev === 'rejected') { d.status = 'rejected'; d.prev = null; d.removeAt = null; return true; }
  d.status = 'new';
  d.openedAt = null;
  d.removeAt = null;
  return true;
}

export function removeDeliverable(state, id) {
  const i = state.deliverables.findIndex((d) => d.id === id);
  if (i >= 0) state.deliverables.splice(i, 1);
}

const isOpen = (i) => i.status === 'assigning' || i.status === 'working';

function trimInstructions(state) {
  const list = state.instructions;
  while (list.length > INSTRUCTIONS_MAX) {
    // 受け取り待ちは画面のキューと対応するので、古い完了 → 進行中の順に捨てる
    let i = list.findIndex((x) => x.status === 'done');
    if (i < 0) i = list.findIndex((x) => x.status !== 'queued');
    list.splice(i >= 0 ? i : 0, 1);
  }
}

// 画面からの送信を受け取り待ちとして一覧に足す。返す id は取り出し時に prompt へ渡す
export function enqueueInstruction(state, text, ts) {
  const id = `i${state.nextInstructionId++}`;
  state.instructions.push({ id, text: clipListText(text), ts, source: 'office', status: 'queued' });
  trimInstructions(state);
  return id;
}

// 受け取り後もまだ最初の依頼・作業が出ていない間だけ、部長の吹き出しを「タスクを振っています」にする
export function markAssigningBubble(state) {
  const bucho = state.seats.get(BUCHO);
  if (bucho.status !== 'working' || bucho.bubble !== state.promptBubble) return false;
  if (!state.instructions.some((i) => i.status === 'assigning')) return false;
  bucho.bubble = ASSIGNING_TEXT;
  return true;
}

function startInstruction(state, ev) {
  for (const i of state.instructions) if (isOpen(i)) i.status = 'done';
  const queued = ev.instrId ? state.instructions.find((i) => i.id === ev.instrId && i.status === 'queued') : null;
  if (queued) queued.status = 'assigning';
  else {
    state.instructions.push({ id: `i${state.nextInstructionId++}`, text: clipListText(typeof ev.body === 'string' ? ev.body : ev.title), ts: ev.ts, source: ev.source === 'office' ? 'office' : 'terminal', status: 'assigning' });
  }
  trimInstructions(state);
}

const clipText = (v, n) => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '');

// 画面の「既読」。見つかれば true
export function markAnswerRead(state, id) {
  const a = state.answers.find((x) => x.id === id);
  if (!a) return false;
  a.status = 'read';
  return true;
}

// statusline 由来の1枠分。使用率が数値でなければ捨てる。resetsAt は秒のepoch(数値以外は null)
function cleanWindow(w) {
  const pct = w?.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const r = w.resetsAt;
  return { pct: Math.min(100, Math.max(0, Math.round(pct))), resetsAt: typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : null };
}

const WAIT_MAX = 120;
const PATH_TOOLS = { Write: '書き込み', Edit: '書き込み', NotebookEdit: '書き込み', Read: '読み取り' };

// Notification の本文から種類を決める。判別できなければ other(推測しない)
function classifyNotification(ev) {
  const msg = typeof ev.message === 'string' ? ev.message : '';
  const type = typeof ev.notifType === 'string' ? ev.notifType : '';
  if (type === 'permission_prompt' || /needs your permission|permission to use/i.test(msg)) return 'permission';
  if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) return 'idle';
  return 'other';
}

function permissionWaiting(state, msg) {
  const named = /permission to use\s+([A-Za-z_][\w.-]*)/i.exec(msg)?.[1] ?? null;
  const last = state.lastTool;
  // 本文のツール名と直前のツールが食い違うなら、直前の中身は使わない
  const tool = last && (!named || named === last.toolName) ? last : null;
  const name = named ?? tool?.toolName ?? '';
  const arg = tool ? clipChars(tool.toolArg, TOOL_ARG_MAX) : '';
  if (/^(Bash|PowerShell)$/.test(name) && arg) return { text: `${name}コマンド『${arg}』の実行許可`, detail: '' };
  if (PATH_TOOLS[name] && arg) return { text: `『${arg}』の${PATH_TOOLS[name]}許可(${name})`, detail: '' };
  if (name) return { text: `${name}の使用許可`, detail: '' };
  return { text: '操作の許可確認', detail: '' };
}

function waitingFromNotification(state, ev) {
  const msg = typeof ev.message === 'string' ? ev.message : '';
  const kind = classifyNotification(ev);
  let w;
  if (kind === 'permission') w = permissionWaiting(state, msg);
  else if (kind === 'idle') w = { text: '社長の次の指示待ち', detail: '' };
  else w = { text: msg || '社長の確認待ち', detail: '' };
  return { kind, text: clipChars(w.text, WAIT_MAX), detail: clipChars(w.detail, WAIT_MAX), since: typeof ev.ts === 'number' ? ev.ts : null };
}

// 質問(decisions の pending)があれば最優先。無ければ Notification 由来
function currentWaiting(state) {
  const d = state.decisions.find((x) => x.status === 'pending');
  if (d) {
    const text = d.header ? `${d.header}: ${d.question}` : d.question;
    return { kind: 'question', text: clipChars(text, WAIT_MAX), detail: clipChars((d.options ?? []).map((o) => o.label).join('/'), WAIT_MAX), since: d.askedAt ?? null };
  }
  return state.waiting ? { ...state.waiting } : null;
}

const REMOTE_WAIT_TEXT = { permission: '許可確認待ち', question: '質問への回答待ち', idle: '社長の次の指示待ち', other: '社長の確認待ち' };

const HOLD_TIMEOUT_MS = 30 * 60 * 1000; // 担当の終了合図が来ないまま止まったときの保険(最後のイベントから)
const isNotification = (ev) => /^\s*<task-notification/i.test(String(ev.body ?? ev.title ?? ''));

// SubagentStart が来て、まだ終了合図の来ていない担当がいるか
function hasActiveAgents(state) {
  return state.bindings.size > 0; // 席に着いた担当(順序Bの orphans も bindings に含まれる)。未着席の pending は数えない(開始が来ない場合に居座らないため)
}

// 指示と案件ボードを完了にする(stop の完了時・保険の時間切れで共通)。指示は部長のstopのときだけ
function finishWork(state, instr = true) {
  state.heldStop = false;
  if (instr) {
    if (state.instruction) state.instruction.status = 'done';
    for (const i of state.instructions) if (isOpen(i)) i.status = 'done';
  }
  for (const c of state.board) if (c.column !== 'done') c.column = 'done';
  state.review = null;
}

// 保険: 完了を保留したまま、最後のイベントから30分動きがなければ完了扱いにする(nowMs は差し替え可)
export function expireStaleHold(state, nowMs = Date.now(), timeoutMs = HOLD_TIMEOUT_MS) {
  if (!state.heldStop || state.lastEventTs === null || nowMs - state.lastEventTs < timeoutMs) return false;
  for (const s of state.seats.values()) { clearProgress(state, s); s.status = 'idle'; s.busy = false; s.count = 0; s.bubble = s.seat === BUCHO ? s.bubble : ''; if (s.seat.startsWith('helper-')) { s.name = HELPER_NAME; s.role = HELPER_NAME; } }
  finishWork(state);
  state.pending = []; state.orphans = []; state.bindings.clear(); state.agentCards.clear(); state.overflow.clear(); state.reviewerSince.clear();
  return true;
}

export function applyEvent(state, ev) {
  if (typeof ev.ts === 'number') state.lastEventTs = ev.ts;
  const bucho = state.seats.get(BUCHO);
  if (['tool', 'stop', 'prompt', 'subagent_start', 'session_start'].includes(ev.kind)) state.waiting = null;
  if (ev.kind === 'tool') state.lastTool = { toolName: typeof ev.toolName === 'string' ? ev.toolName : '', toolArg: typeof ev.toolArg === 'string' ? ev.toolArg : '' };
  if (ev.kind === 'stop' || ev.kind === 'prompt') state.lastTool = null;
  if (!ev.agentId && ['tool', 'stop', 'prompt', 'session_start'].includes(ev.kind)) answerPending(state);
  switch (ev.kind) {
    case 'prompt': {
      state.counters = { tools: 0, delegates: 0, startedAt: ev.ts };
      // 担当の完了通知で部長が再開しただけなら、新しい指示は作らず、保留中の指示を作業中に戻す
      const resume = !ev.agentId && isNotification(ev) && state.instructions.some(isOpen);
      if (!ev.agentId) state.heldStop = false;
      if (!ev.agentId && !resume) {
        const text = clipInstruction(typeof ev.body === 'string' ? ev.body : ev.title);
        startInstruction(state, ev);
        state.promptBubble = ev.text;
        state.instruction = { text, ts: ev.ts, source: ev.source === 'office' ? 'office' : 'terminal', status: 'working' };
      }
      if (resume) for (const i of state.instructions) if (i.status === 'assigning') i.status = 'working';
      if (!ev.agentId && !resume) clearProgress(state, bucho); // 新しい指示 = 前の ToDo の進捗は終わり
      bucho.status = 'working';
      bucho.bubble = ev.text;
      if (!resume) {
        const prev = card(state, state.promptCardId);
        if (prev && prev.column !== 'done') prev.column = 'done';
      }
      if (!ev.agentId && !resume) {
        // 次の指示が来た = レビューは済んだ
        state.review = null;
        for (const c of state.board) if (c.column === 'reviewing') c.column = 'done';
      }
      if (resume) { const pc = card(state, state.promptCardId); if (pc && pc.column !== 'done') pc.column = 'working'; }
      else state.promptCardId = addCard(state, titleFor(ev.title, ev.body, '社長の指示'), '部長');
      addLog(state, ev.ts, '部長', ev.text);
      addActivity(state, ev.ts, ev.agentId ? nickOf(state, ev.agentType) : bucho.nickname, 'prompt', ev.text);
      break;
    }
    case 'delegate': {
      if (!ev.agentId) for (const i of state.instructions) if (i.status === 'assigning') i.status = 'working';
      const type = ev.targetType ?? ev.agentType ?? 'general-purpose';
      if (!ev.agentId) state.review = null; // 新しい依頼が出た = 部長のレビューは終わり
      state.counters.delegates++;
      // 担当の SubagentStart が先に届いていた(順序B): その席を引き継ぎ、人数(count)も pending も増やさない
      const oi = state.orphans.findIndex((o) => o.type === type);
      if (oi >= 0) {
        const [o] = state.orphans.splice(oi, 1);
        const c = card(state, o.cardId);
        if (c) c.title = titleFor(ev.title, ev.body, c.title);
        bucho.status = 'working';
        bucho.bubble = `「${o.seat.name}に依頼」`;
        noteDelegation(state, ev, type, o.seat.seat);
        addLog(state, ev.ts, '部長', `${o.seat.name}に依頼`);
        addActivity(state, ev.ts, bucho.nickname, 'delegate', `${o.seat.nickname}に依頼${ev.title ? `: ${ev.title}` : ''}`);
        break;
      }
      const seat = takeSeat(state, type);
      if (!seat) {
        noteDelegation(state, ev, type, null);
        bucho.bubble = `「${nameOf(state, type)}に依頼」`;
        addLog(state, ev.ts, '部長', `${nameOf(state, type)}に依頼(席が足りず座れません)`);
        addActivity(state, ev.ts, bucho.nickname, 'delegate', `${nickOf(state, type)}に依頼(席が足りず座れません)`);
        break;
      }
      bucho.status = 'working';
      bucho.bubble = `「${seat.name}に依頼」`;
      seat.status = 'working';
      seat.bubble = ev.title ?? ev.text;
      seat.cardId = addCard(state, titleFor(ev.title, ev.body, `${seat.name}への依頼`), seat.name);
      state.pending.push({ type, seat, cardId: seat.cardId });
      noteDelegation(state, ev, type, seat.seat);
      addLog(state, ev.ts, '部長', `${seat.name}に依頼`);
      addActivity(state, ev.ts, bucho.nickname, 'delegate', `${seat.nickname}に依頼${ev.title ? `: ${ev.title}` : ''}`);
      break;
    }
    case 'todo': {
      applyEvent(state, { ...ev, kind: 'tool', toolName: 'TodoWrite', toolArg: '' }); // ふつうの作業としても数える
      if (!Number.isInteger(ev.todoTotal) || ev.todoTotal < 1 || !Number.isInteger(ev.todoDone)) break;
      const seat = ev.agentId ? state.bindings.get(ev.agentId) : bucho;
      if (!seat) break;
      const total = ev.todoTotal;
      const done = Math.min(Math.max(ev.todoDone, 0), total);
      const cardId = ev.agentId ? (state.agentCards.get(ev.agentId) ?? seat.cardId) : state.promptCardId;
      const current = typeof ev.todoCurrent === 'string' ? clipChars(ev.todoCurrent, 40) : '';
      setProgress(state, seat, cardId, { pct: Math.round((done / total) * 100), done, total, current, updatedAt: typeof ev.ts === 'number' ? ev.ts : null });
      break;
    }
    case 'subagent_start':
    case 'tool': {
      const seat = seatFor(state, ev);
      if (ev.kind === 'subagent_start') state.review = null;
      if (ev.kind === 'tool') {
        if (!ev.agentId) for (const i of state.instructions) if (i.status === 'assigning') i.status = 'working';
        state.counters.tools++;
        const prompt = card(state, state.promptCardId);
        if (prompt?.column === 'waiting') prompt.column = 'working';
        if (seat) { seat.status = 'working'; seat.bubble = ev.text; }
        addLog(state, ev.ts, seat?.name ?? nameOf(state, ev.agentType), ev.text);
        addActivity(state, ev.ts, seat?.nickname ?? nickOf(state, ev.agentType), 'tool', toolActivityText(ev));
        const r = state.review;
        if (!ev.agentId && r && REVIEW_TOOLS.has(ev.toolName)) {
          r.by = bucho.nickname;
          r.since ??= ev.ts;
          if (ev.toolName === 'Read' && typeof ev.toolArg === 'string' && ev.toolArg) r.file = clipChars(fileOnly(ev.toolArg), TOOL_ARG_MAX);
          const rc = card(state, r.cardId);
          if (rc) { rc.reviewBy = r.by; rc.reviewFile = r.file; }
        }
      } else if (seat) {
        seat.status = 'working';
        seat.bubble = ev.text;
      }
      break;
    }
    case 'subagent_done': {
      const seat = ev.agentId ? state.bindings.get(ev.agentId) : null;
      state.overflow.delete(ev.agentId);
      if (!seat) break;
      state.bindings.delete(ev.agentId);
      state.orphans = state.orphans.filter((o) => o.agentId !== ev.agentId);
      seat.count = Math.max(0, seat.count - 1);
      const c = card(state, state.agentCards.get(ev.agentId) ?? seat.cardId);
      state.agentCards.delete(ev.agentId);
      state.reviewerSince.delete(ev.agentId);
      if (c) c.column = 'done';
      // 検証・レビュー担当以外の完了は、部長が確認する「レビュー中」へ。済んだかは次の指示・停止で決まる
      if (c && !REVIEWER_TYPES.has(seat.type)) {
        c.column = 'reviewing';
        state.review = { cardId: c.id, target: reviewLabel(seat.nickname, c.title), by: null, file: null, since: null };
      }
      addLog(state, ev.ts, seat.name, ev.text);
      addActivity(state, ev.ts, seat.nickname, 'done', c?.title ? `『${c.title}』が完了` : ev.text);
      if (seat.count > 0) break; // 同じ席の別の担当がまだ動いている間は working のまま
      clearProgress(state, seat);
      seat.status = 'done';
      seat.bubble = ev.text;
      seat.busy = false;
      if (seat.seat.startsWith('helper-')) { seat.name = HELPER_NAME; seat.role = HELPER_NAME; }
      break;
    }
    case 'ask': {
      if (ev.agentId) break; // 質問の対象は部長だけ
      const questions = sanitizeQuestions(ev.questions);
      if (!questions.length) break;
      addDecisions(state, questions, ev.ts);
      bucho.status = 'waiting';
      bucho.bubble = 'ご判断をお待ちしています';
      const c = card(state, state.promptCardId);
      if (c) c.column = 'waiting';
      addLog(state, ev.ts, '部長', `社長のご判断待ち: ${shorten(questions[0].question, 30)}`);
      break;
    }
    case 'waiting': {
      state.waiting = waitingFromNotification(state, ev);
      bucho.status = 'waiting';
      bucho.bubble = ev.text;
      const c = card(state, state.promptCardId);
      if (c) c.column = 'waiting';
      addLog(state, ev.ts, '部長', ev.text);
      break;
    }
    case 'stop': {
      for (const s of state.seats.values()) clearProgress(state, s);
      // 部長のstopでも動いている担当が残っていれば、完了を保留して担当の席・案件は維持する
      const hold = !ev.agentId && hasActiveAgents(state);
      const keep = (s) => hold && s !== bucho && s.count > 0;
      for (const s of state.seats.values()) {
        if (keep(s)) continue;
        s.status = 'idle'; s.busy = false; s.count = 0; if (s !== bucho) s.bubble = ''; if (s.seat.startsWith('helper-')) { s.name = HELPER_NAME; s.role = HELPER_NAME; }
      }
      const said = state.instruction?.text && !ev.agentId ? stopText(state.instruction.text) : ev.text;
      bucho.bubble = said;
      if (hold) {
        state.heldStop = true;
        state.review = null;
      } else {
        finishWork(state, !ev.agentId);
        state.pending = [];
        state.orphans = [];
        state.bindings.clear();
        state.agentCards.clear();
        state.overflow.clear();
        state.reviewerSince.clear();
      }
      addLog(state, ev.ts, '部長', said);
      addActivity(state, ev.ts, bucho.nickname, 'stop', said);
      break;
    }
    case 'say': {
      if (ev.agentId) break; // 部長(本体)の発言だけ
      const text = typeof ev.text === 'string' ? [...ev.text.trim()].slice(0, TALK_TEXT_MAX).join('') : '';
      if (!text) break;
      state.talk.push({ ts: typeof ev.ts === 'number' ? ev.ts : null, who: bucho.nickname, text });
      if (state.talk.length > TALK_MAX) state.talk.splice(0, state.talk.length - TALK_MAX);
      break;
    }
    case 'answer': {
      if (ev.agentId) break;
      const question = clipListText(ev.question);
      const answer = clipText(ev.answer, ANSWER_A_MAX);
      if (!question || !answer) break;
      state.answers.unshift({ id: `r${state.nextAnswerId++}`, askedAt: ev.ts, question, answer, by: bucho.nickname, status: 'new' });
      state.answers.length = Math.min(state.answers.length, ANSWERS_MAX);
      break;
    }
    case 'quota': {
      const fiveHour = cleanWindow(ev.fiveHour);
      const sevenDay = cleanWindow(ev.sevenDay);
      state.quota = fiveHour || sevenDay ? { fiveHour, sevenDay, updatedAt: typeof ev.ts === 'number' ? ev.ts : null } : null;
      break;
    }
    case 'session_start':
      addLog(state, ev.ts, '部長', ev.text);
      break;
    default:
      break;
  }
}

// 役割名 -> 愛称。画面の名札・ボード・通知で「ミナトくん」と呼ぶための対応表
function nicknames(roster) {
  const map = {};
  for (const m of roster.members) if (m.nickname) map[m.name] = m.nickname;
  return map;
}

export function seatOfAgent(state, agentId) {
  return (agentId && state.bindings.get(agentId)?.seat) || null;
}

// 回復時刻(resetsAt、秒)を過ぎた枠は落とす。両方なければ null
function liveQuota(q, nowMs) {
  if (!q) return null;
  const alive = (w) => (w && (w.resetsAt === null || w.resetsAt * 1000 > nowMs) ? { ...w } : null);
  const fiveHour = alive(q.fiveHour);
  const sevenDay = alive(q.sevenDay);
  return fiveHour || sevenDay ? { fiveHour, sevenDay, updatedAt: q.updatedAt } : null;
}

// 今の「レビュー中」。hook で判った事実だけ(検証担当が動いている間、または担当の完了直後の部長の確認)
function reviewingNow(state) {
  for (const [agentId, seat] of state.bindings) {
    if (!REVIEWER_TYPES.has(seat.type)) continue;
    const c = card(state, state.agentCards.get(agentId));
    return { target: reviewLabel(seat.nickname, c?.title), by: seat.nickname, file: null, since: state.reviewerSince.get(agentId) ?? null };
  }
  const r = state.review;
  return r && r.since !== null ? { target: r.target, by: r.by, file: r.file, since: r.since } : null;
}

// local=true(PC の画面)のときだけ活動ログを載せる。遠隔(スマホ)には載せない
export function snapshot(state, nowMs = Date.now(), { local = false } = {}) {
  expireStaleHold(state, nowMs); // 完了を保留したまま止まった指示の保険
  const waiting = currentWaiting(state);
  const remoteWaiting = waiting && { kind: waiting.kind, text: REMOTE_WAIT_TEXT[waiting.kind] ?? REMOTE_WAIT_TEXT.other, since: waiting.since };
  const waitText = waiting ? (local ? waiting.text : remoteWaiting.text) : '';
  // 未承認の成果物の件数(承認・差し戻し・消したものは数えない)
  const deliverableCount = state.deliverables.filter((d) => d.status === 'new' || d.status === 'opened' || d.status === 'approving' || d.status === 'rejecting').length;
  const sns = state.deliverables.filter((d) => d.sns);
  return {
    snsCounts: { pending: sns.filter((d) => !d.posted && d.status !== 'rejected' && d.status !== 'dismissed').length, posted: sns.filter((d) => d.posted).length }, // 件数だけ(遠隔にも出す)
    ...(local ? { snsError: state.snsError ?? null } : {}),
    deliverableCount, // 未確認の成果物の件数(遠隔にも出す。題・パスは出さない)
    ...(local ? { deliverables: state.deliverables.map(({ prev, ...d }) => ({ ...d })) } : {}),
    delegation: state.lastDelegation ? { ...state.lastDelegation } : null, // 直近の委任(通し番号・種類・席)。本文なし
    pendingDecisions: state.decisions.filter((d) => d.status === 'pending').length, // 未回答の確認事項の件数
    waiting: waiting ? (local ? waiting : remoteWaiting) : null,
    ...(local ? { activity: state.activity.map((a) => ({ ...a })), talk: state.talk.map((t) => ({ ...t })) } : {}),
    reviewing: reviewingNow(state),
    answers: state.answers.map((a) => ({ ...a })),
    quota: liveQuota(state.quota, nowMs),
    // 進捗: PC は全部、遠隔(スマホ)は % だけ(進行中の見出しは本文にあたるので出さない)
    members: [...state.seats.values()].map(({ seat, name, role, nickname, dept, status, bubble, count, progress }) => ({ seat, role, nickname, dept, name, status, bubble, count, progress: progress ? (local ? { ...progress } : { pct: progress.pct }) : null })),
    board: state.board.map((c) => ({ ...c, ...(waitText && c.column === 'waiting' && c.id === state.promptCardId ? { waitText } : {}) })),
    // 遠隔(スマホ)には質問・選択肢の本文を出さず、「判断待ち」だけ
    // 「その他」の入力文(other)は PC にも出さない。選択中は pickedOther、回答済みは answeredOther(真偽のみ)
    decisions: state.decisions.map((d) => (local
      ? { ...d, other: undefined, allowOther: d.source === 'office' && d.mode === 'choice' ? d.allowOther !== false : false, pickedOther: d.other != null, answeredOther: d.answeredOther === true, options: d.options.map((o) => ({ ...o })) }
      : { id: d.id, source: d.source ?? 'hook', mode: d.mode ?? 'choice', status: d.status, header: '', question: d.mode === 'open' || d.mode === 'terminal' ? '確認待ち' : '判断待ち', options: [], multiSelect: false, askedAt: d.askedAt })),
    instructions: state.instructions.map((i) => ({ ...i })),
    instruction: state.instruction ? { ...state.instruction } : null,
    counters: { ...state.counters },
    log: state.log.map((l) => ({ ...l })),
    nicknames: nicknames(state.roster),
  };
}
