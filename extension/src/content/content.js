// Reuters 取词气泡 content script
// 规则：选多少显示多少（不多不少）；双击按光标词边界取词
(() => {
  if (window.__rvHost) return;

  const settings = {
    fontSize: 15,
    sentenceDefault: false, // 句子模式改为选整句才用；默认「选啥查啥」
    enableSelection: true,
    hotkeysHint: true,
    translateSource: 'auto',
    enableLLM: false,
  };

  let host = null;
  let shadow = null;
  let bubble = null;
  let dock = null;
  let current = null;
  let todayCount = 0;
  let lookupSeq = 0;
  let selectTimer = null;
  let ignoreSelectUntil = 0;
  let saving = false;
  let justShownAt = 0;
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let maxDrag = 0;
  let prefetchTimer = null;
  const prefetchCache = new Map();
  const PREFETCH_MAX = 20;
  let scrollHideTimer = null;

  // YouTube 字幕区按下状态：click 时拦截播放器的暂停/全屏反应，只出翻译气泡
  let ytCaptionPress = null;

  function ytCaptionHit(t) {
    try {
      return !!(t && t.closest && t.closest('.ytp-caption-segment'));
    } catch (_) {
      return false;
    }
  }

  const CSS = `
.rv-bubble {
  position: absolute;
  z-index: 2147483000;
  min-width: 280px;
  /* 宽度按截图黑框（约 420px），高度仍随内容自适应 */
  width: min(420px, 90vw);
  max-width: 420px;
  background: #ffffff;
  color: #1a1a18;
  border: 1px solid #e6e6e0;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(26, 26, 24, 0.12);
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.45;
  opacity: 0;
  transition: opacity 0.08s ease;
  /* 隐藏时必须放行点击：auto 会让气泡消失后继续拦截该区域的页面点击（表现为点了没反应） */
  pointer-events: none;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.rv-bubble.rv-show { opacity: 1; pointer-events: auto; }
.rv-word.rv-sel { font-size: 14px; line-height: 1.45; max-height: 96px; overflow: auto; }
.rv-word {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 20px;
  font-weight: 600;
  color: #1a1a18;
  margin: 0 0 2px;
  word-break: break-word;
}
.rv-phonetic { color: #8a8a82; font-size: 12px; margin: 0 0 6px; }
.rv-meta { color: #5c5c56; font-size: 13px; margin: 0 0 4px; }
.rv-pos {
  display: inline-block; background: #f3f3ee; border-radius: 4px;
  padding: 0 6px; margin-right: 6px; font-size: 12px; color: #5c5c56;
}
.rv-meaning { font-size: 15px; color: #1a1a18; margin: 0 0 4px; }
.rv-def { font-size: 12px; color: #8a8a82; margin: 0 0 8px; }
.rv-sentence-box {
  background: #fafaf8; border-radius: 8px; padding: 8px 10px;
  margin: 0 0 8px; max-height: 96px; overflow: auto;
}
.rv-sentence-en {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 13px; color: #1a1a18; margin: 0 0 4px;
}
.rv-sentence-zh { font-size: 13px; color: #5c5c56; margin: 0; }
.rv-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rv-btn {
  all: unset; box-sizing: border-box; cursor: pointer; border-radius: 8px;
  padding: 6px 10px; font-size: 13px; background: #f3f3ee; color: #1a1a18;
}
.rv-btn:hover { background: #e8e8e0; }
.rv-btn.rv-primary { background: #fa6400; color: #fff; }
.rv-btn.rv-primary:hover { background: #e85a00; }
.rv-btn.rv-saved {
  background: #fff4ec; color: #fa6400; border: 1px solid #ffd2b0;
}
.rv-btn.rv-star { font-size: 16px; padding: 4px 10px; line-height: 1.2; }
.rv-btn.rv-star.rv-pop { animation: rv-pop 0.28s ease; }
@keyframes rv-pop {
  0% { transform: scale(1); }
  40% { transform: scale(1.18); }
  100% { transform: scale(1); }
}
.rv-hint { margin-left: auto; font-size: 11px; color: #b0b0a8; }
.rv-status { font-size: 12px; color: #8a8a82; margin: 6px 0 0; }
.rv-error { color: #c92a2a; }
.rv-dock {
  position: absolute; right: 18px; bottom: 18px; z-index: 2147482999;
  display: flex; align-items: center; gap: 6px;
  background: #ffffff; border: 1px solid #e6e6e0; border-radius: 999px;
  box-shadow: 0 6px 20px rgba(26, 26, 24, 0.1); padding: 8px 12px;
  font-size: 13px; color: #1a1a18; cursor: pointer; user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  pointer-events: auto;
}
.rv-dock-star { color: #fa6400; font-size: 14px; }
.rv-dock-count { font-variant-numeric: tabular-nums; }
.rv-loading::after { content: '…'; }
`;

  function ensureUi() {
    if (host && bubble) return;
    host = document.createElement('div');
    host.setAttribute('data-rv', '1');
    // 不要用 all:initial + 0 尺寸，避免 fixed 子元素被裁切/不可见
    // 钉在视口原点：子元素 absolute 的 left/top = 视口坐标
    // 禁止 transform/filter/contain（会把定位包含块改成文档）
    host.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;' +
      'z-index:2147483000;overflow:visible;pointer-events:none;';

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    bubble = document.createElement('div');
    bubble.className = 'rv-bubble';
    shadow.appendChild(bubble);

    dock = document.createElement('div');
    dock.className = 'rv-dock';
    updateDock();
    dock.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
      } catch (_) {}
    });
    shadow.appendChild(dock);

    wireActionDelegation();

    document.documentElement.appendChild(host);
    window.__rvHost = host;
  }

  function isWordChar(ch) {
    return /[A-Za-z'-]/.test(ch || '');
  }

  // 取词命中判定：取到的词矩形必须盖住/贴近点击点（±10px），
  // 否则视为点在空白处（caretRangeFromPoint 会把空白处的点击吸附到附近的文字上）
  const CLICK_HIT_TOL = 10;

  function rectNearPoint(rect, x, y) {
    return (
      !!rect &&
      x >= rect.left - CLICK_HIT_TOL &&
      x <= rect.right + CLICK_HIT_TOL &&
      y >= rect.top - CLICK_HIT_TOL &&
      y <= rect.bottom + CLICK_HIT_TOL
    );
  }

  /** 取出文本节点 range 覆盖/插入点所在的完整英文词 */
  function wordFromTextRange(range) {
    if (!range) return '';
    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return '';
    const text = node.textContent || '';
    let start = range.startOffset;
    let end = range.endOffset;
    if (start > end) {
      const t = start;
      start = end;
      end = t;
    }
    if (range.collapsed) {
      start = range.startOffset;
      end = range.startOffset;
    }
    while (start > 0 && isWordChar(text.charAt(start - 1))) start--;
    while (end < text.length && isWordChar(text.charAt(end))) end++;
    return text.slice(start, end).replace(/^-+|-+$/g, '');
  }

  function rangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(x, y);
    }
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) {
        const r = document.createRange();
        const off = Math.min(pos.offset, (pos.offsetNode.textContent || '').length);
        r.setStart(pos.offsetNode, off);
        r.setEnd(pos.offsetNode, off);
        return r;
      }
    }
    return null;
  }

  /** 从事件目标直接取英文词（链接/按钮最准），再退回坐标取词 */
  function headFromEvent(e) {
    const el = e.target;
    // 链接/按钮/短 span 优先（X、HF 上生词常是这种）
    if (el && el.closest) {
      const hit = el.closest('a,button,[role="link"],[role="button"]');
      if (hit && hit.textContent) {
        const own = String(hit.textContent).replace(/\s+/g, ' ').trim();
        if (/^[A-Za-z][A-Za-z' -]{0,40}$/.test(own) && own.split(/\s+/).length <= 3) {
          return own;
        }
      }
    }
    return headFromDblclick(e.clientX, e.clientY);
  }

  /** 提取像英文的 head，丢掉中文长句误判 */
  function cleanEnglishHead(s) {
    const raw = String(s || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    // 只允许 1–3 个英文词当 head，长文本必须再拆
    if (raw.split(/\s+/).length <= 3 && /^[A-Za-z]/.test(raw)) return raw;
    const m = raw.match(/[A-Za-z][A-Za-z'-]*/g);
    return m && m.length ? m.slice(0, 2).join(' ') : '';
  }

  /** 穿透 open shadow root 的 elementFromPoint：新版 Reddit 等站点正文在 shadow 里，
      文档层的 elementFromPoint 只会返回组件宿主（其 textContent 不含影子树内容） */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 6 && el && el.shadowRoot; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** 取光标下英文词：caret 词边界优先，其次链接短文本，再次按 x 估词；点在空白处一律返回空 */
  function headFromDblclick(clientX, clientY) {
    // 1) caret 词边界：取到的词矩形必须盖住/贴近点击点
    const range = rangeFromPoint(clientX, clientY);
    if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      const node = range.startContainer;
      const text = node.textContent || '';
      let start = range.startOffset;
      let end = range.startOffset;
      while (start > 0 && isWordChar(text.charAt(start - 1))) start--;
      while (end < text.length && isWordChar(text.charAt(end))) end++;
      if (end > start) {
        const wr = document.createRange();
        wr.setStart(node, start);
        wr.setEnd(node, end);
        const rr = wr.getBoundingClientRect();
        if (rr && (rr.width || rr.height)) {
          // caret 吸附到的词离点击点太远 = 点在空白处，直接放弃（不再往下兜底）
          if (!rectNearPoint(rr, clientX, clientY)) return '';
          const word = text.slice(start, end).replace(/^-+|-+$/g, '');
          if (word && /^[A-Za-z]/.test(word)) return word;
        }
        // 词形不合格（数字/符号）或矩形异常：继续走元素兜底
      }
      // caret 落在词间空白：继续走元素兜底
    }

    const el = deepElementFromPoint(clientX, clientY);
    if (el && el.closest) {
      // 链接等短节点（元素就在点击点下方，文字即所见）
      const link = el.closest('a,button,[role="link"],[role="button"]');
      if (link && link.textContent) {
        const own = String(link.textContent).replace(/\s+/g, ' ').trim();
        if (own && own.length <= 48 && own.split(/\s+/).length <= 3 && /^[A-Za-z]/.test(own)) {
          return own;
        }
      }
      // 只有「本节点文本很短且节点本身是文字大小」才整体当词：
      // 宽大的布局容器（如标题行、flex 行）即使文本短，点击其空白处也不该出词
      const ownText = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (ownText && ownText.length <= 48 && ownText.split(/\s+/).length <= 3 && /^[A-Za-z]/.test(ownText)) {
        const box = el.getBoundingClientRect();
        if (box && box.width <= 260 && box.height <= 90) return ownText;
      }
      // 长文本：按点击 x 估最近的词（元素就在点击点下方，如 user-select:none 的段落）
      if (ownText && ownText.length <= 800 && /[A-Za-z]/.test(ownText)) {
        const word = wordNearXInText(el, ownText, clientX, clientY);
        if (word) return word;
      }
    }

    const sel = window.getSelection();
    const s = sel && !sel.isCollapsed ? String(sel.toString() || '').replace(/\s+/g, ' ').trim() : '';
    return s;
  }

  /** 在元素文本中按点击位置估最近的英文词（行矩形也必须贴近点击点） */
  function wordNearXInText(el, text, clientX, clientY) {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const rects = r.getClientRects();
      if (!rects.length) {
        const words = text.match(/[A-Za-z][A-Za-z'-]*/g);
        return words && words[0] ? words[0] : '';
      }
      // 找离点击点最近的行（同时考虑水平和垂直距离，多行段落才不会挑错行）
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < rects.length; i++) {
        const rc = rects[i];
        if (!rc.width && !rc.height) continue;
        const dx = Math.max(rc.left - clientX, 0, clientX - rc.right);
        const dy = Math.max(rc.top - clientY, 0, clientY - rc.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
          bestD = d;
          best = rc;
        }
      }
      if (!best) best = rects[0];
      // 选中的行必须贴近点击点，否则点的是行间/容器空白
      if (!rectNearPoint(best, clientX, clientY)) return '';
      // 按行内比例估词序
      const ratio = Math.min(0.999, Math.max(0, (clientX - best.left) / Math.max(1, best.width)));
      const words = text.match(/[A-Za-z][A-Za-z'-]*/g);
      if (!words || !words.length) return '';
      const idx = Math.min(words.length - 1, Math.floor(ratio * words.length));
      return words[idx];
    } catch (_) {
      const words = text.match(/[A-Za-z][A-Za-z'-]*/g);
      return words && words[0] ? words[0] : '';
    }
  }

  /** 划词：选了多少就显示多少（只压空白，不砍词） */
  function exactSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    return String(sel.toString() || '').replace(/\s+/g, ' ').trim();
  }

  function sentenceAroundPoint(clientX, clientY) {
    const range = rangeFromPoint(clientX, clientY);
    const node = range && range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return '';
    const text = node.textContent || '';
    const mid = range.startOffset;
    let start = mid;
    let end = mid;
    while (start > 0 && !/[.!?]/.test(text[start - 1])) start--;
    while (end < text.length && !/[.!?]/.test(text[end])) end++;
    if (end < text.length) end++;
    return text.slice(start, end).trim();
  }

  function sentenceAroundSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const node = sel.anchorNode;
    if (!node) return '';
    const text = node.textContent || '';
    const mid = Math.floor(((sel.anchorOffset || 0) + (sel.focusOffset || 0)) / 2);
    let start = mid;
    let end = mid;
    while (start > 0 && !/[.!?]/.test(text[start - 1])) start--;
    while (end < text.length && !/[.!?]/.test(text[end])) end++;
    if (end < text.length) end++;
    return text.slice(start, end).trim();
  }

  /** 是否像完整句子（用于决定要不要附带句译，不改变 head） */
  function looksLikeSentence(s) {
    if (!s) return false;
    const words = s.split(/\s+/).filter(Boolean);
    return words.length >= 8 && /[.!?]["')\]]?$/.test(s);
  }

  /** 双击定位：用「点击处那个词」的矩形，绝不用旧选区（滚动后旧选区会飘出视口） */
  function rectForDblclick(x, y) {
    const range = rangeFromPoint(x, y);
    if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      const node = range.startContainer;
      const text = node.textContent || '';
      let start = range.startOffset;
      let end = range.startOffset;
      while (start > 0 && isWordChar(text.charAt(start - 1))) start--;
      while (end < text.length && isWordChar(text.charAt(end))) end++;
      if (end > start) {
        const wr = document.createRange();
        wr.setStart(node, start);
        wr.setEnd(node, end);
        const r = wr.getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
      }
    }
    return { left: x, top: y, bottom: y + 24, right: x + 40, width: 40, height: 24 };
  }

  function rectFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return { left: 120, top: 120, bottom: 150, right: 220, width: 100, height: 30 };
    }
    let rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      rect = sel.getRangeAt(0).startContainer?.parentElement?.getBoundingClientRect?.();
    }
    return rect || { left: 120, top: 120, bottom: 150, right: 220, width: 100, height: 30 };
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyFontSize() {
    if (!bubble) return;
    bubble.style.fontSize = `${settings.fontSize || 15}px`;
  }

  /**
   * 气泡是 position:fixed → 坐标必须用视口坐标（rect.left/top）
   * 不能加 scrollX/Y（加了会滚出屏幕，表现为「双击没反应」）
   */
  function positionBubble(rect) {
    if (!bubble) return;
    bubble.classList.add('rv-show');
    bubble.style.visibility = 'hidden';
    const bw = bubble.offsetWidth || 240;
    const bh = bubble.offsetHeight || 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let ax = Number(rect.left) || 40;
    let ay = Number(rect.top) || 40;
    if (rect.width != null) ax = Number(rect.left) + Number(rect.width) / 2;
    ax = Math.min(Math.max(ax, 12), Math.max(12, vw - 12));
    ay = Math.min(Math.max(ay, 12), Math.max(12, vh - 12));

    let x = ax - 12;
    let y = ay - bh - 10;
    if (y < 8) y = (Number(rect.bottom) || ay + 24) + 10;

    x = Math.min(Math.max(x, 8), Math.max(8, vw - bw - 8));
    y = Math.min(Math.max(y, 8), Math.max(8, vh - bh - 8));
    bubble.style.left = Math.round(x) + 'px';
    bubble.style.top = Math.round(y) + 'px';
    bubble.style.visibility = 'visible';
    justShownAt = Date.now();
    if (typeof scrollHideTimer !== 'undefined' && scrollHideTimer) {
      clearTimeout(scrollHideTimer);
      scrollHideTimer = null;
    }
  }

  function hideBubble() {
    if (!bubble) return;
    bubble.classList.remove('rv-show');
    current = null;
    if (typeof syncDebug === 'function') syncDebug();
  }

  function updateDock() {
    if (!dock) return;
    dock.innerHTML = `<span class="rv-dock-star">★</span><span class="rv-dock-count">今日 ${todayCount}</span>`;
  }

  function setStatus(msg, isError = false) {
    const el = shadow && shadow.getElementById('rv-status');
    if (!el) return;
    el.textContent = msg;
    el.className = isError ? 'rv-status rv-error' : 'rv-status';
  }

  function renderBubble(payload) {
    try {
      renderBubbleInner(payload);
    } catch (_) {
      // 气泡渲染失败不抛给全局
    }
  }

  function renderBubbleInner(payload) {
    ensureUi();
    applyFontSize();
    const r = payload.result || {};
    // head = 用户选中的原文（长文只作预览，避免气泡爆炸）
    const head = payload.head;
    const isSel = payload.mode === 'selection' || (head && head.split(/\s+/).length > 6);
    const preview = isSel ? (head.length > 160 ? head.slice(0, 160) + '…' : head) : head;
    const wordClass = isSel ? 'rv-word rv-sel' : 'rv-word';

    bubble.innerHTML = `
      <p class="${wordClass}">${escapeHtml(preview)}</p>
      ${isSel ? `<p class="rv-status">已选 ${String(head).split(/\s+/).filter(Boolean).length} 词 · ${String(head).length} 字符</p>` : ''}
      ${r.phonetic ? `<p class="rv-phonetic">${escapeHtml(r.phonetic)}</p>` : ''}
      <p class="rv-meaning" id="rv-meaning">${r.meaning ? escapeHtml(r.meaning) : '<span class="rv-loading">查询中</span>'}</p>
      ${r.pos || r.defEn ? `<p class="rv-meta">${r.pos ? `<span class="rv-pos">${escapeHtml(r.pos)}</span>` : ''}${r.defEn ? escapeHtml(r.defEn) : ''}</p>` : ''}
      ${payload.sentence && payload.sentence !== head ? `
        <div class="rv-sentence-box">
          <p class="rv-sentence-en">${escapeHtml(payload.sentence)}</p>
          <p class="rv-sentence-zh" id="rv-sentence-zh"></p>
        </div>` : ''}
      <div class="rv-actions">
        <button class="rv-btn rv-star ${payload.alreadySaved ? 'rv-saved' : 'rv-primary'}" id="rv-save">★ ${payload.alreadySaved ? '已藏' : '收藏'}</button>
        <button class="rv-btn" id="rv-copy">复制</button>
        ${payload.sentence && payload.sentence !== head ? '<button class="rv-btn" id="rv-sent">整句翻译</button>' : ''}
        ${settings.hotkeysHint ? '<span class="rv-hint">Alt+S 藏 · Esc 关</span>' : ''}
      </div>
      <p class="rv-status" id="rv-status"></p>
    `;

    positionBubble(payload.rect);
    if (isSel && payload.sentence) {
      runSentenceTranslation(payload.sentence);
    }
    if (typeof syncDebug === 'function') syncDebug();
  }

  /** 从指针/点击事件里识别动作按钮（按钮随渲染重建，委托到气泡容器上永不丢监听） */
  function actionFromEvent(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n && (n.id === 'rv-save' || n.id === 'rv-copy' || n.id === 'rv-sent')) return n.id;
    }
    return null;
  }

  function runAction(id) {
    if (!current || !bubble) return;
    if (id === 'rv-save') {
      saveCurrent(shadow.getElementById('rv-save'));
    } else if (id === 'rv-copy') {
      const text = `${current.head} ${(current.result && current.result.meaning) || ''}`.trim();
      navigator.clipboard.writeText(text).then(
        () => setStatus('已复制'),
        () => setStatus('复制失败', true)
      );
    } else if (id === 'rv-sent') {
      runSentenceTranslation(current.sentence);
    }
  }

  // 最近一次按下的动作（用于「页面吞掉 click」时的兜底执行）
  let lastAction = null;

  function wireActionDelegation() {
    if (!bubble) return;
    // ① 常规路径：click 冒泡到气泡容器。监听器挂在容器上，
    //    mousedown/mouseup 之间按钮被重新渲染也能命中（click 落在公共祖先=容器）
    bubble.addEventListener('click', (e) => {
      const id = actionFromEvent(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      if (lastAction && lastAction.id === id) lastAction.done = true;
      runAction(id);
    });
    // ② 兜底：个别站点会把气泡按钮的真实 click 吞在页面层。
    //    监听挂在气泡容器的捕获阶段（影子树内部，能识别具体按钮）：
    //    pointerdown+pointerup 都在同一按钮上、150ms 内没等到 click 就直接执行。
    bubble.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target === bubble) return;
        const id = actionFromEvent(e);
        lastAction = id ? { id, t: Date.now(), done: false } : null;
      },
      true
    );
    bubble.addEventListener(
      'pointerup',
      (e) => {
        if (!lastAction || lastAction.done) return;
        const id = actionFromEvent(e);
        if (!id || id !== lastAction.id) {
          lastAction = null;
          return;
        }
        setTimeout(() => {
          if (!lastAction || lastAction.id !== id || lastAction.done) return;
          lastAction.done = true;
          runAction(id);
        }, 150);
      },
      true
    );
  }

  async function lookupAndShow(head, sentence, rect, mode) {
    try {
      await lookupAndShowInner(head, sentence, rect, mode);
    } catch (e) {
      try {
        const msg = isInvalidContext(e)
          ? '扩展已更新，请刷新本页（Cmd+R）后再查词'
          : '查询失败，请重试';
        if (shadow && shadow.getElementById('rv-status')) {
          setStatus(msg, true);
        } else if (head && rect) {
          // 气泡还没渲染就出错了：弹最小错误气泡，避免失败无声无息
          renderBubble({
            head,
            sentence: '',
            result: { word: head, meaning: msg },
            rect,
            alreadySaved: false,
            mode: mode || 'word',
          });
          setStatus(msg, true);
        }
      } catch (_) {}
    }
  }

  async function lookupAndShowInner(head, sentence, rect, mode) {
    if (!head) return;
    ensureUi();
    const seq = ++lookupSeq;
    const meta = {
      title: document.querySelector('h1')?.innerText?.trim() || document.title || '',
      url: location.href,
    };

    // ★ 词表未命中时 current 可能为 null（mousedown 时 hideBubble 会清空它），
    //   后面 prefetchKey(head, current.sentence…) 会抛 TypeError，被 lookupAndShow
    //   的 try/catch 吞掉 → 气泡完全不出现且无报错。任何查询进来先确保 current 就绪。
    current = {
      head,
      sentence: sentence || '',
      title: meta.title,
      url: meta.url,
      mode: mode || 'word',
      result: (current && current.head === head && current.result) ? current.result : null,
    };

    // ★ 页内词表优先：无论扩展 context 是否有效，命中就秒出
    const local = mode !== 'selection' ? localDictHit(head) : null;
    if (local) {
      const localResult = {
        word: head,
        phonetic: local.phonetic || '',
        pos: local.pos || '',
        meaning: local.meaning || '',
        defEn: local.defEn || '',
      };
      current = {
        head,
        sentence: sentence || '',
        title: meta.title,
        url: meta.url,
        mode: mode || 'word',
        result: localResult,
      };
      renderBubble({
        head,
        sentence: current.sentence,
        result: localResult,
        rect,
        alreadySaved: false,
        mode: mode || 'word',
      });
      if (ctxAlive()) {
        try {
          chrome.runtime
            .sendMessage({ type: 'FIND_WORD', word: head })
            .then((res) => {
              if (seq === lookupSeq && res && res.found) {
                renderBubble({
                  head,
                  sentence: current.sentence,
                  result: localResult,
                  rect,
                  alreadySaved: true,
                  mode: mode || 'word',
                });
              }
            })
            .catch(() => {});
        } catch (_) {}
      }
      return;
    }

    // 词表没有：需要 SW/网络
    if (!ctxAlive()) {
      current = {
        head,
        sentence: sentence || '',
        title: meta.title,
        url: meta.url,
        mode: mode || 'word',
        result: { word: head, meaning: '' },
      };
      renderBubble({
        head,
        sentence: sentence || '',
        result: { word: head, meaning: '' },
        rect,
        alreadySaved: false,
        mode: mode || 'word',
      });
      setStatus('扩展已更新或已重载，请刷新本页后再试', true);
      return;
    }
    // 词表未命中：先查预取缓存
    const pkey = prefetchKey(head, current.sentence || '', mode);
    const cached = prefetchCache.get(pkey);
    if (cached && cached.result && cached.result.meaning) {
      prefetchCache.delete(pkey);
      if (seq !== lookupSeq) return;
      current.result = cached.result;
      renderBubble({
        head,
        sentence: current.sentence,
        result: current.result,
        rect,
        alreadySaved: !!cached.found,
        mode: mode || 'word',
      });
      return;
    }

    // ③ 显示「查询中」，并行 FIND_WORD ∥ LOOKUP
    renderBubble({
      head,
      sentence: current.sentence,
      result: { word: head, meaning: '查询中…' },
      rect,
      alreadySaved: false,
      mode: mode || 'word',
    });

    const pFind = Promise.race([
      chrome.runtime.sendMessage({ type: 'FIND_WORD', word: head }),
      new Promise((resolve) => setTimeout(() => resolve(null), 800)),
    ]).catch(() => null);

    const pLook = Promise.race([
      chrome.runtime.sendMessage({
        type: 'LOOKUP',
        word: head,
        sentence: current.sentence || '',
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]).catch(() => null);

    const [findRes, lookRes] = await Promise.all([pFind, pLook]);
    if (seq !== lookupSeq) return;

    const alreadySaved = !!(findRes && findRes.found);
    let result = lookRes;
    if (!result || !result.meaning) {
      // SW/扩展失效时，页内直接请求翻译
      try {
        const zh = await webTranslate(head);
        result = { word: head, meaning: zh || '' };
      } catch (e2) {
        result = {
          word: head,
          meaning: isInvalidContext(e2) || isInvalidContext(lookRes)
            ? '扩展已更新，请刷新本页（Cmd+R）后再查词'
            : '查询失败，请检查网络后重试',
        };
      }
    }
    current.result = result;
    renderBubble({
      head,
      sentence: current.sentence,
      result,
      rect,
      alreadySaved,
      mode: mode || 'word',
    });
  }

  // (moved up)
  function prefetchKey(head, sentence, mode) {
    return String(head) + '|' + (mode || '') + '|' + String(sentence || '').slice(0, 100);
  }
  function prefetchSet(key, val) {
    if (prefetchCache.size >= PREFETCH_MAX) {
      const k = prefetchCache.keys().next().value;
      prefetchCache.delete(k);
    }
    prefetchCache.set(key, val);
  }

  /** 划词过程中预取译文，mouseup 时直接用 */
  async function prefetchSelection(head, sentence, mode) {
    if (!head || !ctxAlive()) return;
    const key = prefetchKey(head, sentence, mode);
    if (prefetchCache.has(key)) return;
    try {
      const pFind = chrome.runtime.sendMessage({ type: 'FIND_WORD', word: head }).catch(() => null);
      const pLook = chrome.runtime
        .sendMessage({ type: 'LOOKUP', word: head, sentence: sentence || '' })
        .catch(() => null);
      const [found, result] = await Promise.all([pFind, pLook]);
      prefetchSet(key, {
        found: !!(found && found.found),
        result: result || null,
      });
    } catch (_) {}
  }

  /** 扩展被重载后 content script 会失效，给明确提示 */
  /** 扩展 SW 不可用时，content 直接调翻译接口兜底 */
  async function webTranslate(text) {
    const q = String(text || '').trim();
    if (!q) return '';
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dt=bd&dj=1&q=' +
      encodeURIComponent(q.slice(0, 1800));
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.sentences || []).map((s) => s.trans || '').join('');
  }

  function isInvalidContext(e) {
    const msg = String((e && e.message) || e || e || '');
    return /Extension context invalidated|message port closed|Extension is reloading|Receiving end does not exist|The extensions gallery cannot be scripted/i.test(msg);
  }

  function hintError(e) {
    if (isInvalidContext(e)) {
      return '扩展已更新，请刷新本页（Cmd+R）后再查词';
    }
    const msg = String((e && e.message) || e || '');
    return '查询失败：' + msg;
  }

  async function runSentenceTranslation(sentence) {
    const zh = shadow && shadow.getElementById('rv-sentence-zh');
    if (!zh) return;
    zh.classList.add('rv-loading');
    zh.textContent = '翻译中';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TRANSLATE_SENTENCE', text: sentence });
      if (res && res.text) {
        zh.classList.remove('rv-loading');
        zh.textContent = res.text;
        return;
      }
      throw new Error((res && res.error) || 'empty');
    } catch (e) {
      // 扩展上下文失效 / SW 挂了：页内直连翻译
      try {
        const text = await webTranslate(sentence);
        zh.classList.remove('rv-loading');
        zh.textContent = text || '（无译文）';
      } catch (e2) {
        zh.classList.remove('rv-loading');
        if (isInvalidContext(e) || isInvalidContext(e2)) {
          zh.textContent = '扩展已更新，请刷新本页（Cmd+R）后再翻译';
        } else {
          zh.textContent = '翻译失败，请检查网络';
        }
      }
    }
  }

  async function saveCurrent(btn) {
    if (!current || saving) return;
    saving = true;
    const headText = String(current.head || '');
    const isLong = headText.split(/\s+/).length > 6 || headText.length > 60;
    // 长选区：生词取前 2 个实词，例句放选中原文
    const words = headText.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const savedWord = isLong ? words.slice(0, 2).join(' ') : headText;
    const payload = {
      word: savedWord,
      phonetic: (current.result && current.result.phonetic) || '',
      pos: (current.result && current.result.pos) || '',
      meaning: (current.result && current.result.meaning) || '',
      defEn: (current.result && current.result.defEn) || '',
      sentence: isLong ? headText.slice(0, 1000) : (current.sentence || ''),
      title: current.title || '',
      url: current.url || '',
    };
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SAVE_WORD', entry: payload });
      if (res && res.ok) {
        if (res.created) {
          todayCount += 1;
          updateDock();
        }
        if (btn) {
          btn.classList.add('rv-saved', 'rv-pop');
          btn.classList.remove('rv-primary');
          btn.textContent = res.created ? '★ 已藏' : '★ 已更新';
          setTimeout(() => btn.classList.remove('rv-pop'), 300);
        }
        setStatus(res.created ? '已加入生词本' : '已更新该词条');
      } else {
        setStatus((res && res.error) || '收藏失败', true);
      }
    } catch (e) {
      setStatus(hintError(e).replace('查询失败', '收藏失败'), true);
    } finally {
      saving = false;
    }
  }

  /** 页内词表：命中直接用，不发消息 */
  function getLocalDict() {
    try {
      return (
        (typeof self !== 'undefined' && self.RV_LOCAL_DICT) ||
        (typeof window !== 'undefined' && window.RV_LOCAL_DICT) ||
        {}
      );
    } catch (_) {
      return {};
    }
  }

  /**
   * 词形还原候选：新闻里点到的多是变形词（says/warned/planning/officials），
   * 去词缀后重查原形。只处理规则屈折，不做语义猜测。
   */
  function lemmaCandidates(w) {
    const out = [];
    const push = (x) => {
      if (x && x.length > 2 && out.indexOf(x) === -1) out.push(x);
    };
    const deDouble = (x) =>
      x.length > 3 && x.charAt(x.length - 1) === x.charAt(x.length - 2)
        ? x.slice(0, -1)
        : '';
    const lower = w.toLowerCase();
    push(lower);
    if (lower.endsWith('ies') && lower.length > 4) push(lower.slice(0, -3) + 'y'); // studies→study
    if (lower.endsWith('ves') && lower.length > 4) {
      push(lower.slice(0, -3) + 'f'); // knives→knif → knife 走 fe 分支
      push(lower.slice(0, -3) + 'fe'); // knives→knife
    }
    if (lower.endsWith('es') && lower.length > 3) push(lower.slice(0, -2)); // watches→watch
    if (lower.endsWith('s') && lower.length > 3) push(lower.slice(0, -1)); // says→say, officials→official
    if (lower.endsWith('ied') && lower.length > 4) push(lower.slice(0, -3) + 'y'); // satisfied→satisfy
    if (lower.endsWith('ed')) {
      push(lower.slice(0, -2)); // warned→warn
      push(deDouble(lower.slice(0, -2))); // stopped→stopp→stop
    }
    if (lower.endsWith('ing')) {
      push(lower.slice(0, -3) + 'e'); // making→make
      push(deDouble(lower.slice(0, -3))); // planning→plann→plan
    }
    return out;
  }

  function localDictHit(word) {
    const dict = getLocalDict();
    const w = String(word || '').trim();
    if (!w || /\s/.test(w)) return null;
    const cands = lemmaCandidates(w);
    for (let i = 0; i < cands.length; i++) {
      const hit = dict[cands[i]];
      if (hit) {
        // 命中的是原形时提示一下，避免用户疑惑词义对不上
        const lemma = cands[i] !== w.toLowerCase() ? cands[i] : '';
        const phonetic = [hit.phonetic || '', lemma ? '原形 ' + lemma : '']
          .filter(Boolean)
          .join(' · ');
        return Object.assign({}, hit, { phonetic });
      }
    }
    return null;
  }

  function ctxAlive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function fromUi(target) {
    // 闭式 shadow root 下，文档层监听器拿到的事件 target 就是 host，
    // 但 composedPath() 会返回空数组（shadow 内部路径对外不可见），
    // 所以这里必须直接比较 target === host，不能用 path.indexOf(host)。
    return !!host && target === host;
  }

  // —— 双击：坐标取词 + 精确 head ——
  document.addEventListener(
    'dblclick',
    (e) => {
      if (fromUi(e.target)) return;
      // YouTube 字幕：双击取词时拦下播放器的全屏切换
      if (ytCaptionPress) {
        e.preventDefault();
        e.stopPropagation();
      }
      // 带链接的生词（如下划线的 propane）双击不要跳走
      if (e.target && e.target.closest && e.target.closest('a')) {
        e.preventDefault();
        e.stopPropagation();
      }
      ignoreSelectUntil = Date.now() + 280;
      if (selectTimer) {
        clearTimeout(selectTimer);
        selectTimer = null;
      }

      const head = headFromEvent(e);
      if (!head) return;
      // 与刚弹出的内容相同则不重复查询（字幕双击会先触发两次 click 再到 dblclick）
      if (current && current.head === head && Date.now() - justShownAt < 800) return;

      const rect = rectForDblclick(e.clientX, e.clientY);
      // 双击默认只查这个词；附带上下文句便于理解，但不改变 head
      const sentence = sentenceAroundPoint(e.clientX, e.clientY);
      lookupAndShow(head, sentence && sentence !== head ? sentence : '', rect).catch(function(){});
    },
    true
  );

  // 部分站点吞掉 dblclick，用 detail===2 的 click 兜底
  document.addEventListener(
    'click',
    (e) => {
      if (fromUi(e.target)) return;
      // YouTube 字幕：单击取词并拦下播放器的暂停反应（没取到词则放行）
      if (ytCaptionPress && maxDrag < 3) {
        const word = headFromDblclick(e.clientX, e.clientY);
        if (word && /^[A-Za-z]/.test(word)) {
          e.preventDefault();
          e.stopPropagation();
          ignoreSelectUntil = Date.now() + 300;
          if (selectTimer) {
            clearTimeout(selectTimer);
            selectTimer = null;
          }
          const same = current && current.head === word && Date.now() - justShownAt < 800;
          if (!same) {
            const sentence = sentenceAroundPoint(e.clientX, e.clientY);
            lookupAndShow(word, sentence && sentence !== word ? sentence : '', rectForDblclick(e.clientX, e.clientY)).catch(function () {});
          }
          return;
        }
        ytCaptionPress = null;
      }
      if (e.detail === 2) {
        // 双击兜底
        ignoreSelectUntil = Date.now() + 280;
        if (selectTimer) {
          clearTimeout(selectTimer);
          selectTimer = null;
        }
        const head = headFromEvent(e);
        if (!head) return;
        if (current && current.head === head && Date.now() - justShownAt < 800) return;
        const rect = rectForDblclick(e.clientX, e.clientY);
        const sentence = sentenceAroundPoint(e.clientX, e.clientY);
        lookupAndShow(head, sentence && sentence !== head ? sentence : '', rect).catch(function(){});
      }
    },
    true
  );

  // —— 松开鼠标：有选区用选区；没选区则取光标下单词（解决点选/禁选站点） ——
  document.addEventListener(
    'mouseup',
    (e) => {
      if (fromUi(e.target)) return;
      if (e.button !== 0) return;
      const x = e.clientX;
      const y = e.clientY;
      const evtTarget = e.target;
      if (selectTimer) clearTimeout(selectTimer);
      selectTimer = setTimeout(() => {
        // 双击手势会让路
        if (Date.now() < ignoreSelectUntil) return;

        const dist = Math.max(maxDrag, Math.hypot(x - downX, y - downY));
        const selText = exactSelection();

        let head = '';
        let rect = null;
        let mode = 'word';

        // 单击：永远取点击处单词（不要用残留选区）
        // 划词：由 selectionchange 主通道负责；这里仅在拖拽>2px 时兜底
        const dragged = downAt > 0 && dist > 2;
        if (dragged && selText && selText.length >= 2) {
          head = selText;
          rect = rectFromSelection();
          const words = head.split(/\s+/).filter(Boolean).length;
          if (words > 6 || head.length > 60) mode = 'selection';
        } else {
          head = headFromEvent({ target: evtTarget, clientX: x, clientY: y }) || headFromDblclick(x, y);
          const headWords = head ? head.split(/\s+/).filter(Boolean).length : 0;
          if (head && headWords <= 3 && /[A-Za-z]/.test(head)) {
            rect = rectForDblclick(x, y);
          } else {
            const m2 = String(head || '').match(/[A-Za-z][A-Za-z'-]*/g);
            if (m2 && m2.length) {
              head = m2[0];
              rect = rectForDblclick(x, y);
            } else {
              return;
            }
          }
        }

        if (!head) return;

        let sentence = '';
        if (mode === 'selection') {
          sentence = head;
        } else if (looksLikeSentence(head) && settings.sentenceDefault) {
          sentence = head;
        } else {
          const around = sentenceAroundSelection() || sentenceAroundPoint(x, y);
          if (around && around !== head && looksLikeSentence(around)) sentence = around;
        }

        lookupAndShow(head, sentence, rect, mode).catch(function(){});
      }, 100);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      if (fromUi(e.target)) return;
      // YouTube 字幕区按下：记录，click 时拦截播放器的暂停/全屏反应
      ytCaptionPress = ytCaptionHit(e.target);
      downX = e.clientX;
      downY = e.clientY;
      downAt = Date.now();
      maxDrag = 0;
      if (e.detail >= 2) return;
      // 记录是否真的在拖选
      const onMove = (ev) => {
        const d = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        if (d > maxDrag) maxDrag = d;
        // 拖选中预取：与用户选完重叠网络时间
        // 仅拖选且选区偏长才预取，避免刷请求拖慢单击
        if (d > 8) {
          clearTimeout(prefetchTimer);
          prefetchTimer = setTimeout(() => {
            const phrase = exactSelection();
            if (phrase && phrase.length >= 24 && phrase.length <= 800) {
              const words = phrase.split(/\s+/).filter(Boolean).length;
              const mode = words > 6 || phrase.length > 60 ? 'selection' : 'word';
              if (mode === 'selection') {
                prefetchSelection(phrase, phrase, mode);
              }
            }
          }, 180);
        }
      };
      document.addEventListener('mousemove', onMove, { capture: true, passive: true });
      const stopMove = function () {
        document.removeEventListener('mousemove', onMove, true);
      };
      document.addEventListener('mouseup', stopMove, { capture: true, once: true });
      setTimeout(stopMove, 4000);
      if (Date.now() - justShownAt < 300) return;
      hideBubble();
    },
    true
  );

  // —— 划词主通道：选区稳定后出窗（比只靠 mouseup 稳） ——
  let selDebounce = null;
  document.addEventListener(
    'selectionchange',
    () => {
      clearTimeout(selDebounce);
      selDebounce = setTimeout(() => {
        try {
          if (Date.now() < ignoreSelectUntil) return;
          const text = exactSelection();
          if (!text || text.length < 2 || text.length > 2000) return;
          // 单击造成的空/极短选区不处理
          const words = text.split(/\s+/).filter(Boolean).length;
          if (words < 2 && text.length < 12) return;
          // 与刚弹出的内容相同则跳过
          if (current && current.head === text && Date.now() - justShownAt < 800) return;
          const rect = rectFromSelection();
          const mode = words > 6 || text.length > 60 ? 'selection' : 'word';
          const sentence = mode === 'selection' ? text : '';
          lookupAndShow(text, sentence, rect, mode).catch(function () {});
        } catch (_) {}
      }, 140);
    },
    true
  );

  // —— 复制触发整句翻译：Cmd+C 复制句子时自动弹出整句翻译气泡（不影响复制本身） ——
  let lastCopyText = '';
  let lastCopyAt = 0;
  document.addEventListener('copy', () => {
    try {
      const text = exactSelection();
      if (!text || text.length < 8 || text.length > 2000) return;
      const now = Date.now();
      if (text === lastCopyText && now - lastCopyAt < 800) return;
      lastCopyText = text;
      lastCopyAt = now;
      lookupAndShow(text, text, rectFromSelection(), 'selection').catch(function () {});
    } catch (_) {}
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideBubble();
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      const btn = shadow && shadow.getElementById('rv-save');
      if (btn) {
        e.preventDefault();
        btn.click();
      }
    }
    if (e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
      } catch (_) {}
    }
  });

  window.addEventListener(
    'scroll',
    () => {
      // 刚弹出时的微小滚动/scrollIntoView 不要立刻关掉
      if (Date.now() - justShownAt < 350) return;
      if (scrollHideTimer) clearTimeout(scrollHideTimer);
      scrollHideTimer = setTimeout(() => {
        // 滚动后 120ms 内用户又点了词（气泡刚弹出），别用滚动前遗留的定时器把它关掉
        if (Date.now() - justShownAt < 350) return;
        hideBubble();
      }, 120);
    },
    { passive: true }
  );

  async function init() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res && res.settings) Object.assign(settings, res.settings);
      const stat = await chrome.runtime.sendMessage({ type: 'GET_TODAY_COUNT' });
      todayCount = (stat && stat.count) || 0;
    } catch (_) {}
    ensureUi();
    updateDock();
    applyFontSize();
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'SETTINGS_UPDATED' && msg.settings) {
        Object.assign(settings, msg.settings);
        applyFontSize();
      }
      if (msg && msg.type === 'CMD_SAVE') {
        const btn = shadow && shadow.getElementById('rv-save');
        if (btn) btn.click();
      }
    });
  }

  // 自动化验证钩子（不暴露密钥）；同步纯数据便于无头断言
  function syncDebug() {
    window.__rvState = {
      head: (current && current.head) || '',
      visible: !!(bubble && bubble.classList.contains('rv-show')),
      meaning: (current && current.result && current.result.meaning) || '',
      bubbleText: (bubble && bubble.textContent) || '',
    };
  }
  window.__rvDebug = {
    peek: function (x, y) {
      try { return headFromDblclick(x, y); } catch (e) { return 'ERR:' + e.message; }
    },
    lookupNow: function (x, y) {
      const h = headFromDblclick(x, y);
      if (h) lookupAndShow(h, '', { left: x, top: y, bottom: y + 24, right: x + 24, width: 24, height: 24 }).catch(function () {});
      return h;
    },
    head: () => (current && current.head) || '',
    visible: () => !!(bubble && bubble.classList.contains('rv-show')),
    meaning: () => (current && current.result && current.result.meaning) || '',
    bubbleText: () => (bubble && bubble.textContent) || '',
    bubbleRect: () => {
      if (!bubble) return null;
      const r = bubble.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        inViewport:
          r.width > 0 &&
          r.height > 0 &&
          r.top >= -2 &&
          r.left >= -2 &&
          r.bottom <= window.innerHeight + 2 &&
          r.right <= window.innerWidth + 2,
      };
    },
    saveBtnRect: () => {
      if (!shadow || !bubble) return null;
      const b = shadow.getElementById('rv-save');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        pe: getComputedStyle(b).pointerEvents,
        bubblePE: getComputedStyle(bubble).pointerEvents,
        shown: bubble.classList.contains('rv-show'),
      };
    },
  };

  init().then(syncDebug);
  ['dblclick', 'mouseup', 'click'].forEach((type) => {
    document.addEventListener(
      type,
      () => {
        setTimeout(syncDebug, 80);
      },
      true
    );
  });
  syncDebug();
})();
