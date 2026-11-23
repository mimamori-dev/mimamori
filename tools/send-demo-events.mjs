// 目視確認用: 名簿の全員(同じ席に2人・名簿外の種類を含む)が登場する一連の動きを、間隔を空けてオフィスへ送る。
// 使い方: node tools/send-demo-events.mjs [--keep]
//   --keep  最後の「社長に報告」(stop)を送らず、作業中の様子を残す
//   OFFICE_PORT / DEMO_INTERVAL_MS(既定 1000)で送り先と間隔を変えられる
const port = process.env.OFFICE_PORT ?? 4317;
const url = `http://127.0.0.1:${port}/event`;
const gap = Number(process.env.DEMO_INTERVAL_MS ?? 1000);
const keep = process.argv.includes('--keep');

const sub = (agentId, agentType) => ({ agentId, agentType });
const steps = [
  { kind: 'session_start', text: '出社しました' },
  { kind: 'quota', text: '', fiveHour: { pct: 38, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 }, sevenDay: { pct: 12, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 } },
  { kind: 'prompt', text: '依頼を受けました', title: 'リリースノートの下書きを作る', body: 'リリースノートの下書きを作ってください。\nあわせて README の誤字を直してください。' },
  { kind: 'tool', text: 'report.xlsxを読んでいます' },
  { kind: 'delegate', text: 'numbers-checkerに依頼します', title: 'Excelの数値検証', targetType: 'numbers-checker' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-num', 'numbers-checker') },
  { kind: 'tool', text: 'report.xlsxを読んでいます', ...sub('a-num', 'numbers-checker') },
  { kind: 'delegate', text: 'report-writerに依頼します', title: '分析レポートの作成', targetType: 'report-writer' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-rep', 'report-writer') },
  { kind: 'tool', text: 'build_report.jsを書いています', ...sub('a-rep', 'report-writer') },
  { kind: 'delegate', text: 'domain-reviewerに依頼します', title: '専門分野のレビュー', targetType: 'domain-reviewer' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-dom', 'domain-reviewer') },
  { kind: 'tool', text: 'Webで調べています', ...sub('a-dom', 'domain-reviewer') },
  { kind: 'delegate', text: 'cost-auditorに依頼します', title: '費用・制度の校閲', targetType: 'cost-auditor' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-cost', 'cost-auditor') },
  { kind: 'tool', text: 'CHANGELOG.mdを読んでいます', ...sub('a-cost', 'cost-auditor') },
  { kind: 'delegate', text: 'general-purposeに依頼します', title: '過去のリリースノートの下調べ', targetType: 'general-purpose' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-gp', 'general-purpose') },
  { kind: 'tool', text: 'ファイルを探しています', ...sub('a-gp', 'general-purpose') },
  { kind: 'delegate', text: 'implementerに依頼します', title: '集計スクリプトの修正', targetType: 'implementer' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-imp', 'implementer') },
  { kind: 'tool', text: 'テストを書いています', ...sub('a-imp', 'implementer') },
  { kind: 'delegate', text: 'implementerに依頼します', title: '同じ担当の2人目(同じ席が ×2 になる)', targetType: 'implementer' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-imp2', 'implementer') },
  { kind: 'tool', text: 'テストを実行しています', ...sub('a-imp2', 'implementer') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-imp', 'implementer') }, // 片方が終わっても、もう片方が動く間は作業中のまま
  { kind: 'delegate', text: 'ui-builderに依頼します', title: '画面の調整', targetType: 'ui-builder' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-ui', 'ui-builder') },
  { kind: 'delegate', text: 'qa-testerに依頼します', title: '動作確認', targetType: 'qa-tester' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-qa', 'qa-tester') },
  { kind: 'delegate', text: 'claude-code-guideに依頼します', title: 'hookの仕様確認', targetType: 'claude-code-guide' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-guide', 'claude-code-guide') },
  { kind: 'delegate', text: 'unknown-agentに依頼します', title: '名簿に無い種類(ユウくんの席で受ける)', targetType: 'unknown-agent' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-unk', 'unknown-agent') },
  { kind: 'delegate', text: 'another-unknownに依頼します', title: '名簿に無い種類の2人目(ユウくんが ×2)', targetType: 'another-unknown' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-unk2', 'another-unknown') },
  { kind: 'delegate', text: 'Exploreに依頼します', title: '前回のリリースノートを探す', targetType: 'Explore' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-exp', 'Explore') },
  { kind: 'tool', text: 'ファイルを探しています', ...sub('a-exp', 'Explore') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-num', 'numbers-checker') },
  { kind: 'tool', text: '本編スライドを書いています', ...sub('a-rep', 'report-writer') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-dom', 'domain-reviewer') },
  { kind: 'delegate', text: 'video-producerに依頼します', title: 'ナレーション付き動画の作成', targetType: 'video-producer' },
  { kind: 'subagent_start', text: '作業を始めます', ...sub('a-vid', 'video-producer') },
  { kind: 'tool', text: 'コマンド実行: ffmpeg -i slides.mp4', ...sub('a-vid', 'video-producer') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-cost', 'cost-auditor') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-gp', 'general-purpose') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-exp', 'Explore') },
  { kind: 'subagent_done', text: 'できました', ...sub('a-rep', 'report-writer') },
  ...['a-imp2', 'a-ui', 'a-qa', 'a-guide', 'a-unk', 'a-unk2'].map((id) => ({ kind: 'subagent_done', text: 'できました', ...sub(id, id) })),
  // 社長への質問。部長が社長室へ聞きに行き、次の部長の動き(下の tool)で答え済みになって戻る
  { kind: 'ask', text: '質問します', questions: [{ header: '方針', question: '来季の新規案件は、案Aと案Bのどちらを優先しますか?', multiSelect: false, options: [{ label: '案A優先', description: '効果は大きいが手間がかかる' }, { label: '案B優先', description: '手軽に始められる' }] }] },
  ...[1, 2, 3, 4].map((n) => ({ kind: 'tool', text: `動画を書き出しています(${n}/4)`, ...sub('a-vid', 'video-producer') })), // 部長が社長室へ着くまでの間
  { kind: 'waiting', text: '社長の確認待ち' },
  { kind: 'tool', text: 'レポートを確認しています' },
  { kind: 'subagent_done', text: 'できました', ...sub('a-vid', 'video-producer') },
  ...(keep ? [] : [{ kind: 'stop', text: '社長に報告' }]),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [i, step] of steps.entries()) {
  const ev = { ts: Date.now(), agentId: null, agentType: null, transcriptPath: null, agentTranscriptPath: null, ...step };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
  console.log(`${String(i + 1).padStart(2)}/${steps.length} ${ev.kind.padEnd(14)} ${res.status} ${ev.title ?? ev.text}`);
  if (i < steps.length - 1) await sleep(gap);
}
