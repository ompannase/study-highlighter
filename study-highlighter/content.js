(() => {
  const COLORS = { yellow: '#fff176', green: '#a5d6a7', pink: '#f8bbd0' };
  const PAGE_KEY = 'hl:' + normalizeUrl(location.href);
  let highlights = [];

  /* ---------- helpers ---------- */
  function normalizeUrl(u) {
    const url = new URL(u);
    url.hash = '';
    [...url.searchParams.keys()].forEach((k) => {
      if (/^(utm_|fbclid|gclid)/i.test(k)) url.searchParams.delete(k);
    });
    return url.origin + url.pathname + url.search;
  }

  function getTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  const getFullText = () => getTextNodes().map((n) => n.data).join('');

  function debounce(fn, ms) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function save() {
    chrome.storage.local.set({ [PAGE_KEY]: highlights });
  }

  /* ---------- finding a saved highlight again ---------- */
  function findAnchor(h, full) {
    let i = full.indexOf(h.prefix + h.exact + h.suffix);
    if (i !== -1) return i + h.prefix.length;
    i = full.indexOf(h.prefix + h.exact);
    if (i !== -1) return i + h.prefix.length;
    i = full.indexOf(h.exact + h.suffix);
    if (i !== -1) return i;
    return full.indexOf(h.exact); // -1 if not found
  }

  /* ---------- drawing a highlight ---------- */
  function wrap(start, end, h) {
    const targets = [];
    let pos = 0;
    for (const n of getTextNodes()) {
      const len = n.data.length;
      const s = Math.max(start, pos);
      const e = Math.min(end, pos + len);
      if (s < e) targets.push({ n, from: s - pos, to: e - pos });
      pos += len;
      if (pos >= end) break;
    }
    for (const t of targets) {
      if (t.n.parentElement.closest('script,style,noscript')) continue;
      let node = t.n;
      if (t.from > 0) node = node.splitText(t.from);
      if (t.to - t.from < node.data.length) node.splitText(t.to - t.from);
      const mark = document.createElement('mark');
      mark.className = 'hl-mark';
      mark.dataset.hlId = h.id;
      mark.style.backgroundColor = COLORS[h.color] || COLORS.yellow;
      mark.style.color = 'inherit';
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
    }
  }

  function applyPending() {
    let pending = 0;
    for (const h of highlights) {
      if (document.querySelector(`mark[data-hl-id="${h.id}"]`)) continue;
      const i = findAnchor(h, getFullText());
      if (i === -1) { pending++; continue; }
      wrap(i, i + h.exact.length, h);
    }
    return pending;
  }

  /* ---------- create / remove ---------- */
  function createHighlight(color) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const exact = range.toString();
    if (!exact.trim()) return;

    const pre = document.createRange();
    pre.selectNodeContents(document.body);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const full = getFullText();

    const h = {
      id: crypto.randomUUID(),
      exact,
      prefix: full.slice(Math.max(0, start - 30), start),
      suffix: full.slice(start + exact.length, start + exact.length + 30),
      color,
      createdAt: Date.now()
    };
    wrap(start, start + exact.length, h);
    sel.removeAllRanges();
    highlights.push(h);
    save();
  }

  function removeHighlight(id) {
    document.querySelectorAll(`mark[data-hl-id="${id}"]`).forEach((m) => {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    highlights = highlights.filter((h) => h.id !== id);
    save();
  }

  /* ---------- floating toolbar (inside shadow DOM) ---------- */
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:absolute;z-index:2147483647;display:none;top:0;left:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .bar { display:flex; gap:6px; padding:6px; background:#222; border-radius:8px;
             box-shadow:0 2px 8px rgba(0,0,0,.35); font:13px system-ui,sans-serif; }
      button { border:none; cursor:pointer; border-radius:50%; width:22px; height:22px; }
      button.rm { border-radius:6px; width:auto; padding:0 10px; height:22px; background:#e57373; color:#fff; }
    </style>
    <div class="bar"></div>`;
  document.documentElement.appendChild(host);
  const bar = shadow.querySelector('.bar');

  function showBar(rect, mode, id) {
    bar.innerHTML = '';
    if (mode === 'create') {
      for (const [name, hex] of Object.entries(COLORS)) {
        const b = document.createElement('button');
        b.style.background = hex;
        b.title = 'Highlight ' + name;
        b.onmousedown = (e) => e.preventDefault(); // keep the text selected
        b.onclick = () => { createHighlight(name); hideBar(); };
        bar.appendChild(b);
      }
    } else {
      const b = document.createElement('button');
      b.className = 'rm';
      b.textContent = 'Remove';
      b.onclick = () => { removeHighlight(id); hideBar(); };
      bar.appendChild(b);
    }
    host.style.left = window.scrollX + rect.left + 'px';
    host.style.top = window.scrollY + rect.top - 40 + 'px';
    host.style.display = 'block';
  }

  function hideBar() { host.style.display = 'none'; }

  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes(host)) hideBar();
  });

  document.addEventListener('mouseup', (e) => {
    if (e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        showBar(sel.getRangeAt(0).getBoundingClientRect(), 'create');
        return;
      }
      const mark = e.target.closest && e.target.closest('mark.hl-mark');
      if (mark) showBar(mark.getBoundingClientRect(), 'remove', mark.dataset.hlId);
    }, 0);
  });

  /* ---------- load saved highlights on page open ---------- */
  chrome.storage.local.get(PAGE_KEY).then((res) => {
    highlights = res[PAGE_KEY] || [];
    if (!highlights.length) return;
    if (applyPending() === 0) return;
    // Some pages load content late; keep retrying for 20 seconds.
    const obs = new MutationObserver(debounce(() => {
      if (applyPending() === 0) obs.disconnect();
    }, 500));
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 20000);
  });
})();
