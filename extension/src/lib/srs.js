// 简化间隔重复：stage 0..4 → 1 / 2 / 4 / 7 / 15 天
const INTERVALS_MS = [
  1 * 24 * 3600 * 1000,
  2 * 24 * 3600 * 1000,
  4 * 24 * 3600 * 1000,
  7 * 24 * 3600 * 1000,
  15 * 24 * 3600 * 1000,
];

export function nextDue(stage, now = Date.now()) {
  const s = Math.max(0, Math.min(stage, INTERVALS_MS.length - 1));
  return now + INTERVALS_MS[s];
}

/** grade: 'again' | 'hard' | 'good' | 'easy' */
export function applyReview(item, grade, now = Date.now()) {
  const stage = Number(item.stage || 0);
  let nextStage = stage;
  let lapses = item.lapses || 0;
  let reviews = (item.reviews || 0) + 1;

  if (grade === 'again') {
    nextStage = 0;
    lapses += 1;
  } else if (grade === 'hard') {
    nextStage = Math.max(0, stage);
  } else if (grade === 'good') {
    nextStage = Math.min(stage + 1, INTERVALS_MS.length - 1);
  } else if (grade === 'easy') {
    nextStage = Math.min(stage + 2, INTERVALS_MS.length - 1);
  }

  return {
    ...item,
    stage: nextStage,
    reviews,
    lapses,
    dueAt: nextDue(nextStage, now),
    lastReviewAt: now,
  };
}

export function isDue(item, now = Date.now()) {
  return !item.dueAt || item.dueAt <= now;
}

export function filterDue(list, now = Date.now()) {
  return list.filter((x) => isDue(x, now));
}

export function stageLabel(stage) {
  const labels = ['新词', '1天', '2天', '4天', '7天', '已掌握'];
  const s = Number(stage || 0);
  return labels[Math.min(s + 1, labels.length - 1)] || '新词';
}
