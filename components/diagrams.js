/*!
 * 図の部品 (依存なし)
 *   .diagram       関連図 / ズームマップ (ノードと矢印、データの流れ、クリックで詳細・ズーム、入れ子の詳細図)
 *   .er-diagram    ER 図 (テーブル・列・リレーションを自動配置、クリックで関連を強調)
 *   .seq-diagram   シーケンス図 (メッセージを 1 本ずつ再生)
 *   .chart         データチャート (棒・横棒・折れ線・円・ドーナツ)
 *   .stack3d       3D 分解図 (CSS 3D。レイヤーを立体的に分解して見せる)
 *   .compare       ビフォー・アフター (境界をドラッグして 2 つを比べる)
 *   .terminal      ターミナル再生 (コマンドを入力しながら出力を表示)
 *
 * AI が書くのはデータだけ: 要素の中に <script type="application/json"> を置く (3D 分解図は HTML)。
 * 共通の仕組み:
 *   - steps: steps[0] が最初の表示、steps[1..] が → キーで進むたびの表示 (エンジンのステップと連動)
 *   - クリックで詳細パネル、Esc / 背景クリックで元に戻る
 *   - 印刷 (PDF)・一覧では、全体を表示した静止状態になる
 * 書き方は docs/authoring-guide.md の「図の部品」を参照。
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var Deck = window.Deck;
  var IS_PRINT = Deck && Deck.mode === 'print';
  var instances = [];

  // ------------------------------------------------------------------
  // 共通ユーティリティ
  // ------------------------------------------------------------------
  function s(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] != null) e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    var p = String(Math.round(n * 100) / 100).split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }
  /** 文字幅の見積もり (全角 = 1 文字分、半角 = 0.6 文字分)。フォント読み込み前でも同じ結果になるように計算で求める */
  function textWidth(str, fs) {
    var w = 0;
    for (var i = 0; i < String(str).length; i++) w += String(str).charCodeAt(i) > 255 ? fs : fs * 0.6;
    return w;
  }
  /** 複数行の文字 (\n 区切り) を SVG text に入れる */
  function setLines(textEl, str, lineHeight) {
    var lines = String(str == null ? '' : str).split('\n');
    var start = -((lines.length - 1) * lineHeight) / 2;
    lines.forEach(function (line, i) {
      var t = s('tspan', { x: textEl.getAttribute('x'), dy: i === 0 ? start : lineHeight }, textEl);
      t.textContent = line;
    });
  }
  function readData(container) {
    var script = container.querySelector(':scope > script[type="application/json"]');
    if (!script) return null;
    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      console.error('[diagram] JSON を読めません: ' + e.message);
      h('div', 'dg-error', container, '図のデータ (JSON) を読めません: ' + esc(e.message));
      return null;
    }
  }
  function track(promise) { if (Deck && Deck.track) Deck.track(promise); return promise; }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  /** 部品のステップ用の目印。エンジンはこれを .step として数え、→ キーで visible を付ける */
  function addStepMarkers(container, count) {
    var markers = [];
    for (var i = 0; i < count; i++) markers.push(h('i', 'step dg-step', container));
    return function current() {
      var n = 0;
      markers.forEach(function (m) { if (m.classList.contains('visible')) n++; });
      return n;
    };
  }

  /** スライドのステップ変化 (入ったとき・戻ったときを含む) と離脱を購読する */
  function onSlideState(container, onStep, onLeave) {
    var slide = container.closest('section.slide');
    if (!slide) return;
    slide.addEventListener('deck:step', function () { onStep(); });
    slide.addEventListener('deck:leave', function () { if (onLeave) onLeave(); });
  }

  // ------------------------------------------------------------------
  // カメラ (SVG の viewBox を動かしてズーム・移動する)
  // ------------------------------------------------------------------
  function Camera(svgEl, full) {
    this.svg = svgEl;
    this.full = full.slice();
    this.vb = full.slice();
    this.raf = 0;
    this.apply(this.vb);
  }
  Camera.prototype.apply = function (vb) {
    this.vb = vb;
    this.svg.setAttribute('viewBox', vb.map(function (v) { return Math.round(v * 10) / 10; }).join(' '));
  };
  /** 矩形 [x, y, w, h] が収まるように移動する (表示枠の縦横比に合わせ、余白を付ける) */
  Camera.prototype.fit = function (rect, animate) {
    var box = this.svg.getBoundingClientRect();
    var aspect = box.width && box.height ? box.width / box.height : this.full[2] / this.full[3];
    var m = 0.07;
    var w = rect[2] * (1 + m * 2), hh = rect[3] * (1 + m * 2);
    if (w / hh > aspect) hh = w / aspect; else w = hh * aspect;
    var target = [rect[0] + rect[2] / 2 - w / 2, rect[1] + rect[3] / 2 - hh / 2, w, hh];
    return this.to(target, animate);
  };
  Camera.prototype.reset = function (animate) { return this.to(this.full, animate); };
  Camera.prototype.to = function (target, animate) {
    var self = this;
    cancelAnimationFrame(this.raf);
    if (!animate || IS_PRINT) { this.apply(target.slice()); return Promise.resolve(); }
    var from = this.vb.slice(), start = null, dur = 650;
    return track(new Promise(function (resolve) {
      function frame(t) {
        if (start == null) start = t;
        var p = Math.min(1, (t - start) / dur), k = ease(p);
        self.apply(from.map(function (v, i) { return v + (target[i] - v) * k; }));
        if (p < 1) self.raf = requestAnimationFrame(frame); else resolve();
      }
      self.raf = requestAnimationFrame(frame);
    }));
  };

  // ------------------------------------------------------------------
  // 詳細パネル・説明バー
  // ------------------------------------------------------------------
  function Panel(container, onClose) {
    var el = h('div', 'dg-panel', container);
    el.hidden = true;
    var close = h('button', 'dg-panel-close', el, '×');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    close.addEventListener('click', function (ev) { ev.stopPropagation(); onClose(); });
    var title = h('div', 'dg-panel-title', el);
    var body = h('div', 'dg-panel-body', el);
    el.addEventListener('click', function (ev) { ev.stopPropagation(); });
    return {
      show: function (t, html) { title.textContent = t || ''; body.innerHTML = html || ''; el.hidden = false; },
      hide: function () { el.hidden = true; },
    };
  }

  function Caption(container) {
    var el = h('div', 'dg-caption', container);
    el.hidden = true;
    return {
      set: function (text) { el.textContent = text || ''; el.hidden = !text; },
    };
  }

  // ------------------------------------------------------------------
  // 自動配置 (階層型): 矢印の向きに沿って列 (LR) / 行 (TB) に並べる
  // ------------------------------------------------------------------
  function autoLayout(nodes, edges, dir, gapMain, gapCross) {
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; n._rank = 0; });
    var es = edges.filter(function (e) { return byId[e.from] && byId[e.to] && e.from !== e.to; });
    for (var iter = 0; iter < nodes.length; iter++) {
      var changed = false;
      es.forEach(function (e) {
        var r = byId[e.from]._rank + 1;
        if (byId[e.to]._rank < r && r < nodes.length) { byId[e.to]._rank = r; changed = true; }
      });
      if (!changed) break;
    }
    // 入ってくる矢印のないノードは、つながる先のすぐ手前の列に寄せる (線が他のノードの裏を通らないように)
    nodes.forEach(function (n) {
      if (es.some(function (e) { return e.to === n.id; })) return;
      var next = es.filter(function (e) { return e.from === n.id; }).map(function (e) { return byId[e.to]._rank; });
      if (next.length) n._rank = Math.max(0, Math.min.apply(null, next) - 1);
    });
    var ranks = [];
    nodes.forEach(function (n) { (ranks[n._rank] = ranks[n._rank] || []).push(n); });
    var main = 0;
    ranks.forEach(function (rank) {
      if (!rank) return;
      var size = 0, cross = 0;
      rank.forEach(function (n) { size = Math.max(size, dir === 'TB' ? n.h : n.w); cross += (dir === 'TB' ? n.w : n.h) + gapCross; });
      cross -= gapCross;
      var pos = -cross / 2;
      rank.forEach(function (n) {
        if (n._fixed) return;
        if (dir === 'TB') { n.x = pos; n.y = main + (size - n.h) / 2; pos += n.w + gapCross; }
        else { n.x = main + (size - n.w) / 2; n.y = pos; pos += n.h + gapCross; }
      });
      main += size + gapMain;
    });
  }

  function bounds(items) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    items.forEach(function (n) { x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h); });
    return [x1, y1, x2 - x1, y2 - y1];
  }

  /** 矩形の中心から相手の方向へ伸ばした線が、矩形の枠と交わる点 */
  function borderPoint(n, tx, ty) {
    var cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    var sx = dx ? (n.w / 2) / Math.abs(dx) : Infinity, sy = dy ? (n.h / 2) / Math.abs(dy) : Infinity;
    var k = Math.min(sx, sy);
    return [cx + dx * k, cy + dy * k];
  }

  function arrowDefs(svgEl, uid) {
    var defs = s('defs', null, svgEl);
    ['n', 'a'].forEach(function (k) {
      var m = s('marker', { id: uid + '-arrow-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'dg-arrow-' + k }, m);
    });
    var open = s('marker', { id: uid + '-open', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, defs);
    s('path', { d: 'M0 0 L10 5 L0 10', class: 'dg-arrow-open' }, open);
    return defs;
  }

  var uidSeq = 0;

  // ------------------------------------------------------------------
  // 関連図 / ズームマップ (.diagram)
  // ------------------------------------------------------------------
  function normNode(n, isChild) {
    var hasChildren = n.children && n.children.nodes && n.children.nodes.length;
    var w = n.w || (hasChildren ? 600 : Math.max(isChild ? 220 : 260, textWidth(longestLine(n.label), 30) + 60));
    return {
      id: String(n.id), label: n.label == null ? n.id : n.label, sub: n.sub || '', detail: n.detail || '',
      kind: n.kind || '', accent: !!n.accent, w: w, h: n.h || (hasChildren ? 380 : (n.sub ? 130 : 110)),
      x: n.x, y: n.y, _fixed: n.x != null && n.y != null, children: hasChildren ? n.children : null,
    };
  }
  function longestLine(str) {
    return String(str == null ? '' : str).split('\n').reduce(function (a, b) { return textWidth(b, 1) > textWidth(a, 1) ? b : a; }, '');
  }

  function renderDiagram(container) {
    var data = readData(container);
    if (!data || !Array.isArray(data.nodes)) return;
    var uid = 'dg' + (++uidSeq);
    var dir = data.direction === 'TB' ? 'TB' : 'LR';
    var zoomMode = !!data.zoom;
    container.classList.add('dg');

    var svgEl = s('svg', { class: 'dg-svg', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': data.title || '図' });
    container.insertBefore(svgEl, container.firstChild);
    arrowDefs(svgEl, uid);
    var layerGroups = s('g', { class: 'dg-groups' }, svgEl);
    var layerEdges = s('g', { class: 'dg-edges' }, svgEl);
    var layerNodes = s('g', { class: 'dg-nodes' }, svgEl);

    var nodes = data.nodes.map(function (n) { return normNode(n, false); });
    var edges = (data.edges || []).map(function (e, i) { return Object.assign({ key: e.from + '->' + e.to, idx: i }, e); });
    if (nodes.some(function (n) { return !n._fixed; })) autoLayout(nodes, edges, dir, data.gap || 160, data.gapCross || 70);
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    // グループ (枠で囲む)
    (data.groups || []).forEach(function (g) {
      var members = (g.nodes || []).map(function (id) { return byId[id]; }).filter(Boolean);
      if (!members.length) return;
      var b = bounds(members), pad = 40;
      var gg = s('g', { class: 'dg-group' }, layerGroups);
      s('rect', { x: b[0] - pad, y: b[1] - pad - 36, width: b[2] + pad * 2, height: b[3] + pad * 2 + 36, rx: 18 }, gg);
      var t = s('text', { x: b[0] - pad + 20, y: b[1] - pad - 6, class: 'dg-group-label' }, gg);
      t.textContent = g.label || '';
      g._rect = [b[0] - pad, b[1] - pad - 36, b[2] + pad * 2, b[3] + pad * 2 + 36];
    });

    drawEdges(layerEdges, edges, byId, uid, 'top');
    nodes.forEach(function (n) { drawNode(layerNodes, n, uid, dir); });

    var all = nodes.slice();
    (data.groups || []).forEach(function (g) { if (g._rect) all.push({ x: g._rect[0], y: g._rect[1], w: g._rect[2], h: g._rect[3] }); });
    var b = bounds(all), pad = 50;
    var cam = new Camera(svgEl, [b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2]);
    var panel = Panel(container, function () { clearSelection(true); });
    var caption = Caption(container);
    var steps = Array.isArray(data.steps) ? data.steps : [];
    var stepNow = steps.length > 1 ? addStepMarkers(container, steps.length - 1) : function () { return 0; };
    var selected = null;

    function nodeEls(id) { return layerNodes.querySelector('[data-id="' + CSS.escape(id) + '"]'); }

    function setFocus(focusIds, flowKeys) {
      var focus = focusIds && focusIds.length ? new Set(focusIds) : null;
      var flow = flowKeys ? new Set(flowKeys) : null;
      container.classList.toggle('has-focus', !!focus);
      layerNodes.querySelectorAll(':scope > .dg-node').forEach(function (g) {
        g.classList.toggle('is-focus', !!focus && focus.has(g.getAttribute('data-id')));
      });
      layerEdges.querySelectorAll(':scope > .dg-edge').forEach(function (g) {
        var e = edges[Number(g.getAttribute('data-idx'))];
        var on = !!focus && focus.has(e.from) && focus.has(e.to);
        var flowing = flow ? flow.has(e.key) : !!e.flow;
        g.classList.toggle('is-focus', on || (!!flow && flow.has(e.key)));
        g.classList.toggle('is-flowing', flowing && !IS_PRINT);
      });
    }

    function openNode(n, animate) {
      layerNodes.querySelectorAll('.dg-node.is-open').forEach(function (g) { g.classList.remove('is-open'); });
      if (!n) return cam.reset(animate);
      var g = nodeEls(n.id);
      if (n.children && g) g.classList.add('is-open');
      return cam.fit([n.x, n.y, n.w, n.h], animate);
    }

    function applyStep(animate) {
      selected = null;
      panel.hide();
      var st = steps[stepNow()] || {};
      setFocus(st.focus, st.flow);
      caption.set(st.note);
      var z = st.zoom && byId[st.zoom];
      openNode(z || null, animate);
      if (st.select && byId[st.select]) showDetail(byId[st.select]);
    }

    function neighbors(id) {
      var set = [id];
      edges.forEach(function (e) { if (e.from === id) set.push(e.to); if (e.to === id) set.push(e.from); });
      return set;
    }

    function showDetail(n) {
      if (n.children && !n.detail) return; // 中身を持つノードの sub は「クリックで…」の案内なので出さない
      if (n.detail || n.sub) panel.show(String(n.label).replace(/\n/g, ' '), n.detail || esc(n.sub));
    }

    function select(id) {
      var n = byId[id];
      if (!n) return;
      if (selected === id) { clearSelection(true); return; }
      selected = id;
      setFocus(neighbors(id), edges.filter(function (e) { return e.from === id || e.to === id; }).map(function (e) { return e.key; }));
      if (zoomMode || n.children) openNode(n, true);
      showDetail(n);
    }

    function clearSelection(animate) {
      if (!selected && panel && container.querySelector('.dg-panel').hidden) return false;
      applyStep(animate);
      return true;
    }

    layerNodes.addEventListener('click', function (ev) {
      var g = ev.target.closest('.dg-node[data-id]');
      if (!g) return;
      ev.stopPropagation();
      var kids = g.closest('.dg-children');
      if (kids) { // 開いている詳細図の中のノード → その説明を表示
        if (kids.closest('.dg-node.is-open') && g._node) showDetail(g._node);
        return;
      }
      select(g.getAttribute('data-id'));
    });
    svgEl.addEventListener('click', function () { if (selected) clearSelection(true); });

    instances.push({ container: container, reset: function () { return selected ? clearSelection(true) : false; } });
    onSlideState(container, function () { applyStep(true); }, function () { selected = null; });
    if (IS_PRINT) { setFocus(null, null); cam.reset(false); } else applyStep(false);
  }

  function drawEdges(layer, edges, byId, uid) {
    edges.forEach(function (e, i) {
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) { console.warn('[diagram] 矢印の端のノードがありません: ' + e.from + ' -> ' + e.to); return; }
      var p1 = borderPoint(a, b.x + b.w / 2, b.y + b.h / 2), p2 = borderPoint(b, a.x + a.w / 2, a.y + a.h / 2);
      var g = s('g', { class: 'dg-edge' + (e.style === 'dashed' ? ' is-dashed' : ''), 'data-idx': e.idx != null ? e.idx : i }, layer);
      var id = uid + '-e' + i + '-' + Math.random().toString(36).slice(2, 7);
      var d;
      if (e.curve) {
        var mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2, nx = -(p2[1] - p1[1]) * 0.25, ny = (p2[0] - p1[0]) * 0.25;
        d = 'M' + p1[0] + ' ' + p1[1] + ' Q' + (mx + nx) + ' ' + (my + ny) + ' ' + p2[0] + ' ' + p2[1];
      } else {
        d = 'M' + p1[0] + ' ' + p1[1] + ' L' + p2[0] + ' ' + p2[1];
      }
      s('path', { id: id, d: d, class: 'dg-edge-line', 'marker-end': 'url(#' + uid + '-arrow-n)', 'marker-start': e.both ? 'url(#' + uid + '-arrow-n)' : null }, g);
      s('path', { d: d, class: 'dg-edge-line dg-edge-hi', 'marker-end': 'url(#' + uid + '-arrow-a)', 'marker-start': e.both ? 'url(#' + uid + '-arrow-a)' : null }, g);
      // データの流れ (線の上を点が移動)
      for (var k = 0; k < 3; k++) {
        var dot = s('circle', { r: 9, class: 'dg-dot' }, g);
        var am = s('animateMotion', { dur: (e.speed || 1.8) + 's', repeatCount: 'indefinite', begin: (k * (e.speed || 1.8) / 3).toFixed(2) + 's' }, dot);
        s('mpath', { href: '#' + id }, am);
      }
      if (e.label) {
        var mxl = (p1[0] + p2[0]) / 2, myl = (p1[1] + p2[1]) / 2;
        var t = s('text', { x: mxl, y: myl - 14, class: 'dg-edge-label' }, g);
        t.textContent = e.label;
      }
    });
  }

  function drawNode(layer, n, uid, dir) {
    var g = s('g', { class: 'dg-node' + (n.kind ? ' is-' + n.kind : '') + (n.accent ? ' is-accent' : '') + (n.children ? ' has-children' : '') + (n.detail ? ' has-detail' : ''), 'data-id': n.id }, layer);
    g._node = n;
    if (n.kind === 'db') {
      var ry = 22;
      s('path', { class: 'dg-shape', d: 'M' + n.x + ' ' + (n.y + ry) + ' a' + n.w / 2 + ' ' + ry + ' 0 0 1 ' + n.w + ' 0 v' + (n.h - ry * 2) + ' a' + n.w / 2 + ' ' + ry + ' 0 0 1 -' + n.w + ' 0 z' }, g);
      s('path', { class: 'dg-shape-line', d: 'M' + n.x + ' ' + (n.y + ry) + ' a' + n.w / 2 + ' ' + ry + ' 0 0 0 ' + n.w + ' 0' }, g);
    } else {
      s('rect', { class: 'dg-shape', x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'user' ? n.h / 2 : 16 }, g);
    }
    var cx = n.x + n.w / 2;
    if (n.children) {
      var lt = s('text', { x: cx, y: n.y + 46, class: 'dg-label' }, g);
      lt.textContent = String(n.label).replace(/\n/g, ' ');
      var hint = s('text', { x: cx, y: n.y + n.h - 26, class: 'dg-hint' }, g);
      hint.textContent = n.sub || 'クリックで詳細';
      drawChildren(g, n, uid, dir);
    } else {
      var t = s('text', { x: cx, y: n.y + n.h / 2 + (n.sub ? -12 : 0), class: 'dg-label' }, g);
      setLines(t, n.label, 36);
      if (n.sub) {
        var st = s('text', { x: cx, y: n.y + n.h / 2 + 30, class: 'dg-sub' }, g);
        st.textContent = n.sub;
      }
    }
    if (n.detail && !n.children) s('circle', { cx: n.x + n.w - 18, cy: n.y + 18, r: 7, class: 'dg-detail-mark' }, g);
  }

  /** 入れ子の詳細図: 親ノードの中に縮小して描き、ズームすると見えるようにする */
  function drawChildren(parentG, parent, uid, dir) {
    var c = parent.children;
    var kids = c.nodes.map(function (n) { return normNode(n, true); });
    var kEdges = (c.edges || []).map(function (e, i) { return Object.assign({ key: e.from + '->' + e.to, idx: i }, e); });
    if (kids.some(function (n) { return !n._fixed; })) autoLayout(kids, kEdges, c.direction === 'TB' ? 'TB' : dir, 120, 50);
    var b = bounds(kids);
    var inner = [parent.x + 30, parent.y + 80, parent.w - 60, parent.h - 140];
    var k = Math.min(inner[2] / b[2], inner[3] / b[3], 1);
    var tx = inner[0] + (inner[2] - b[2] * k) / 2 - b[0] * k, ty = inner[1] + (inner[3] - b[3] * k) / 2 - b[1] * k;
    // 全体表示では薄く見せ、ズームすると読める大きさになる (縮小表示中の文字は検査の対象外)
    var g = s('g', { class: 'dg-children allow-small', transform: 'translate(' + tx + ' ' + ty + ') scale(' + k + ')' }, parentG);
    var byId = {};
    kids.forEach(function (n) { byId[n.id] = n; });
    drawEdges(s('g', { class: 'dg-edges' }, g), kEdges, byId, uid);
    var ng = s('g', { class: 'dg-nodes' }, g);
    kids.forEach(function (n) { drawNode(ng, n, uid, dir); });
  }

  // ------------------------------------------------------------------
  // ER 図 (.er-diagram)
  // ------------------------------------------------------------------
  var ER = { fs: 24, row: 44, head: 58, padX: 22 };

  function parseColumn(c) {
    if (typeof c === 'object') return { name: c.name, type: c.type || '', pk: !!c.pk, fk: !!c.fk, note: c.note || '' };
    var parts = String(c).trim().split(/\s+/);
    var col = { name: parts.shift(), type: '', pk: false, fk: false, note: '' };
    var rest = [];
    parts.forEach(function (p) {
      if (/^PK$/i.test(p)) col.pk = true;
      else if (/^FK$/i.test(p)) col.fk = true;
      else rest.push(p);
    });
    col.type = rest.join(' ');
    return col;
  }

  function renderER(container) {
    var data = readData(container);
    if (!data || !Array.isArray(data.tables)) return;
    var uid = 'er' + (++uidSeq);
    container.classList.add('dg', 'is-er');
    var svgEl = s('svg', { class: 'dg-svg', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': data.title || 'ER 図' });
    container.insertBefore(svgEl, container.firstChild);
    var layerRel = s('g', { class: 'dg-edges' }, svgEl);
    var layerTables = s('g', { class: 'dg-nodes' }, svgEl);

    var tables = data.tables.map(function (t) {
      var cols = (t.columns || []).map(parseColumn);
      var wName = Math.max(textWidth(t.label || t.name, 28) + 40, 0);
      var wCols = cols.reduce(function (m, c) { return Math.max(m, 56 + textWidth(c.name, ER.fs) + 30 + textWidth(c.type, ER.fs * 0.85)); }, 0);
      return {
        id: t.name, label: t.label || t.name, detail: t.detail || '', cols: cols,
        w: t.w || Math.max(300, wName, wCols + ER.padX * 2), h: ER.head + cols.length * ER.row + 10,
        x: t.x, y: t.y, _fixed: t.x != null && t.y != null,
      };
    });
    var byId = {};
    tables.forEach(function (t) { byId[t.id] = t; });
    var rels = (data.relations || []).map(function (r, i) {
      var f = String(r.from).split('.'), to = String(r.to).split('.');
      var card = String(r.card || 'N:1').split(':');
      return { idx: i, from: f[0], fromCol: f[1], to: to[0], toCol: to[1], cardFrom: card[0], cardTo: card[1] || '1', label: r.label || '' };
    });
    // 参照される側 (PK) を左に置く
    if (tables.some(function (t) { return !t._fixed; })) {
      autoLayout(tables, rels.map(function (r) { return { from: r.to, to: r.from }; }), data.direction === 'TB' ? 'TB' : 'LR', data.gap || 200, data.gapCross || 60);
    }

    tables.forEach(function (t) {
      var g = s('g', { class: 'dg-node er-table', 'data-id': t.id }, layerTables);
      s('rect', { class: 'dg-shape', x: t.x, y: t.y, width: t.w, height: t.h, rx: 12 }, g);
      s('path', { class: 'er-head', d: 'M' + t.x + ' ' + (t.y + ER.head) + ' V' + (t.y + 12) + ' q0 -12 12 -12 H' + (t.x + t.w - 12) + ' q12 0 12 12 V' + (t.y + ER.head) + ' Z' }, g);
      var title = s('text', { x: t.x + t.w / 2, y: t.y + ER.head / 2 + 10, class: 'er-title' }, g);
      title.textContent = t.label;
      t.cols.forEach(function (c, i) {
        var y = t.y + ER.head + i * ER.row;
        var row = s('g', { class: 'er-row' + (c.pk ? ' is-pk' : '') + (c.fk ? ' is-fk' : ''), 'data-col': c.name }, g);
        s('rect', { class: 'er-row-bg', x: t.x + 4, y: y + 3, width: t.w - 8, height: ER.row - 4, rx: 6 }, row);
        if (c.pk || c.fk) {
          var badge = s('text', { x: t.x + ER.padX, y: y + ER.row / 2 + 8, class: 'er-key' }, row);
          badge.textContent = c.pk ? 'PK' : 'FK';
        }
        var name = s('text', { x: t.x + ER.padX + 50, y: y + ER.row / 2 + 9, class: 'er-col' }, row);
        name.textContent = c.name;
        if (c.type) {
          var type = s('text', { x: t.x + t.w - ER.padX, y: y + ER.row / 2 + 8, class: 'er-type' }, row);
          type.textContent = c.type;
        }
      });
    });

    function colY(t, col) {
      var i = t.cols.findIndex(function (c) { return c.name === col; });
      return t.y + (i < 0 ? ER.head / 2 : ER.head + i * ER.row + ER.row / 2);
    }
    rels.forEach(function (r) {
      var a = byId[r.from], b = byId[r.to];
      if (!a || !b) { console.warn('[er] テーブルがありません: ' + r.from + ' -> ' + r.to); return; }
      var y1 = colY(a, r.fromCol), y2 = colY(b, r.toCol), x1, x2, d1, d2;
      if (b.x >= a.x + a.w) { x1 = a.x + a.w; x2 = b.x; d1 = 1; d2 = -1; }
      else if (b.x + b.w <= a.x) { x1 = a.x; x2 = b.x + b.w; d1 = -1; d2 = 1; }
      else { x1 = a.x + a.w; x2 = b.x + b.w; d1 = 1; d2 = 1; }
      var bend = Math.max(60, Math.abs(x2 - x1) / 2);
      var d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + d1 * bend) + ' ' + y1 + ' ' + (x2 + d2 * bend) + ' ' + y2 + ' ' + x2 + ' ' + y2;
      var g = s('g', { class: 'dg-edge er-rel', 'data-idx': r.idx }, layerRel);
      s('path', { class: 'dg-edge-line', d: d }, g);
      s('path', { class: 'dg-edge-line dg-edge-hi', d: d }, g);
      cardMark(g, x1, y1, d1, r.cardFrom);
      cardMark(g, x2, y2, d2, r.cardTo);
      if (r.label) {
        var t = s('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 12, class: 'dg-edge-label' }, g);
        t.textContent = r.label;
      }
    });

    var b = bounds(tables), pad = 60;
    var cam = new Camera(svgEl, [b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2]);
    var panel = Panel(container, function () { applyStep(true); });
    var caption = Caption(container);
    var steps = Array.isArray(data.steps) ? data.steps : [];
    var stepNow = steps.length > 1 ? addStepMarkers(container, steps.length - 1) : function () { return 0; };
    var selected = null;

    function setState(visibleIds, focusIds, keyCols) {
      var vis = visibleIds ? new Set(visibleIds) : null;
      var focus = focusIds && focusIds.length ? new Set(focusIds) : null;
      container.classList.toggle('has-focus', !!focus);
      layerTables.querySelectorAll('.er-table').forEach(function (g) {
        var id = g.getAttribute('data-id');
        g.classList.toggle('is-hidden', !!vis && !vis.has(id));
        g.classList.toggle('is-focus', !!focus && focus.has(id));
        g.querySelectorAll('.er-row').forEach(function (row) {
          row.classList.toggle('is-key', !!keyCols && keyCols.has(id + '.' + row.getAttribute('data-col')));
        });
      });
      layerRel.querySelectorAll('.er-rel').forEach(function (g) {
        var r = rels[Number(g.getAttribute('data-idx'))];
        g.classList.toggle('is-hidden', !!vis && !(vis.has(r.from) && vis.has(r.to)));
        g.classList.toggle('is-focus', !!focus && focus.has(r.from) && focus.has(r.to) && (!selected || r.from === selected || r.to === selected));
      });
    }

    function applyStep(animate) {
      selected = null;
      panel.hide();
      var n = stepNow();
      if (!steps.length) { setState(null, null, null); caption.set(''); return; }
      var shown = [];
      for (var i = 0; i <= n && i < steps.length; i++) shown = shown.concat(steps[i].show || []);
      var st = steps[n] || {};
      setState(shown.length ? shown : null, st.focus, null);
      caption.set(st.note);
      if (animate !== null) cam.reset(animate);
    }

    function select(id) {
      if (selected === id) { applyStep(true); return; }
      selected = id;
      var related = [id], keys = new Set();
      rels.forEach(function (r) {
        if (r.from === id || r.to === id) {
          related.push(r.from === id ? r.to : r.from);
          keys.add(r.from + '.' + r.fromCol);
          keys.add(r.to + '.' + r.toCol);
        }
      });
      var vis = null;
      if (steps.length) { vis = []; for (var i = 0; i <= stepNow(); i++) vis = vis.concat(steps[i].show || []); if (!vis.length) vis = null; }
      setState(vis, related, keys);
      var t = byId[id];
      var html = (t.detail ? '<p>' + t.detail + '</p>' : '') + '<table class="er-detail">' + t.cols.map(function (c) {
        return '<tr><td>' + (c.pk ? '<b>PK</b> ' : c.fk ? 'FK ' : '') + esc(c.name) + '</td><td>' + esc(c.type) + '</td></tr>';
      }).join('') + '</table>';
      panel.show(t.label, html);
    }

    layerTables.addEventListener('click', function (ev) {
      var g = ev.target.closest('.er-table');
      if (!g || g.classList.contains('is-hidden')) return;
      ev.stopPropagation();
      select(g.getAttribute('data-id'));
    });
    svgEl.addEventListener('click', function () { if (selected) applyStep(true); });
    instances.push({ container: container, reset: function () { if (!selected) return false; applyStep(true); return true; } });
    onSlideState(container, function () { applyStep(true); }, function () { selected = null; });
    if (IS_PRINT) setState(null, null, null); else applyStep(false);
  }

  /** カーディナリティの記号: 1 = 縦線、N / M / * = 鳥の足 */
  function cardMark(g, x, y, dir, card) {
    var c = String(card).toUpperCase();
    if (c === 'N' || c === 'M' || c === '*') {
      s('path', { class: 'er-card', d: 'M' + (x + dir * 26) + ' ' + y + ' L' + x + ' ' + (y - 14) + ' M' + (x + dir * 26) + ' ' + y + ' L' + x + ' ' + (y + 14) + ' M' + (x + dir * 26) + ' ' + y + ' L' + x + ' ' + y }, g);
    } else {
      s('path', { class: 'er-card', d: 'M' + (x + dir * 18) + ' ' + (y - 14) + ' V' + (y + 14) }, g);
    }
  }

  // ------------------------------------------------------------------
  // シーケンス図 (.seq-diagram)
  // ------------------------------------------------------------------
  function renderSequence(container) {
    var data = readData(container);
    if (!data || !Array.isArray(data.participants)) return;
    var uid = 'sq' + (++uidSeq);
    container.classList.add('dg', 'is-seq');
    var svgEl = s('svg', { class: 'dg-svg', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': data.title || 'シーケンス図' });
    container.insertBefore(svgEl, container.firstChild);
    arrowDefs(svgEl, uid);

    var ps = data.participants.map(function (p) { return typeof p === 'string' ? { id: p, label: p } : { id: p.id, label: p.label || p.id }; });
    var msgs = data.messages || [];
    var W = Math.max(1600, ps.length * 320), spacing = W / ps.length, boxW = Math.min(spacing - 50, 300), boxH = 84;
    var rowH = data.rowHeight || 86, top = 40, firstY = top + boxH + 70;
    var endY = firstY + msgs.length * rowH;
    var xOf = {};
    ps.forEach(function (p, i) {
      var cx = spacing * i + spacing / 2;
      xOf[p.id] = cx;
      var g = s('g', { class: 'dg-node seq-part' }, svgEl);
      s('line', { class: 'seq-life', x1: cx, y1: top + boxH, x2: cx, y2: endY + 20 }, g);
      s('rect', { class: 'dg-shape', x: cx - boxW / 2, y: top, width: boxW, height: boxH, rx: 14 }, g);
      var t = s('text', { x: cx, y: top + boxH / 2, class: 'dg-label' }, g);
      setLines(t, p.label, 34);
    });

    var msgEls = msgs.map(function (m, i) {
      var y = firstY + i * rowH;
      var x1 = xOf[m.from], x2 = xOf[m.to];
      if (x1 == null || x2 == null) { console.warn('[seq] 参加者がいません: ' + m.from + ' -> ' + m.to); return null; }
      var type = m.type || 'sync';
      var g = s('g', { class: 'seq-msg is-' + type, 'data-i': i }, svgEl);
      var d = m.from === m.to
        ? 'M' + x1 + ' ' + (y - 20) + ' h90 v40 h-84'
        : 'M' + x1 + ' ' + y + ' H' + (x2 + (x2 > x1 ? -4 : 4));
      s('path', { class: 'seq-line', d: d, pathLength: 1, 'marker-end': 'url(#' + uid + (type === 'sync' ? '-arrow-n)' : '-open)') }, g);
      var lx = m.from === m.to ? x1 + 110 : (x1 + x2) / 2;
      var t = s('text', { x: lx, y: (m.from === m.to ? y + 8 : y - 16), class: 'seq-label' + (m.from === m.to ? ' is-self' : '') }, g);
      t.textContent = (data.numbered === false ? '' : (i + 1) + '. ') + (m.label || '');
      return g;
    });

    var cam = new Camera(svgEl, [0, 0, W, endY + 50]);
    void cam;
    var caption = Caption(container);
    var panel = Panel(container, function () { apply(); });
    var initial = Math.max(0, Math.min(msgs.length, data.initial || 0));
    var auto = data.steps !== false;
    var stepNow = auto && msgs.length > initial ? addStepMarkers(container, msgs.length - initial) : function () { return msgs.length - initial; };
    var lastShown = -1;

    function apply() {
      panel.hide();
      var shown = initial + stepNow();
      msgEls.forEach(function (g, i) {
        if (!g) return;
        g.classList.toggle('is-hidden', i >= shown);
        g.classList.toggle('is-current', auto && i === shown - 1 && shown > initial);
        g.classList.toggle('is-new', i >= lastShown && i < shown && !IS_PRINT);
      });
      var cur = msgs[shown - 1];
      caption.set(auto && shown > initial && cur ? cur.note : '');
      lastShown = shown;
    }

    svgEl.addEventListener('click', function (ev) {
      var g = ev.target.closest('.seq-msg');
      if (!g || g.classList.contains('is-hidden')) return;
      var m = msgs[Number(g.getAttribute('data-i'))];
      if (m && m.note) panel.show((Number(g.getAttribute('data-i')) + 1) + '. ' + (m.label || ''), esc(m.note));
    });
    instances.push({ container: container, reset: function () { if (container.querySelector('.dg-panel').hidden) return false; panel.hide(); return true; } });
    onSlideState(container, apply, function () { lastShown = -1; });
    if (IS_PRINT) { msgEls.forEach(function (g) { if (g) g.classList.remove('is-hidden'); }); } else apply();
  }

  // ------------------------------------------------------------------
  // データチャート (.chart)
  // ------------------------------------------------------------------
  var PALETTE = ['var(--accent)', 'var(--accent-2)', 'var(--accent-3)', 'var(--danger)', 'var(--success)', 'var(--muted)'];

  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * p;
  }

  function renderChart(container) {
    var data = readData(container);
    if (!data || !Array.isArray(data.series)) return;
    container.classList.add('dg', 'is-chart');
    var type = data.type || 'bar';
    var H = 820, ow = container.offsetWidth, oh = container.offsetHeight;
    var W = ow && oh ? Math.round(Math.max(600, Math.min(2000, (H * ow) / oh))) : 1600;
    if ((type === 'pie' || type === 'donut') && W < 1300) H = Math.max(H, 760 + ((data.labels || []).length) * 52);
    var svgEl = s('svg', { class: 'dg-svg', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': data.title || 'グラフ' }, null);
    container.insertBefore(svgEl, container.firstChild);
    var labels = data.labels || [];
    var series = data.series.map(function (se, i) { return { name: se.name || ('系列' + (i + 1)), data: se.data || [], color: se.color || PALETTE[i % PALETTE.length], i: i }; });
    var unit = data.unit || '';
    var tip = h('div', 'chart-tip', container);
    tip.hidden = true;

    // 凡例 (クリックで系列の表示を切り替え)
    var legend = s('g', { class: 'chart-legend' }, svgEl);
    var lx = W - 20;
    (type === 'pie' || type === 'donut' ? [] : series).slice().reverse().forEach(function (se) {
      var tw = textWidth(se.name, 28) + 50;
      lx -= tw;
      var g = s('g', { class: 'chart-legend-item', 'data-s': se.i }, legend);
      s('rect', { x: lx, y: 14, width: 24, height: 24, rx: 5, style: 'fill:' + se.color }, g);
      var t = s('text', { x: lx + 34, y: 35 }, g);
      t.textContent = se.name;
      lx -= 20;
    });

    var plot = s('g', { class: 'chart-plot' }, svgEl);
    if (type === 'pie' || type === 'donut') drawPie(plot, series[0], labels, type, W, H, tip, unit);
    else drawAxes(plot, series, labels, type, W, H, tip, unit, data);

    legend.addEventListener('click', function (ev) {
      var g = ev.target.closest('.chart-legend-item');
      if (!g) return;
      var i = g.getAttribute('data-s');
      g.classList.toggle('is-off');
      plot.querySelectorAll('[data-s="' + i + '"]').forEach(function (e) { e.classList.toggle('is-off'); });
    });

    // ステップ: series = 系列を 1 つずつ、points = 項目を 1 つずつ
    var mode = data.steps;
    if (mode === 'series' || mode === 'points') {
      var total = mode === 'series' ? series.length : labels.length;
      var stepNow = addStepMarkers(container, Math.max(0, total - 1));
      var apply = function () {
        var n = stepNow() + 1;
        plot.querySelectorAll(mode === 'series' ? '[data-s]' : '[data-p]').forEach(function (e) {
          var k = Number(e.getAttribute(mode === 'series' ? 'data-s' : 'data-p'));
          e.classList.toggle('is-pending', k >= n && !IS_PRINT);
        });
      };
      onSlideState(container, apply);
      apply();
    }
  }

  function showTip(tip, container, ev, html) {
    var r = container.getBoundingClientRect();
    tip.innerHTML = html;
    tip.hidden = false;
    var k = r.width / container.offsetWidth || 1;
    tip.style.left = ((ev.clientX - r.left) / k + 16) + 'px';
    tip.style.top = ((ev.clientY - r.top) / k - 10) + 'px';
  }

  function drawAxes(plot, series, labels, type, W, H, tip, unit, data) {
    var horizontal = type === 'hbar';
    var x0 = horizontal ? 60 + Math.max.apply(null, labels.map(function (l) { return textWidth(l, 26); }).concat([60])) : 130;
    var y0 = 70, pw = W - x0 - 50, ph = H - y0 - 90;
    var stacked = !!data.stacked && type !== 'line';
    var max = data.max || niceMax(Math.max.apply(null, labels.map(function (_, j) {
      return stacked ? series.reduce(function (a, se) { return a + (se.data[j] || 0); }, 0) : Math.max.apply(null, series.map(function (se) { return se.data[j] || 0; }));
    }).concat([0])));
    var ticks = 5;
    var axis = s('g', { class: 'chart-axis' }, plot);
    for (var t = 0; t <= ticks; t++) {
      var v = (max / ticks) * t;
      if (horizontal) {
        var gx = x0 + (pw * t) / ticks;
        s('line', { class: 'chart-grid', x1: gx, y1: y0, x2: gx, y2: y0 + ph }, axis);
        var tx = s('text', { x: gx, y: y0 + ph + 40, class: 'chart-tick is-x' }, axis);
        tx.textContent = fmt(v);
      } else {
        var gy = y0 + ph - (ph * t) / ticks;
        s('line', { class: 'chart-grid', x1: x0, y1: gy, x2: x0 + pw, y2: gy }, axis);
        var ty = s('text', { x: x0 - 16, y: gy + 9, class: 'chart-tick is-y' }, axis);
        ty.textContent = fmt(v);
      }
    }
    if (unit) {
      var u = s('text', { x: horizontal ? x0 + pw : x0 - 16, y: horizontal ? y0 + ph + 80 : y0 - 24, class: 'chart-unit' }, axis);
      u.textContent = '(' + unit + ')';
    }
    var band = (horizontal ? ph : pw) / Math.max(1, labels.length);
    labels.forEach(function (l, j) {
      var c = (horizontal ? y0 : x0) + band * j + band / 2;
      var lt = s('text', horizontal ? { x: x0 - 16, y: c + 9, class: 'chart-tick is-y' } : { x: c, y: y0 + ph + 42, class: 'chart-tick is-x' }, axis);
      lt.textContent = l;
    });

    if (type === 'line') {
      series.forEach(function (se) {
        var pts = se.data.map(function (v, j) { return [x0 + band * j + band / 2, y0 + ph - (ph * (v || 0)) / max]; });
        var g = s('g', { class: 'chart-series', 'data-s': se.i, style: '--c:' + se.color }, plot);
        s('path', { class: 'chart-line', d: pts.map(function (p, j) { return (j ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' '), pathLength: 1 }, g);
        pts.forEach(function (p, j) {
          var pg = s('g', { class: 'chart-point', 'data-p': j, style: '--i:' + j }, g);
          var c = s('circle', { cx: p[0], cy: p[1], r: 9 }, pg);
          if (labels.length <= 16) {
            var vt = s('text', { x: p[0], y: p[1] - 20, class: 'chart-value' }, pg);
            vt.textContent = fmt(se.data[j]);
          }
          c.addEventListener('mousemove', function (ev) { showTip(tip, plot.closest('.chart'), ev, '<b>' + esc(se.name) + '</b> ' + esc(labels[j]) + ': ' + fmt(se.data[j]) + esc(unit)); });
          c.addEventListener('mouseleave', function () { tip.hidden = true; });
        });
      });
      return;
    }

    var nSeries = stacked ? 1 : series.length;
    var inner = band * 0.72, bw = inner / nSeries;
    var acc = labels.map(function () { return 0; });
    series.forEach(function (se, si) {
      var g = s('g', { class: 'chart-series', 'data-s': se.i, style: '--c:' + se.color }, plot);
      se.data.forEach(function (v, j) {
        var len = ((horizontal ? pw : ph) * (v || 0)) / max;
        var base = stacked ? ((horizontal ? pw : ph) * acc[j]) / max : 0;
        var off = (horizontal ? y0 : x0) + band * j + (band - inner) / 2 + (stacked ? 0 : bw * si);
        var bg = s('g', { class: 'chart-bar', 'data-p': j, style: '--i:' + (j + si * 0.5) }, g);
        var r = horizontal
          ? s('rect', { x: x0 + base, y: off + 2, width: Math.max(0, len), height: bw - 4, rx: 4 }, bg)
          : s('rect', { x: off + 2, y: y0 + ph - base - len, width: bw - 4, height: Math.max(0, len), rx: 4 }, bg);
        if (labels.length * nSeries <= 30 && v) {
          var vt = s('text', horizontal
            ? { x: x0 + base + len + 10, y: off + bw / 2 + 9, class: 'chart-value is-h' }
            : { x: off + bw / 2, y: y0 + ph - base - len - 12, class: 'chart-value' }, bg);
          vt.textContent = fmt(v);
        }
        r.addEventListener('mousemove', function (ev) { showTip(tip, plot.closest('.chart'), ev, '<b>' + esc(se.name) + '</b> ' + esc(labels[j]) + ': ' + fmt(v) + esc(unit)); });
        r.addEventListener('mouseleave', function () { tip.hidden = true; });
        acc[j] += v || 0;
      });
    });
    plot.classList.add(horizontal ? 'is-h' : 'is-v');
  }

  function drawPie(plot, se, labels, type, W, H, tip, unit) {
    if (!se) return;
    var total = se.data.reduce(function (a, v) { return a + (v || 0); }, 0) || 1;
    // 横長なら凡例を右、縦長 (狭い) なら下に置く
    var wide = W >= 1300;
    var r = wide ? 330 : Math.min(300, W / 2 - 60), ri = type === 'donut' ? r * 0.58 : 0;
    var cx = wide ? W / 2 - 200 : W / 2, cy = wide ? H / 2 + 20 : r + 60;
    var a0 = -Math.PI / 2;
    se.data.forEach(function (v, j) {
      var a1 = a0 + (Math.PI * 2 * (v || 0)) / total, large = a1 - a0 > Math.PI ? 1 : 0;
      var p = function (rad, a) { return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)]; };
      var o1 = p(r, a0), o2 = p(r, a1), i1 = p(ri, a1), i2 = p(ri, a0);
      var d = 'M' + o1 + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + o2 + (ri ? ' L' + i1 + ' A' + ri + ' ' + ri + ' 0 ' + large + ' 0 ' + i2 + ' Z' : ' L' + cx + ' ' + cy + ' Z');
      var g = s('g', { class: 'chart-slice', 'data-p': j, style: '--i:' + j + ';--c:' + PALETTE[j % PALETTE.length] }, plot);
      var path = s('path', { d: d }, g);
      var pct = Math.round(((v || 0) / total) * 1000) / 10;
      // 凡例 (右側)
      var ly = wide ? cy - (labels.length * 56) / 2 + j * 56 : cy + r + 90 + j * 52;
      var lx0 = wide ? cx + r + 120 : 80;
      s('rect', { x: lx0, y: ly - 20, width: 26, height: 26, rx: 5, style: 'fill:var(--c)' }, g);
      var lt = s('text', { x: lx0 + 40, y: ly + 2, class: 'chart-pie-label' }, g);
      lt.textContent = (labels[j] || '') + '  ' + pct + '%';
      path.addEventListener('mousemove', function (ev) { showTip(tip, plot.closest('.chart'), ev, '<b>' + esc(labels[j]) + '</b> ' + fmt(v) + esc(unit) + ' (' + pct + '%)'); });
      path.addEventListener('mouseleave', function () { tip.hidden = true; });
      a0 = a1;
    });
  }

  // ------------------------------------------------------------------
  // 3D 分解図 (.stack3d)
  //   <div class="stack3d"><div class="layer3d" data-detail="説明">UI</div>…</div> (先頭が一番上)
  //   data-explode="step" … → キーで分解 (既定はスライド表示時に分解)
  // ------------------------------------------------------------------
  function renderStack(container) {
    var layers = Array.prototype.slice.call(container.querySelectorAll(':scope > .layer3d'));
    if (!layers.length) return;
    container.classList.add('dg-stack', 'allow-overlap'); // 層が重なるのは意図どおり
    var inner = h('div', 'stack3d-inner', null);
    container.insertBefore(inner, layers[0]);
    layers.forEach(function (l, i) {
      l.style.setProperty('--z', String(layers.length - 1 - i - (layers.length - 1) / 2)); // 中央を 0 にする
      inner.appendChild(l);
    });
    var panel = Panel(container, function () { clear(); });
    var byStep = container.getAttribute('data-explode') === 'step';
    var stepNow = byStep ? addStepMarkers(container, 1) : null;
    var rot = Number(container.getAttribute('data-rotate') || -28);

    function setExploded() { container.classList.toggle('is-exploded', IS_PRINT || !byStep || stepNow() > 0); }
    function clear() {
      layers.forEach(function (l) { l.classList.remove('is-selected'); });
      container.classList.remove('has-focus');
      panel.hide();
    }
    inner.addEventListener('click', function (ev) {
      var l = ev.target.closest('.layer3d');
      if (!l || document.body.classList.contains('deck-editing')) return;
      ev.stopPropagation();
      var on = !l.classList.contains('is-selected');
      clear();
      if (!on) return;
      l.classList.add('is-selected');
      container.classList.add('has-focus');
      if (l.getAttribute('data-detail')) panel.show(l.textContent.trim(), esc(l.getAttribute('data-detail')));
    });
    // ドラッグで回転
    var dragX = null, base = rot;
    container.addEventListener('pointerdown', function (ev) { if (ev.target.closest('.dg-panel')) return; dragX = ev.clientX; base = rot; });
    window.addEventListener('pointermove', function (ev) {
      if (dragX == null) return;
      rot = base + (ev.clientX - dragX) * 0.3;
      container.style.setProperty('--rot', rot + 'deg');
    });
    window.addEventListener('pointerup', function () { dragX = null; });
    container.style.setProperty('--rot', rot + 'deg');
    instances.push({ container: container, reset: function () { if (!container.classList.contains('has-focus')) return false; clear(); return true; } });
    onSlideState(container, function () { setExploded(); }, function () { clear(); });
    setExploded();
  }

  // ------------------------------------------------------------------
  // ビフォー・アフター (.compare)
  //   <div class="compare" data-before="改善前" data-after="改善後">
  //     <div>…改善前…</div><div>…改善後…</div>
  //   </div>
  //   境界をドラッグして比べる。data-reveal="step" で → キーを押すと改善後へスライド。印刷では左右に並べる
  // ------------------------------------------------------------------
  function renderCompare(container) {
    var items = Array.prototype.slice.call(container.children).filter(function (e) { return e.tagName !== 'SCRIPT' && !e.classList.contains('dg-step'); });
    if (items.length < 2) { console.warn('[compare] 子要素を 2 つ (改善前・改善後) 置いてください'); return; }
    container.classList.add('dg-compare', 'allow-overlap'); // 2 つを重ねて表示するのは意図どおり
    items[0].classList.add('compare-item', 'is-before');
    items[1].classList.add('compare-item', 'is-after');
    // ラベルは項目の外 (枠) に置く。項目の中に入れると、文字編集の保存でソースに書き込まれてしまう
    [['is-before', container.getAttribute('data-before') || 'Before'], ['is-after', container.getAttribute('data-after') || 'After']].forEach(function (p) {
      h('span', 'compare-label ' + p[0], container).textContent = p[1];
    });
    h('div', 'compare-handle', container);
    h('span', 'compare-knob', container, '⇔'); // つまみは枠の外に出ないよう、線とは別に位置を決める
    var byStep = container.getAttribute('data-reveal') === 'step';
    var base = Number(container.getAttribute('data-position') || 50);
    var stepNow = byStep ? addStepMarkers(container, 1) : null;
    var pos = base, raf = 0;

    function set(p) {
      pos = Math.max(0, Math.min(100, p));
      container.style.setProperty('--pos', pos + '%');
    }
    function animateTo(target) {
      cancelAnimationFrame(raf);
      if (IS_PRINT) { set(target); return; }
      var from = pos, start = null;
      track(new Promise(function (resolve) {
        function frame(t) {
          if (start == null) start = t;
          var k = Math.min(1, (t - start) / 900);
          set(from + (target - from) * ease(k));
          if (k < 1) raf = requestAnimationFrame(frame); else resolve();
        }
        raf = requestAnimationFrame(frame);
      }));
    }
    function apply(animate) {
      var target = byStep ? (stepNow() > 0 ? 0 : 100) : base;
      if (animate && byStep) animateTo(target); else { cancelAnimationFrame(raf); set(target); }
    }
    var dragging = false;
    function fromEvent(ev) {
      var r = container.getBoundingClientRect();
      set(((ev.clientX - r.left) / r.width) * 100);
    }
    container.addEventListener('pointerdown', function (ev) {
      if (document.body.classList.contains('deck-editing')) return;
      dragging = true;
      cancelAnimationFrame(raf);
      fromEvent(ev);
      ev.preventDefault();
    });
    window.addEventListener('pointermove', function (ev) { if (dragging) fromEvent(ev); });
    window.addEventListener('pointerup', function () { dragging = false; });
    onSlideState(container, function () { apply(true); });
    apply(false);
  }

  // ------------------------------------------------------------------
  // ターミナル再生 (.terminal)
  //   JSON: { "title": "bash", "prompt": "$", "lines": [ { "cmd": "npm test" }, { "out": "ok", "type": "ok" } ] }
  //   コマンドを 1 文字ずつ入力して出力を表示する。コマンド 1 つ (と続く出力) が → キーの 1 ステップ
  // ------------------------------------------------------------------
  function renderTerminal(container) {
    var data = readData(container);
    if (!data || !Array.isArray(data.lines)) return;
    container.classList.add('dg-terminal');
    var bar = h('div', 'term-bar', null);
    h('span', 'term-dots', bar, '<i></i><i></i><i></i>');
    h('span', 'term-title', bar).textContent = data.title || 'terminal';
    container.insertBefore(bar, container.firstChild);
    var screen = h('div', 'term-screen', container);

    // コマンドごとにまとめる: [{ cmd, prompt, outs: [...] }]  (先頭がコマンドでない出力は最初のまとまりに入れる)
    var groups = [];
    data.lines.forEach(function (l) {
      if (l.cmd != null || !groups.length) groups.push({ cmd: l.cmd, prompt: l.prompt, outs: [] });
      if (l.cmd == null) groups[groups.length - 1].outs.push(l);
    });
    var initial = Math.max(0, Math.min(groups.length, data.initial || 0));
    var auto = data.steps !== false;
    var stepNow = auto && groups.length > initial ? addStepMarkers(container, groups.length - initial) : function () { return groups.length - initial; };
    var speed = Number(data.speed || 35);
    var shownBefore = -1, timer = 0, token = 0;

    function lineEl(cls, text, prompt) {
      var el = h('div', 'term-line ' + cls, screen);
      if (prompt != null) h('span', 'term-prompt', el).textContent = prompt + ' ';
      var body = h('span', 'term-text', el);
      body.textContent = text || '';
      return body;
    }
    function scroll() { screen.scrollTop = screen.scrollHeight; }
    function renderGroup(g, typed) {
      var promptStr = g.prompt != null ? g.prompt : (data.prompt != null ? data.prompt : '$');
      var cmdEl = g.cmd != null ? lineEl('is-cmd', typed ? '' : g.cmd, promptStr) : null;
      return { cmdEl: cmdEl, outs: g.outs };
    }
    function renderOuts(outs) {
      outs.forEach(function (o) { lineEl('is-out' + (o.type ? ' is-' + o.type : ''), o.out); });
      scroll();
    }

    function apply() {
      var my = ++token;
      clearTimeout(timer);
      var shown = initial + stepNow();
      var animateLast = !IS_PRINT && shown === shownBefore + 1 && shown > initial;
      screen.innerHTML = '';
      groups.slice(0, animateLast ? shown - 1 : shown).forEach(function (g) {
        renderGroup(g, false);
        renderOuts(g.outs);
      });
      if (animateLast) {
        var g = groups[shown - 1], r = renderGroup(g, true);
        var text = g.cmd || '', i = 0;
        var done;
        track(new Promise(function (res) { done = res; }));
        var cursor = r.cmdEl ? h('span', 'term-cursor', r.cmdEl.parentNode) : null;
        var typeNext = function () {
          if (my !== token) { done(); return; }
          if (r.cmdEl && i < text.length) {
            r.cmdEl.textContent = text.slice(0, ++i);
            timer = setTimeout(typeNext, speed);
            return;
          }
          if (cursor) cursor.remove();
          var k = 0;
          var outNext = function () {
            if (my !== token) { done(); return; }
            if (k < r.outs.length) { renderOuts([r.outs[k++]]); timer = setTimeout(outNext, 70); return; }
            done();
          };
          timer = setTimeout(outNext, 200);
        };
        typeNext();
      } else {
        scroll();
      }
      shownBefore = shown;
    }
    onSlideState(container, apply, function () { token++; clearTimeout(timer); shownBefore = -1; });
    if (IS_PRINT) { groups.forEach(function (g) { renderGroup(g, false); renderOuts(g.outs); }); } else apply();
  }

  // ------------------------------------------------------------------
  // 初期化 (エンジンがステップを数える前に、目印を作っておく)
  // ------------------------------------------------------------------
  function safe(fn, el) {
    try { fn(el); } catch (e) { console.error('[diagram] 描画に失敗しました', e); h('div', 'dg-error', el, '図を描画できません: ' + esc(e.message)); }
  }
  document.querySelectorAll('.diagram').forEach(function (el) { safe(renderDiagram, el); });
  document.querySelectorAll('.er-diagram').forEach(function (el) { safe(renderER, el); });
  document.querySelectorAll('.seq-diagram').forEach(function (el) { safe(renderSequence, el); });
  document.querySelectorAll('.chart').forEach(function (el) { safe(renderChart, el); });
  document.querySelectorAll('.stack3d').forEach(function (el) { safe(renderStack, el); });
  document.querySelectorAll('.compare').forEach(function (el) { safe(renderCompare, el); });
  document.querySelectorAll('.terminal').forEach(function (el) { safe(renderTerminal, el); });

  // Esc: 表示中のスライドで詳細を開いている図があれば、先に閉じる (エンジンの一覧表示より優先)
  window.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || ev.target.isContentEditable) return;
    var active = document.querySelector('.slide.active');
    if (!active) return;
    var handled = false;
    instances.forEach(function (it) { if (active.contains(it.container) && it.reset()) handled = true; });
    if (handled) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
})();
