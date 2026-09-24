// 导出 Anki CSV / Markdown（防 CSV 公式注入）
export function sanitizeCsvCell(value) {
  let v = String(value ?? '');
  // 防止 Excel/表格把 = + - @ 开头当公式执行
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return `"${v.replace(/"/g, '""')}"`;
}

export function toAnkiCsv(list) {
  const header = ['Front', 'Back', 'Tags', 'Source'].map(sanitizeCsvCell).join(',');
  const rows = list.map((x) => {
    const backParts = [
      x.phonetic,
      x.pos,
      x.meaning,
      x.defEn,
      x.sentence ? `例：${x.sentence}` : '',
    ].filter(Boolean);
    const back = backParts.join(' | ');
    const tags = `reuters stage${x.stage || 0}`;
    const source = String(x.url || x.title || '');
    return [
      sanitizeCsvCell(x.word || ''),
      sanitizeCsvCell(back),
      sanitizeCsvCell(tags),
      sanitizeCsvCell(source),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export function toMarkdown(list, title = 'Reuters 生词本') {
  const now = new Date();
  const lines = [
    `# ${title}`,
    '',
    `导出时间：${now.toISOString()}`,
    '',
    `共 ${list.length} 条`,
    '',
  ];
  for (const x of list) {
    lines.push(`## ${x.word}`);
    if (x.phonetic) lines.push(`- 音标：${x.phonetic}`);
    if (x.pos) lines.push(`- 词性：${x.pos}`);
    if (x.meaning) lines.push(`- 释义：${x.meaning}`);
    if (x.defEn) lines.push(`- 英文：${x.defEn}`);
    if (x.sentence) lines.push(`- 例句：${x.sentence}`);
    if (x.title) lines.push(`- 来源：${x.title}`);
    if (x.url) lines.push(`- 链接：${x.url}`);
    lines.push(`- 复习：第 ${x.stage || 0} 阶 · ${x.reviews || 0} 次 · 收藏 ${x.savedCount || 1} 次`);
    lines.push('');
  }
  return lines.join('\n');
}

export function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const safeName = String(filename || 'export.txt').replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
