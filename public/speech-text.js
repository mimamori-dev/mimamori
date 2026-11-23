// 読み上げ用に文を整える純粋関数(ブラウザ・node 両用)。コード・URL・表・長い数字・絵文字は読まない。
export const SPEECH_MAX = 300;

export function speechText(input, max = SPEECH_MAX) {
  if (typeof input !== 'string') return '';
  let s = input;
  s = s.replace(/```[\s\S]*?(```|$)/g, ' '); // コードブロック(閉じ忘れも)
  s = s.replace(/`[^`\n]*`/g, ' '); // インラインコード
  s = s.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' '); // URL
  s = s.replace(/\b[A-Za-z]:\\\S*/g, ' '); // Windows のパス
  // 表(| 区切りの行)と区切り線
  s = s.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return !((t.startsWith('|') && t.split('|').length >= 3) || /^[-:| ]{3,}$/.test(t));
  }).join('\n');
  s = s.replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, ''); // 見出し・引用・箇条書きの記号
  s = s.replace(/\*\*|__|~~|[*_]{1,2}(?=\S)/g, '');
  s = s.replace(/\p{Extended_Pictographic}|[‍️⃣]|\p{Regional_Indicator}/gu, ' '); // 絵文字
  s = s.replace(/\d[\d,.\s]{5,}\d|\d{7,}/g, (m) => (m.replace(/\D/g, '').length >= 7 ? ' ' : m)); // 長い数字
  s = s.replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, '。').replace(/。{2,}/g, '。').replace(/^。|。$/g, '').trim();
  if (!s) return '';
  if (s.length > max) {
    const cut = s.slice(0, max);
    const k = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('、'));
    s = (k > max * 0.5 ? cut.slice(0, k + 1) : cut).trim();
  }
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}
