// イベントの許可リストと、認証情報の伏せ字(サーバー側の最後の防衛線。hook 側でも同じ関数を使う)。
// マルチプロジェクト設計書(非公開) の5.1。

export const REDACTED = '(伏せ字)';

// state.applyEvent が扱う種類。これ以外は受けない
export const EVENT_KINDS = new Set(['prompt', 'delegate', 'todo', 'subagent_start', 'subagent_done', 'tool', 'ask', 'waiting', 'stop', 'say', 'answer', 'quota', 'session_start']);

// 受けてよい項目(未知の項目は落とす)。source / instrId はサーバー内部だけが付けるので入れない。
// cwd は発信元の確認にだけ使い、state には渡さない
export const EVENT_FIELDS = new Set(['ts', 'kind', 'project', 'cwd', 'agentId', 'agentType', 'text', 'title', 'body', 'toolName', 'toolArg', 'questions', 'message', 'notifType', 'transcriptPath', 'agentTranscriptPath', 'targetType', 'todoTotal', 'todoDone', 'todoCurrent', 'question', 'answer', 'fiveHour', 'sevenDay']);

// .env / .env.local など(前後が区切りのもの)、.dev.vars 系、KEY=・TOKEN=・SECRET= 形式、Bearer、秘密鍵、主要なトークンの接頭辞
const SECRET_PATTERNS = [
  /(?:^|[^A-Za-z0-9_])\.env(?:\.[A-Za-z0-9_.-]+)?(?![A-Za-z0-9_])/i,
  /\.dev\.vars/i,
  /[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*\S/i,
  /["'](?:api[_-]?key|token|secret|password|access[_-]?key)["']\s*:\s*["']\S/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|ghp|gho|github_pat|xox[bp])[-_][A-Za-z0-9_-]{20,}/,
];

export const hasSecret = (s) => typeof s === 'string' && SECRET_PATTERNS.some((re) => re.test(s));
const redact = (s) => (hasSecret(s) ? REDACTED : s);

function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
  return v;
}

// 許可リストの項目だけを残し、文字列は認証情報らしければ丸ごと伏せ字にする。kind が許可外なら null
export function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev) || !EVENT_KINDS.has(ev.kind)) return null;
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (!EVENT_FIELDS.has(k)) continue;
    out[k] = k === 'kind' || k === 'project' || k === 'cwd' || k === 'transcriptPath' || k === 'agentTranscriptPath' ? v : redactDeep(v);
  }
  return out;
}
