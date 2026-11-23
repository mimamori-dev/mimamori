export function shorten(s, n) {
  const t = String(s ?? '').replace(/\r?\n/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export const INSTRUCTION_MAX = 300;

// 指示本文は改行を残して300字まで(…は付けない)。サロゲートペアを割らないよう文字単位で切る
export function clipInstruction(v) {
  return typeof v === 'string' ? [...v].slice(0, INSTRUCTION_MAX).join('') : '';
}

// 一覧用の指示本文。改行は空白にして100字まで
export const LIST_TEXT_MAX = 100;
export const clipListText = (v) => (typeof v === 'string' ? [...v.replace(/\s*\n\s*/g, ' ').trim()].slice(0, LIST_TEXT_MAX).join('') : '');

// 部長の吹き出し・通知ログの文。hook経由と画面から取り出した指示で同じ文にする
export const promptText = (body) => `社長から『${shorten(body, 24)}』の指示を受けました`;
export const stopText = (instructionText) => `『${shorten(instructionText, 16)}』の作業が終わりました。社長に報告します`;

const str = (v, n) => (typeof v === 'string' ? shorten(v, n) : '');

// AskUserQuestion の入力を表示用に丸める。仕様外の入力でも例外を出さず、使える質問だけ残す
export function sanitizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o) => o && typeof o === 'object' && typeof o.label === 'string' && o.label.trim())
      .slice(0, 4)
      .map((o) => ({ label: str(o.label, 40), description: str(o.description, 120) }));
    out.push({ question: str(q.question, 200), header: str(q.header, 20), options, multiSelect: q.multiSelect === true });
  }
  return out;
}

// Windows とそれ以外のパスが混在するため両方の区切りで分ける
const baseName = (p) => String(p ?? '').split(/[\\/]/).pop();

function describeTool(name, input) {
  switch (name) {
    case 'Read': return `${baseName(input.file_path)}を読んでいます`;
    case 'Write':
    case 'Edit': return `${baseName(input.file_path)}を書いています`;
    case 'NotebookEdit': return `${baseName(input.notebook_path)}を書いています`;
    case 'Bash':
    case 'PowerShell': return `コマンド実行: ${String(input.command ?? '').slice(0, 30)}`;
    case 'Grep':
    case 'Glob': return 'ファイルを探しています';
    case 'WebSearch':
    case 'WebFetch': return 'Webで調べています';
    default: return `${name}を使っています`;
  }
}

// 活動ログ用。Bash はコマンドの先頭、ファイル系はファイル名だけ(出力・本文は扱わない)
function toolArg(name, input) {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit': return baseName(input.file_path);
    case 'NotebookEdit': return baseName(input.notebook_path);
    case 'Bash':
    case 'PowerShell': return shorten(String(input.command ?? '').slice(0, 80), 80);
    default: return '';
  }
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const TODO_PARSE_MAX = 200;

// TodoWrite の tool_input.todos[]({ content, status: pending|in_progress|completed, activeForm })から、
// 件数・完了数・進行中の見出しだけを抜く(各項目の全文は送らない)。使える項目が無ければ null
export function summarizeTodos(todos) {
  if (!Array.isArray(todos)) return null;
  let total = 0;
  let done = 0;
  let current = '';
  for (const t of todos.slice(0, TODO_PARSE_MAX)) {
    if (!t || typeof t !== 'object' || !TODO_STATUSES.has(t.status)) continue;
    total++;
    if (t.status === 'completed') done++;
    if (t.status === 'in_progress' && !current) {
      const label = typeof t.activeForm === 'string' && t.activeForm.trim() ? t.activeForm : typeof t.content === 'string' ? t.content : '';
      current = [...label.replace(/\s*\n\s*/g, ' ').trim()].slice(0, 40).join('');
    }
  }
  return total ? { total, done, current } : null;
}

export function toOfficeEvent(input, now) {
  if (!input || typeof input !== 'object') return null;
  const common = {
    ts: now,
    agentId: input.agent_id ?? null,
    agentType: input.agent_type ?? null,
    transcriptPath: input.transcript_path ?? null,
    agentTranscriptPath: input.agent_transcript_path ?? null,
  };
  const make = (kind, text, extra = {}) => ({ ts: common.ts, kind, agentId: common.agentId, agentType: common.agentType, text, ...extra, transcriptPath: common.transcriptPath, agentTranscriptPath: common.agentTranscriptPath });

  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return make('prompt', promptText(input.prompt), { title: shorten(input.prompt, 40), body: clipInstruction(input.prompt) });
    case 'PreToolUse': {
      const name = input.tool_name;
      const ti = input.tool_input ?? {};
      // 担当が結果を返すための内部配管で、画面に出す仕事ではない
      if (name === 'SubagentHandback') return null;
      if (name === 'Agent' || name === 'Task') {
        const targetType = ti.subagent_type ?? 'general-purpose';
        return make('delegate', `${targetType}に依頼します`, { title: ti.description, ...(typeof ti.prompt === 'string' ? { body: ti.prompt.slice(0, 300) } : {}), targetType });
      }
      if (name === 'TodoWrite') {
        const sum = summarizeTodos(ti.todos);
        // 使える項目が無い(0件・形が違う)ときは、ふつうのツール呼び出しとして扱う
        if (sum) return make('todo', 'やることを更新しています', { toolName: 'TodoWrite', toolArg: '', todoTotal: sum.total, todoDone: sum.done, todoCurrent: sum.current });
      }
      if (name === 'AskUserQuestion') {
        const questions = sanitizeQuestions(ti.questions);
        // 表示できる質問が無ければ何も送らない(質問内容はログ・保存に出さない)
        return questions.length ? make('ask', '社長のご判断待ち', { questions }) : null;
      }
      return make('tool', describeTool(name, ti), { toolName: String(name ?? ''), toolArg: toolArg(name, ti) });
    }
    case 'SubagentStart': return make('subagent_start', '作業を始めます');
    case 'SubagentStop': return make('subagent_done', 'できました');
    case 'Stop': return make('stop', '社長に報告');
    case 'Notification': return make('waiting', '社長の確認待ち', {
      message: typeof input.message === 'string' ? [...input.message.replace(/\s*\n\s*/g, ' ').trim()].slice(0, 200).join('') : '',
      notifType: typeof input.notification_type === 'string' ? input.notification_type.slice(0, 40) : '',
    });
    case 'SessionStart': return make('session_start', '出社しました');
    default: return null;
  }
}
