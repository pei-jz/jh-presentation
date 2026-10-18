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
  var dataIssues = []; // 図のデータの誤り (Deck.audit() で報告する)
  var DRILL_ZOOM = 2.2;
  var TABLE_ROWS = 10; // 階層マップのテーブルの箱に出す列の数 (超えた分は「ほか N 列」。全部は詳細パネルに出す) // 階層マップで中へ入る・外へ出るときに、カメラが寄る倍率の上限

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
    if (this.onApply) this.onApply(vb);
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
    if (this.done) { this.done(); this.done = null; } // 途中で止めた移動も完了扱いにする (settled が待ち続けないように)
    if (!animate || IS_PRINT) { this.apply(target.slice()); return Promise.resolve(); }
    var from = this.vb.slice(), start = null, dur = 650;
    return track(new Promise(function (resolve) {
      self.done = resolve;
      function frame(t) {
        if (start == null) start = t;
        var p = Math.min(1, (t - start) / dur), k = ease(p);
        self.apply(from.map(function (v, i) { return v + (target[i] - v) * k; }));
        if (p < 1) self.raf = requestAnimationFrame(frame); else { self.done = null; resolve(); }
      }
      self.raf = requestAnimationFrame(frame);
    }));
  };

  // ------------------------------------------------------------------
  // 拡大縮小・ドラッグ移動・ミニマップ (階層マップ)
  //   ホイール / ピンチで拡大縮小、ドラッグで移動、右下の ＋ − ⤢ ボタン、拡大中は左下にミニマップ (クリックでその場所へ)
  // ------------------------------------------------------------------
  function PanZoom(container, svgEl, cam, uid) {
    container.classList.add('has-panzoom');
    var ui = h('div', 'dg-zoomui', container);
    ui.addEventListener('click', function (ev) { ev.stopPropagation(); });
    [['＋', '拡大', function () { zoomAt(null, 1 / 1.4); }], ['−', '縮小', function () { zoomAt(null, 1.4); }], ['⤢', '全体を表示', function () { cam.reset(true); }]]
      .forEach(function (b) {
        var el = h('button', 'dg-zoombtn', ui, b[0]);
        el.type = 'button';
        el.title = b[1];
        el.setAttribute('aria-label', b[1]);
        el.addEventListener('click', b[2]);
      });

    // ミニマップ: 今の階層の図を縮小して映し、見えている範囲を枠で示す
    var mini = h('div', 'dg-minimap', container);
    mini.hidden = true;
    var msvg = s('svg', { class: 'dg-minimap-svg', preserveAspectRatio: 'xMidYMid meet' }, mini);
    ['groups', 'edges', 'nodes'].forEach(function (k) { s('use', { href: '#' + uid + '-' + k }, msvg); });
    var view = s('rect', { class: 'dg-minimap-view' }, msvg);
    mini.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var pt = toSvg(msvg, ev.clientX, ev.clientY), vb = cam.vb;
      cam.to(clamp([pt[0] - vb[2] / 2, pt[1] - vb[3] / 2, vb[2], vb[3]]), true);
    });

    function toSvg(svg, x, y) {
      var m = svg.getScreenCTM();
      if (!m) return [0, 0];
      var p = svg.createSVGPoint();
      p.x = x; p.y = y;
      p = p.matrixTransform(m.inverse());
      return [p.x, p.y];
    }
    /** 広さの上限・下限 (全体の 1/10 〜 2 倍) */
    function clamp(vb) {
      var f = cam.full, k = Math.min(Math.max(vb[2], f[2] / 10), f[2] * 2) / vb[2];
      if (k === 1) return vb;
      var cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2, w = vb[2] * k, hh = vb[3] * k;
      return [cx - w / 2, cy - hh / 2, w, hh];
    }
    /** pt (svg の座標。null なら中央) を中心に k 倍の広さにする (k < 1 で拡大) */
    function zoomAt(pt, k, animate) {
      var vb = cam.vb;
      if (!pt) pt = [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2];
      cam.to(clamp([pt[0] - (pt[0] - vb[0]) * k, pt[1] - (pt[1] - vb[1]) * k, vb[2] * k, vb[3] * k]), animate !== false);
    }

    svgEl.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      zoomAt(toSvg(svgEl, ev.clientX, ev.clientY), Math.pow(1.0015, ev.deltaY), false);
    }, { passive: false });

    // ドラッグで移動、2 本指でピンチ。動かしたらクリック (箱を選ぶ・中へ入る) にしない
    var pointers = {}, start = null, moved = false;
    svgEl.addEventListener('pointerdown', function (ev) {
      if (ev.button > 0) return;
      pointers[ev.pointerId] = [ev.clientX, ev.clientY];
      start = { vb: cam.vb.slice(), pts: JSON.parse(JSON.stringify(pointers)) };
      moved = false;
    });
    svgEl.addEventListener('pointermove', function (ev) {
      if (!start || !pointers[ev.pointerId]) return;
      pointers[ev.pointerId] = [ev.clientX, ev.clientY];
      var ids = Object.keys(pointers), m = svgEl.getScreenCTM();
      if (!m) return;
      var a = start.pts[ids[0]], b = pointers[ids[0]];
      if (!a) return;
      if (!moved && Math.hypot(b[0] - a[0], b[1] - a[1]) < 5) return;
      if (!moved) { moved = true; try { svgEl.setPointerCapture(ev.pointerId); } catch (e) { /* なし */ } }
      container.classList.add('is-panning');
      var vb = start.vb.slice();
      if (ids.length >= 2 && start.pts[ids[1]]) { // ピンチ: 2 本の指の間隔の比で拡大縮小
        var a2 = start.pts[ids[1]], b2 = pointers[ids[1]];
        var k = Math.hypot(a[0] - a2[0], a[1] - a2[1]) / Math.max(1, Math.hypot(b[0] - b2[0], b[1] - b2[1]));
        var c = toSvg(svgEl, (a[0] + a2[0]) / 2, (a[1] + a2[1]) / 2);
        vb = clamp([c[0] - (c[0] - vb[0]) * k, c[1] - (c[1] - vb[1]) * k, vb[2] * k, vb[3] * k]);
      } else {
        vb[0] -= (b[0] - a[0]) / m.a;
        vb[1] -= (b[1] - a[1]) / m.d;
      }
      cam.to(vb, false);
    });
    function end(ev) {
      delete pointers[ev.pointerId];
      if (!Object.keys(pointers).length) { start = null; container.classList.remove('is-panning'); }
      else start = { vb: cam.vb.slice(), pts: JSON.parse(JSON.stringify(pointers)) };
    }
    svgEl.addEventListener('pointerup', end);
    svgEl.addEventListener('pointercancel', end);
    svgEl.addEventListener('click', function (ev) {
      if (moved) { ev.stopPropagation(); ev.preventDefault(); moved = false; }
    }, true);

    cam.onApply = function (vb) {
      var f = cam.full;
      var zoomed = vb[2] < f[2] * 0.97 || Math.abs(vb[0] + vb[2] / 2 - (f[0] + f[2] / 2)) > f[2] * 0.03 || Math.abs(vb[1] + vb[3] / 2 - (f[1] + f[3] / 2)) > f[3] * 0.03;
      mini.hidden = !zoomed;
      container.classList.toggle('is-zoomed', zoomed);
      view.setAttribute('x', vb[0]); view.setAttribute('y', vb[1]);
      view.setAttribute('width', vb[2]); view.setAttribute('height', vb[3]);
    };
    return {
      /** 階層を描き直したとき: ミニマップの表示範囲を今の階層に合わせる */
      refresh: function () {
        var f = cam.full;
        msvg.setAttribute('viewBox', f.join(' '));
        cam.onApply(cam.vb);
      },
    };
  }

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
    if (needsDrill(data) || container.hasAttribute('data-map')) return renderDrill(container, data);
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

    drawEdges(layerEdges, edges, byId, uid);
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

  /** 線 p1→p2 (bend: 曲げる量。0 で直線) が、端以外のノードに何回かかるか */
  function routeHits(p1, p2, bend, obstacles) {
    var mx = (p1[0] + p2[0]) / 2 - (p2[1] - p1[1]) * bend, my = (p1[1] + p2[1]) / 2 + (p2[0] - p1[0]) * bend, hits = 0;
    for (var t = 0.1; t < 0.95; t += 0.1) {
      var u = 1 - t, x = u * u * p1[0] + 2 * u * t * mx + t * t * p2[0], y = u * u * p1[1] + 2 * u * t * my + t * t * p2[1];
      obstacles.forEach(function (n) { if (x > n.x - 16 && x < n.x + n.w + 16 && y > n.y - 16 && y < n.y + n.h + 16) hits++; });
    }
    return hits;
  }

  function drawEdges(layer, edges, byId, uid, obstacles) {
    edges.forEach(function (e, i) {
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) { console.warn('[diagram] 矢印の端のノードがありません: ' + e.from + ' -> ' + e.to); return; }
      if (e.rel && a.table && b.table) { drawRelation(layer, e, i, a, b); return; }
      var p1 = borderPoint(a, b.x + b.w / 2, b.y + b.h / 2), p2 = borderPoint(b, a.x + a.w / 2, a.y + a.h / 2);
      if (obstacles) { // 他のノードを突き抜けないよう、直線か曲げ方の候補から一番かからないものを選ぶ
        var others = obstacles.filter(function (n) { return n !== a && n !== b; });
        var cands = e.curve ? [0.25, 0.4] : [0, 0.25, -0.25, 0.4, -0.4];
        var best = cands.reduce(function (bst, c) { var hh = routeHits(p1, p2, c, others); return hh < bst[1] ? [c, hh] : bst; }, [cands[0], Infinity]);
        e = Object.assign({}, e, { curve: best[0] !== 0, bend: best[0] });
      }
      var g = drawEdge(layer, e, i, p1, p2, uid);
      if (e.hit) s('path', { d: g._d, class: 'dg-edge-hit' }, g);
      if (e.count > 1) { // 集約した矢印: 元の矢印の本数
        var c = s('g', { class: 'dg-edge-count' }, g);
        s('circle', { cx: g._mid[0], cy: g._mid[1], r: 20 }, c);
        var ct = s('text', { x: g._mid[0], y: g._mid[1] }, c);
        ct.textContent = e.count;
      }
    });
  }

  /** テーブル間の関連 (外部キー): 列の行どうしを曲線で結び、両端に多重度 (N / 1) の印を付ける */
  function drawRelation(layer, e, i, a, b) {
    var r = e.items[0];
    function colY(t, col) {
      var k = t.shown.findIndex(function (c) { return c.name === col; });
      return t.y + (k < 0 ? ER.head / 2 : ER.head + k * ER.row + ER.row / 2);
    }
    var y1 = colY(a, r.fromCol), y2 = colY(b, r.toCol), x1, x2, d1, d2;
    if (b.x >= a.x + a.w) { x1 = a.x + a.w; x2 = b.x; d1 = 1; d2 = -1; }
    else if (b.x + b.w <= a.x) { x1 = a.x; x2 = b.x + b.w; d1 = -1; d2 = 1; }
    else { x1 = a.x + a.w; x2 = b.x + b.w; d1 = 1; d2 = 1; }
    var bend = Math.max(60, Math.abs(x2 - x1) / 2);
    var d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + d1 * bend) + ' ' + y1 + ' ' + (x2 + d2 * bend) + ' ' + y2 + ' ' + x2 + ' ' + y2;
    var g = s('g', { class: 'dg-edge er-rel', 'data-idx': e.idx != null ? e.idx : i }, layer);
    s('path', { class: 'dg-edge-line', d: d }, g);
    s('path', { class: 'dg-edge-line dg-edge-hi', d: d }, g);
    s('path', { class: 'dg-edge-hit', d: d }, g);
    cardMark(g, x1, y1, d1, r.cardFrom);
    cardMark(g, x2, y2, d2, r.cardTo);
    if (e.label) {
      var t = s('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 12, class: 'dg-edge-label' }, g);
      t.textContent = e.label;
    }
  }

  function drawEdge(layer, e, i, p1, p2, uid) {
    var g = s('g', { class: 'dg-edge' + (e.style === 'dashed' ? ' is-dashed' : ''), 'data-idx': e.idx != null ? e.idx : i }, layer);
    var id = uid + '-e' + i + '-' + Math.random().toString(36).slice(2, 7);
    var d, mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    g._mid = [mx, my];
    if (e.curve) {
      var bend = e.bend != null ? e.bend : 0.25;
      var nx = -(p2[1] - p1[1]) * bend, ny = (p2[0] - p1[0]) * bend;
      d = 'M' + p1[0] + ' ' + p1[1] + ' Q' + (mx + nx) + ' ' + (my + ny) + ' ' + p2[0] + ' ' + p2[1];
      g._mid = [mx + nx / 2, my + ny / 2]; // 2 次ベジェ曲線の中点
    } else {
      d = 'M' + p1[0] + ' ' + p1[1] + ' L' + p2[0] + ' ' + p2[1];
    }
    g._d = d;
    s('path', { id: id, d: d, class: 'dg-edge-line', 'marker-end': 'url(#' + uid + '-arrow-n)', 'marker-start': e.both ? 'url(#' + uid + '-arrow-n)' : null }, g);
    s('path', { d: d, class: 'dg-edge-line dg-edge-hi', 'marker-end': 'url(#' + uid + '-arrow-a)', 'marker-start': e.both ? 'url(#' + uid + '-arrow-a)' : null }, g);
    // データの流れ (線の上を点が移動)
    for (var k = 0; k < 3; k++) {
      var begin = (k * (e.speed || 1.8) / 3).toFixed(2) + 's';
      // 動き出す前の点は原点 (0, 0) に見えてしまうので、動き出すまで隠す
      var dot = s('circle', { r: 9, class: 'dg-dot', visibility: k ? 'hidden' : null }, g);
      if (k) s('set', { attributeName: 'visibility', to: 'visible', begin: begin }, dot);
      var am = s('animateMotion', { dur: (e.speed || 1.8) + 's', repeatCount: 'indefinite', begin: begin }, dot);
      s('mpath', { href: '#' + id }, am);
    }
    if (e.label) {
      var lp = e.hit ? g._mid : [mx, my];
      var t = s('text', { x: lp[0], y: lp[1] - (e.count > 1 ? 30 : 14), class: 'dg-edge-label' }, g);
      t.textContent = e.label;
    }
    return g;
  }

  function drawNode(layer, n, uid, dir) {
    var g = s('g', { class: 'dg-node' + (n.kind ? ' is-' + n.kind : '') + (n.accent ? ' is-accent' : '') + (n.children ? ' has-children' : '') + (n.detail ? ' has-detail' : ''), 'data-id': n.id }, layer);
    g._node = n;
    drawShape(g, n);
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

  function drawShape(g, n) {
    if (n.kind === 'db') {
      var ry = 22;
      s('path', { class: 'dg-shape', d: 'M' + n.x + ' ' + (n.y + ry) + ' a' + n.w / 2 + ' ' + ry + ' 0 0 1 ' + n.w + ' 0 v' + (n.h - ry * 2) + ' a' + n.w / 2 + ' ' + ry + ' 0 0 1 -' + n.w + ' 0 z' }, g);
      s('path', { class: 'dg-shape-line', d: 'M' + n.x + ' ' + (n.y + ry) + ' a' + n.w / 2 + ' ' + ry + ' 0 0 0 ' + n.w + ' 0' }, g);
    } else {
      s('rect', { class: 'dg-shape', x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'user' ? n.h / 2 : n.kind === 'state' ? 36 : 16 }, g);
    }
  }

  // ------------------------------------------------------------------
  // 多段の入れ子 (.diagram の階層マップ)
  //   入れ子が 2 段以上・別の階層のノードを結ぶ矢印・"drill": true のときに使う。
  //   中身を持つノードをクリックすると、その階層の図を描き直す (深さに制限がなく、文字の大きさが変わらない)。
  //   矢印はどの階層のノード同士でも結べ、表示中の階層では「見えている祖先」同士の矢印に集約する。
  //   外とつながる部品は、外側のノードを画面の端 (境界ノード) に出して矢印を引く。
  // ------------------------------------------------------------------
  function needsDrill(data) {
    if (data.drill || (Array.isArray(data.flows) && data.flows.length) || Array.isArray(data.relations)) return true;
    var json = JSON.stringify(data.nodes);
    if (json.indexOf('"kind":"table"') >= 0 || json.indexOf('"kind":"state"') >= 0) return true; // テーブル (ER 図)・状態遷移図は階層マップで描く
    var top = {}, nested = {};
    data.nodes.forEach(function (n) { top[n.id] = true; });
    var deep = false;
    data.nodes.forEach(function (n) {
      ((n.children && n.children.nodes) || []).forEach(function (c) {
        nested[c.id] = true;
        if (c.children && c.children.nodes && c.children.nodes.length) deep = true;
      });
    });
    return deep || (data.edges || []).some(function (e) { return (!top[e.from] && nested[e.from]) || (!top[e.to] && nested[e.to]); });
  }

  function renderDrill(container, data) {
    var uid = 'dg' + (++uidSeq);
    container.classList.add('dg', 'is-drill');
    var rootDir = data.direction === 'TB' ? 'TB' : 'LR';
    var mapMode = container.hasAttribute('data-map'); // マップ文書の中 (詳細パネルにつながりの一覧を付ける)
    function problem(message) { // データの誤りは Deck.audit() で type: data として報告する
      console.warn('[diagram] ' + message);
      dataIssues.push({ container: container, message: message });
    }

    // ---- ノードの木と、すべての矢印 ----
    var info = { '': { id: '', label: data.title || '全体', parent: null, kids: [], raw: { detail: '' }, box: data } };
    var allEdges = [];
    (function walk(pid, box) {
      (box.nodes || []).forEach(function (n) {
        var id = String(n.id);
        if (info[id]) problem('ノードの id が重複しています: ' + id);
        info[id] = { id: id, label: n.label == null ? id : n.label, parent: pid, kids: [], raw: n, box: n.children };
        info[pid].kids.push(id);
        if (n.children && n.children.nodes && n.children.nodes.length) walk(id, n.children);
      });
    })('', data);
    // 矢印は、すべてのノードを登録してから集める (上の階層から深いノードへの矢印があるため)
    (function collect(box) {
      (box.edges || []).forEach(function (e) {
        var from = String(e.from), to = String(e.to);
        if (!info[from] || !info[to] || from === '' || to === '') { problem('矢印の端のノードがありません: ' + from + ' -> ' + to); return; }
        var ex = { from: from, to: to, key: from + '->' + to };
        if (e.guard || e.action) { // 遷移: イベント [条件] / 処理
          ex.event = e.label || '';
          ex.label = [e.label, e.guard ? '[' + e.guard + ']' : '', e.action ? '/ ' + e.action : ''].filter(Boolean).join(' ');
        }
        allEdges.push(Object.assign({}, e, ex));
      });
      (box.nodes || []).forEach(function (n) { if (n.children && n.children.nodes && n.children.nodes.length) collect(n.children); });
    })(data);
    // テーブル (kind: "table") の列と、列どうしの関連 (relations。外部キー)。関連もテーブル間の矢印として扱う
    Object.keys(info).forEach(function (id) {
      if (id && info[id].raw.kind === 'table') info[id].cols = (info[id].raw.columns || []).map(parseColumn);
    });
    function splitCol(ref) { // "テーブルの id.列名" (テーブルの id に . があってもよい)
      ref = String(ref);
      var i = ref.lastIndexOf('.');
      var tb = ref.slice(0, i), col = ref.slice(i + 1);
      if (i <= 0 || !info[tb] || !info[tb].cols) return null;
      return info[tb].cols.some(function (c) { return c.name === col; }) ? { table: tb, col: col } : null;
    }
    (function collectRel(box) {
      (box.relations || []).forEach(function (r) {
        var f = splitCol(r.from), t = splitCol(r.to);
        if (!f || !t) { problem('関連の端のテーブル・列がありません: ' + r.from + ' -> ' + r.to + ' (テーブルの id.列名 で書く)'); return; }
        var card = String(r.card || 'N:1').split(':');
        allEdges.push({
          from: f.table, to: t.table, fromCol: f.col, toCol: t.col, rel: true, label: r.label || '',
          card: r.card || 'N:1', cardFrom: card[0], cardTo: card[1] || '1', key: f.table + '->' + t.table + '#' + f.col,
        });
      });
      (box.nodes || []).forEach(function (n) { if (n.children && n.children.nodes && n.children.nodes.length) collectRel(n.children); });
    })(data);
    var edgeByKey = {};
    allEdges.forEach(function (e) { if (!edgeByKey[e.key]) edgeByKey[e.key] = e; });

    // ---- データの流れ (flows): path の隣同士を 1 区間とし、それぞれを矢印 (逆向きも可) に対応させる ----
    var flows = (Array.isArray(data.flows) ? data.flows : []).map(function (f, fi) {
      var id = String(f.id == null ? fi : f.id), label = f.label || id;
      var pts = (f.path || []).map(function (pt) { return typeof pt === 'object' && pt ? { id: String(pt.id), note: pt.note || '' } : { id: String(pt), note: '' }; });
      var segs = [];
      pts.forEach(function (pt, i) {
        if (!info[pt.id] || pt.id === '') { problem('流れ「' + label + '」の path にないノードがあります: ' + pt.id); return; }
        if (!i || !info[pts[i - 1].id]) return;
        var a = pts[i - 1].id, b = pt.id, e = edgeByKey[a + '->' + b], rev = false;
        if (!e && edgeByKey[b + '->' + a]) { e = edgeByKey[b + '->' + a]; rev = true; }
        if (!e) problem('流れ「' + label + '」の ' + a + ' → ' + b + ' に矢印がありません (edges に書く)');
        segs.push({ from: a, to: b, key: e ? e.key : null, rev: rev, note: pt.note });
      });
      if (!segs.length) problem('流れ「' + label + '」の path は 2 つ以上のノードを並べます');
      return { id: id, label: label, note: f.note || '', segs: segs };
    }).filter(function (f) { return f.segs.length; });
    var flowById = {};
    flows.forEach(function (f) { flowById[f.id] = f; });

    function chain(id) { // id から根 ('') までの祖先 (自分を含む)
      var c = [];
      for (var x = id; x != null; x = info[x].parent) c.push(x);
      return c;
    }
    function repIn(id, p) { // id を含む、p の直下のノード
      for (var x = id; x; x = info[x].parent) if (info[x].parent === p) return x;
      return null;
    }
    function outsideRep(id, p) { // p の外にある id を、p から見える祖先で代表させる
      var up = chain(p), c = chain(id), lca = null;
      for (var i = 0; i < c.length; i++) if (up.indexOf(c[i]) >= 0) { lca = c[i]; break; }
      if (lca === id) return null; // p 自身・p の祖先につながる矢印は中では描かない
      return repIn(id, lca);
    }
    function isAncestor(a, b) { return a !== b && chain(b).indexOf(a) >= 0; }
    /** 流れの 1 区間を見せる階層: 両端のうち深いほうの親 (同じ深さなら送り手の親)。部品そのものの間のやり取りが見える */
    function segLevel(sg) {
      var pa = info[sg.from].parent, pb = info[sg.to].parent;
      return chain(pb).length > chain(pa).length ? pb : pa;
    }
    function uniq(arr) { return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; }); }

    function drillNode(id, boundary) {
      var it = info[id], raw = it.raw, hasKids = it.kids.length > 0 && !boundary;
      var n = normNode(Object.assign({}, raw, { children: null }), false);
      n.hasKids = hasKids;
      n.boundary = !!boundary;
      if (boundary && it.parent) n.sub = info[it.parent].label; // どの中の部品かを示す
      if (hasKids && !n.sub) { n.hint = IS_PRINT && mapMode ? '中身は後のページ' : 'クリックで中へ'; n.h = 130; }
      if (boundary) n.detail = raw.detail || '';
      if (it.cols && !boundary) tableBox(n, it);
      if (raw.kind === 'state' && !boundary) { n.initial = !!raw.initial; n.final = !!raw.final; }
      return n;
    }

    /** テーブルの箱: 見出し + 列の行。列が多ければ主キー・外部キーを先にして TABLE_ROWS 行まで (残りは「ほか N 列」) */
    function tableBox(n, it) {
      var cols = it.cols, shown = cols;
      if (cols.length > TABLE_ROWS) {
        var keys = cols.filter(function (c) { return c.pk || c.fk; }), rest = cols.filter(function (c) { return !c.pk && !c.fk; });
        shown = keys.concat(rest).slice(0, TABLE_ROWS - 1);
      }
      var wCols = shown.reduce(function (m, c) { return Math.max(m, 56 + textWidth(c.name, ER.fs) + 30 + textWidth(c.type, ER.fs * 0.85)); }, 0);
      n.table = true;
      n.cols = cols;
      n.shown = shown;
      n.more = cols.length - shown.length;
      n.w = it.raw.w || Math.max(300, textWidth(String(n.label), 28) + 40, wCols + ER.padX * 2);
      n.h = it.raw.h || ER.head + (shown.length + (n.more ? 1 : 0)) * ER.row + 10;
    }

    // ---- 階層ごとの図 (配置は初回だけ計算して使い回す) ----
    var cache = {};
    function level(p) {
      if (cache[p]) return cache[p];
      var box = info[p].box || {};
      var dir = box.direction === 'TB' ? 'TB' : box.direction === 'LR' ? 'LR' : rootDir;
      var nodes = info[p].kids.map(function (id) { return drillNode(id, false); });
      var byId = {}, bnodes = [], agg = {}, order = [];
      nodes.forEach(function (n) { byId[n.id] = n; });
      allEdges.forEach(function (e) {
        var a = repIn(e.from, p), b = repIn(e.to, p), side = null, ext = null;
        if (!a && !b) return;          // この階層の外の話
        if (a && a === b) return;      // 1 つのノードの中の話
        if (!a) { a = outsideRep(e.from, p); side = 'in'; ext = a; }
        if (!b) { b = outsideRep(e.to, p); side = 'out'; ext = b; }
        if (!a || !b) return;
        if (ext && !byId[ext]) { var bn = drillNode(ext, true); bn.side = side; byId[ext] = bn; bnodes.push(bn); }
        // テーブル同士がそのまま見えている関連は、列ごとに 1 本ずつ描く (まとめない)
        var k = e.rel && a === e.from && b === e.to ? e.key : a + '->' + b;
        if (!agg[k]) { agg[k] = { from: a, to: b, key: k, items: [] }; order.push(k); }
        agg[k].items.push(e);
      });
      var edges = order.map(function (k, i) {
        var g = agg[k], it = g.items;
        var datas = uniq([].concat.apply([], it.map(function (e) { return e.data || []; })));
        var labels = uniq(it.map(function (e) { return e.label; }));
        var label = it.length === 1 ? (it[0].label || datas.join('・')) : (datas.length ? datas.join('・') : labels.length === 1 ? labels[0] : '');
        var rel = it.length === 1 && !!it[0].rel && g.from === it[0].from && g.to === it[0].to;
        return {
          from: g.from, to: g.to, key: k, idx: i, items: it, label: label, count: it.length, hit: true, rel: rel,
          flow: it.some(function (e) { return e.flow; }),
          style: it.every(function (e) { return e.style === 'dashed' || e.type === 'async' || e.type === 'read'; }) ? 'dashed' : '',
          both: it.length === 1 && !!it[0].both, curve: !!agg[g.to + '->' + g.from] || (it.length === 1 && !!it[0].curve),
        };
      });
      var inner = edges.filter(function (e) { return !byId[e.from].boundary && !byId[e.to].boundary; });
      // 関連 (外部キー) は参照される側 (主キー) が左 / 上に来るよう、向きを逆にして並べる
      var forLayout = inner.map(function (e) { return e.items.every(function (i) { return i.rel; }) ? { from: e.to, to: e.from } : e; });
      // 横並び (LR) では、矢印のラベル (遷移の「イベント [条件] / 処理」など) が箱に隠れないよう、間隔をラベルの長さに合わせて広げる
      var longest = dir === 'LR' ? inner.reduce(function (m, e) { return e.rel ? m : Math.max(m, textWidth(e.label || '', 24)); }, 0) : 0;
      var gapMain = Math.max(data.gap || 160, Math.min(longest + 70, 520));
      if (nodes.some(function (n) { return !n._fixed; })) autoLayout(nodes, forLayout, dir, gapMain, data.gapCross || 70);
      // 境界ノード: 入ってくるものを始まりの側 (左 / 上)、出ていくものを終わりの側 (右 / 下) に並べる
      var b = nodes.length ? bounds(nodes) : [0, 0, 0, 0], gap = 240, gapCross = data.gapCross || 70;
      ['in', 'out'].forEach(function (side) {
        var list = bnodes.filter(function (n) { return n.side === side; });
        if (!list.length) return;
        // つながる中のノードの位置の順に並べる (矢印が交差しにくいように)
        list.forEach(function (n) {
          var ps = edges.filter(function (e) { return e.from === n.id || e.to === n.id; }).map(function (e) {
            var m = byId[e.from === n.id ? e.to : e.from];
            return dir === 'TB' ? m.x + m.w / 2 : m.y + m.h / 2;
          });
          n._order = ps.reduce(function (a, v) { return a + v; }, 0) / ps.length;
        });
        list.sort(function (a, c) { return a._order - c._order; });
        var total = list.reduce(function (t, n) { return t + (dir === 'TB' ? n.w : n.h) + gapCross; }, -gapCross);
        var pos = (dir === 'TB' ? b[0] + b[2] / 2 : b[1] + b[3] / 2) - total / 2;
        list.forEach(function (n) {
          if (dir === 'TB') { n.x = pos; n.y = side === 'in' ? b[1] - gap - n.h : b[1] + b[3] + gap; pos += n.w + gapCross; }
          else { n.y = pos; n.x = side === 'in' ? b[0] - gap - n.w : b[0] + b[2] + gap; pos += n.h + gapCross; }
        });
      });
      // グループ (この階層のノードだけを囲む)
      var groups = (box.groups || []).map(function (g) {
        var members = (g.nodes || []).map(function (id) { return byId[id]; }).filter(function (n) { return n && !n.boundary; });
        if (!members.length) return null;
        var gb = bounds(members), pad = 40;
        return { label: g.label || '', rect: [gb[0] - pad, gb[1] - pad - 36, gb[2] + pad * 2, gb[3] + pad * 2 + 36] };
      }).filter(Boolean);
      nodes.forEach(function (n) { n.dir = dir; });
      var all = nodes.concat(bnodes).map(function (n) {
        var ix = n.initial && dir === 'LR' ? 90 : 0, iy = n.initial && dir === 'TB' ? 90 : 0; // 初期状態の黒丸の分
        return { x: n.x - ix, y: n.y - iy, w: n.w + ix + (n.hasKids ? 12 : 0), h: n.h + iy + (n.hasKids ? 12 : 0) };
      });
      groups.forEach(function (g) { all.push({ x: g.rect[0], y: g.rect[1], w: g.rect[2], h: g.rect[3] }); });
      var fb = bounds(all), pad = 50;
      cache[p] = { id: p, dir: dir, nodes: nodes, bnodes: bnodes, byId: byId, edges: edges, groups: groups, full: [fb[0] - pad, fb[1] - pad, fb[2] + pad * 2, fb[3] + pad * 2] };
      return cache[p];
    }

    // ---- 描画 ----
    var svgEl = s('svg', { class: 'dg-svg', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': data.title || '図' });
    container.insertBefore(svgEl, container.firstChild);
    arrowDefs(svgEl, uid);
    var layerGroups = s('g', { class: 'dg-groups', id: uid + '-groups' }, svgEl);
    var layerEdges = s('g', { class: 'dg-edges', id: uid + '-edges' }, svgEl);
    var layerNodes = s('g', { class: 'dg-nodes', id: uid + '-nodes' }, svgEl);
    var cam = new Camera(svgEl, [0, 0, 100, 100]);
    // 拡大縮小・ドラッグ移動・ミニマップ (マップ文書では常に。スライドでは "pan": true のときだけ。スワイプでのスライド送りとぶつかるため)
    var pz = (mapMode || data.pan) && !IS_PRINT ? PanZoom(container, svgEl, cam, uid) : null;
    var crumbs = h('nav', 'dg-crumbs', container);
    crumbs.setAttribute('aria-label', '階層');
    crumbs.addEventListener('click', function (ev) { ev.stopPropagation(); });
    var panel = Panel(container, function () { clearSelection(); });
    var caption = Caption(container);
    var steps = Array.isArray(data.steps) ? data.steps : [];
    var stepNow = steps.length > 1 ? addStepMarkers(container, steps.length - 1) : function () { return 0; };
    var cur = null, selected = null, navTok = 0;
    var dataState = null; // 強調中のデータの名前 (edges の data。マップ文書の「データ」で選ぶ)
    var flowState = null; // 強調中のデータの流れ { flow, upto (null = 全体、n = n 区間目まで), ui (流れボタンから選んだ) }
    // ---- 状態遷移図 (kind: "state") ----
    var states = Object.keys(info).filter(function (id) { return id && info[id].raw.kind === 'state'; });
    var transitions = allEdges.filter(function (e) { return !e.rel && info[e.from].raw.kind === 'state' && info[e.to].raw.kind === 'state'; });
    /** 状態に入ったときに実際にいる状態: 中に状態を持つなら、中の初期状態 (なければ最初の状態) へ下りていく */
    function enterState(id) {
      var guard = 0;
      while (info[id] && info[id].kids.length && guard++ < 50) {
        var kids = info[id].kids.filter(function (k) { return info[k].raw.kind === 'state'; });
        if (!kids.length) break;
        id = kids.filter(function (k) { return info[k].raw.initial; })[0] || kids[0];
      }
      return id;
    }
    /** 今の状態から出ていける遷移 (外側の状態に書かれた遷移も、中のどの状態からでも使える) */
    function outgoing(id) {
      var anc = chain(id);
      return transitions.filter(function (e) { return anc.indexOf(e.from) >= 0; });
    }
    (function checkStates() { // 到達できない状態・行き止まりの状態・中の初期状態がない状態を知らせる
      if (!states.length) return;
      var top = states.filter(function (id) { return info[id].parent === '' || info[info[id].parent].raw.kind !== 'state'; });
      var starts = top.filter(function (id) { return info[id].raw.initial; });
      if (!starts.length) { problem('初期状態 (initial: true) がありません'); return; }
      states.forEach(function (id) {
        var kids = info[id].kids.filter(function (k) { return info[k].raw.kind === 'state'; });
        if (kids.length && !kids.some(function (k) { return info[k].raw.initial; })) problem('状態「' + info[id].label + '」の中に初期状態 (initial: true) がありません');
      });
      var seen = {}, queue = starts.map(enterState);
      while (queue.length) {
        var at = queue.shift();
        if (seen[at]) continue;
        chain(at).forEach(function (a) { if (a) seen[a] = true; });
        outgoing(at).forEach(function (e) { queue.push(enterState(e.to)); });
      }
      states.forEach(function (id) {
        if (!seen[id]) problem('到達できない状態があります: ' + info[id].label + ' (' + id + ')');
        else if (!info[id].kids.length && !info[id].raw.final && !outgoing(id).length) problem('出ていく遷移がない状態があります (終了状態なら final: true): ' + info[id].label + ' (' + id + ')');
      });
    })();
    var sim = data.simulate && states.length && !IS_PRINT ? { cur: null, history: [] } : null; // 試しに遷移させる
    steps.forEach(function (st, i) {
      if (typeof st.flow === 'string' && !flowById[st.flow]) problem('steps[' + i + '] の flow「' + st.flow + '」は flows にありません');
    });

    function setCaption(text) { // 説明バーとパンくずの分だけ、図の表示枠を空ける (CSS)
      caption.set(text);
      container.classList.toggle('has-caption', !!text);
    }
    function curStep() { return steps[stepNow()] || {}; }
    function stepFlow(st) { return typeof st.flow === 'string' ? flowById[st.flow] || null : null; }
    function stepUpto(st, f) { return st.upto == null ? null : Math.max(1, Math.min(f.segs.length, Number(st.upto) || 1)); }
    /** ステップが指す階層。at / zoom がなく、流れを順に追うステップなら、その区間が見える階層 */
    function stepLevel(st) {
      var at = st.at != null ? st.at : st.zoom, f = stepFlow(st);
      if (at == null && sim && st.state && info[st.state]) return info[enterState(String(st.state))].parent;
      if (at == null && f && stepUpto(st, f)) return segLevel(f.segs[stepUpto(st, f) - 1]);
      return levelOf(at);
    }
    function flowCaption(fs) {
      var segs = fs.flow.segs, seg = fs.upto ? segs[fs.upto - 1] : null;
      var head = fs.flow.label + (fs.upto ? ' ' + fs.upto + '/' + segs.length : '');
      var note = seg ? seg.note : fs.flow.note;
      return head + (note ? ': ' + note : '');
    }
    function captionText() {
      if (flowState && flowState.ui) return flowCaption(flowState);
      var st = curStep();
      if (cur === stepLevel(st)) return st.note || (flowState ? flowCaption(flowState) : '');
      return flowState ? flowCaption(flowState) : '';
    }

    function draw(p, enter) {
      var lv = level(p);
      cur = p;
      [layerGroups, layerEdges, layerNodes].forEach(function (l) {
        l.textContent = '';
        l.classList.remove('dg-enter', 'dg-enter-in', 'dg-enter-out');
        if (enter && !IS_PRINT) { // 再生し直すためにレイアウトを確定させる
          void l.getBoundingClientRect();
          l.classList.add('dg-enter');
          if (enter === 'in' || enter === 'out') l.classList.add('dg-enter-' + enter);
        }
      });
      if (enter && !IS_PRINT) track(new Promise(function (r) { setTimeout(r, 500); })); // 描き直しの演出 (CSS) が終わるまで撮影・検査を待たせる
      lv.groups.forEach(function (g) {
        var gg = s('g', { class: 'dg-group' }, layerGroups);
        s('rect', { x: g.rect[0], y: g.rect[1], width: g.rect[2], height: g.rect[3], rx: 18 }, gg);
        var t = s('text', { x: g.rect[0] + 20, y: g.rect[1] + 30, class: 'dg-group-label' }, gg);
        t.textContent = g.label;
      });
      drawEdges(layerEdges, lv.edges, lv.byId, uid, lv.nodes.concat(lv.bnodes));
      lv.nodes.concat(lv.bnodes).forEach(function (n) { drawDrillNode(n); });
      setCaption(captionText()); // ステップの説明は、ステップが指す階層にいる間だけ出す
      cam.full = lv.full.slice();
      cam.apply(lv.full.slice());
      if (pz) pz.refresh();
      container.classList.toggle('is-inside', !!p);
      container.setAttribute('data-level', p);
      updateCrumbs();
      emit();
    }

    /** 表示の変化を知らせる (マップ文書が URL・目次を合わせる) */
    function emit() {
      container.dispatchEvent(new CustomEvent('dg:change', { detail: { level: cur, selected: selected && selected.indexOf('edge:') !== 0 ? selected : null } }));
    }

    function drawDrillNode(n) {
      if (n.table) return drawTable(n);
      var g = s('g', { class: 'dg-node' + (n.kind ? ' is-' + n.kind : '') + (n.accent && !n.boundary ? ' is-accent' : '') + (n.hasKids ? ' has-children' : '') + (n.detail ? ' has-detail' : '') + (n.boundary ? ' is-boundary is-' + n.side : ''), 'data-id': n.id }, layerNodes);
      g._node = n;
      if (n.hasKids) s('rect', { class: 'dg-stackback', x: n.x + 12, y: n.y + 12, width: n.w, height: n.h, rx: 16 }, g); // 重なった箱 = 中がある
      drawShape(g, n);
      var cx = n.x + n.w / 2, second = n.sub || n.hint;
      var t = s('text', { x: cx, y: n.y + n.h / 2 + (second ? -12 : 0), class: 'dg-label' }, g);
      setLines(t, n.label, 36);
      if (second) {
        var st = s('text', { x: cx, y: n.y + n.h / 2 + 30, class: n.sub ? 'dg-sub' : 'dg-hint' }, g);
        st.textContent = second;
      }
      if (n.detail && !n.hasKids && !n.boundary) s('circle', { cx: n.x + n.w - 18, cy: n.y + 18, r: 7, class: 'dg-detail-mark' }, g);
      if (n.final) s('rect', { class: 'dg-state-final', x: n.x + 7, y: n.y + 7, width: n.w - 14, height: n.h - 14, rx: 30 }, g);
      if (n.initial) { // 初期状態: 黒丸から矢印
        var tb = n.dir === 'TB', dx = tb ? n.x + n.w / 2 : n.x - 70, dy = tb ? n.y - 70 : n.y + n.h / 2;
        s('circle', { class: 'dg-state-start', cx: dx, cy: dy, r: 14 }, g);
        s('path', { class: 'dg-edge-line', d: 'M' + (tb ? dx : dx + 16) + ' ' + (tb ? dy + 16 : dy) + ' L' + (tb ? dx : n.x - 4) + ' ' + (tb ? n.y - 4 : dy), 'marker-end': 'url(#' + uid + '-arrow-n)' }, g);
      }
    }

    function drawTable(n) {
      var g = s('g', { class: 'dg-node er-table' + (n.detail ? ' has-detail' : ''), 'data-id': n.id }, layerNodes);
      g._node = n;
      s('rect', { class: 'dg-shape', x: n.x, y: n.y, width: n.w, height: n.h, rx: 12 }, g);
      s('path', { class: 'er-head', d: 'M' + n.x + ' ' + (n.y + ER.head) + ' V' + (n.y + 12) + ' q0 -12 12 -12 H' + (n.x + n.w - 12) + ' q12 0 12 12 V' + (n.y + ER.head) + ' Z' }, g);
      var title = s('text', { x: n.x + n.w / 2, y: n.y + ER.head / 2 + 10, class: 'er-title' }, g);
      title.textContent = String(n.label).replace(/\n/g, ' ');
      n.shown.forEach(function (c, i) {
        var y = n.y + ER.head + i * ER.row;
        var row = s('g', { class: 'er-row' + (c.pk ? ' is-pk' : '') + (c.fk ? ' is-fk' : ''), 'data-col': c.name }, g);
        s('rect', { class: 'er-row-bg', x: n.x + 4, y: y + 3, width: n.w - 8, height: ER.row - 4, rx: 6 }, row);
        if (c.pk || c.fk) {
          var badge = s('text', { x: n.x + ER.padX, y: y + ER.row / 2 + 8, class: 'er-key' }, row);
          badge.textContent = c.pk ? 'PK' : 'FK';
        }
        var name = s('text', { x: n.x + ER.padX + 50, y: y + ER.row / 2 + 9, class: 'er-col' }, row);
        name.textContent = c.name;
        if (c.type) {
          var type = s('text', { x: n.x + n.w - ER.padX, y: y + ER.row / 2 + 8, class: 'er-type' }, row);
          type.textContent = c.type;
        }
      });
      if (n.more) {
        var more = s('text', { x: n.x + n.w / 2, y: n.y + ER.head + n.shown.length * ER.row + ER.row / 2 + 8, class: 'er-more' }, g);
        more.textContent = 'ほか ' + n.more + ' 列';
      }
    }

    /** 選んだテーブルと関連先で、結合に使う列の行を光らせる (keys: "テーブルの id.列名" の Set。null で消す) */
    function markKeys(keys) {
      layerNodes.querySelectorAll('.er-row').forEach(function (row) {
        row.classList.toggle('is-key', !!keys && keys.has(row.closest('.dg-node').getAttribute('data-id') + '.' + row.getAttribute('data-col')));
      });
    }

    function updateCrumbs() {
      crumbs.textContent = '';
      crumbs.hidden = !cur;
      chain(cur).reverse().forEach(function (id, i, arr) {
        if (i) h('span', 'dg-crumb-sep', crumbs, '›');
        var b = h('button', 'dg-crumb', crumbs);
        b.type = 'button';
        b.textContent = String(info[id].label).replace(/\n/g, ' ');
        if (i === arr.length - 1) {
          b.setAttribute('aria-current', 'location');
          b.addEventListener('click', function () { if (info[id].raw.detail) panel.show(b.textContent, info[id].raw.detail); });
        } else {
          b.addEventListener('click', function () { navigate(id); });
        }
      });
    }

    /** 階層 p へ移る。深くなるときは入るノードへズームしてから描き直し、浅くなるときは元のノードから引いて全体へ戻る */
    function go(p, animate) {
      if (p === cur) return Promise.resolve(true);
      var tok = ++navTok, from = cur;
      if (animate && from != null && isAncestor(from, p)) {
        var n = level(from).byId[repIn(p, from)];
        container.classList.add('dg-leaving'); // 寄りながら今の図を薄くし、中の図に差し替える
        var entered = cam.fit(nearRect(n), true).then(function () {
          container.classList.remove('dg-leaving');
          if (tok !== navTok) return false;
          draw(p, 'in');
          return true;
        });
        // Deck.settled は呼ばれた時点の演出しか待たないので、寄る → 描き直す → 現れるまでを最初に 1 つとして登録する
        track(entered.then(function () { return new Promise(function (r) { setTimeout(r, 500); }); }));
        return entered;
      }
      container.classList.remove('dg-leaving');
      var out = animate && from != null && isAncestor(p, from);
      draw(p, out ? 'out' : animate);
      if (out) {
        var r = level(p).byId[repIn(from, p)];
        if (r) { cam.fit(nearRect(r), false); return cam.reset(true).then(function () { return tok === navTok; }); }
      }
      return Promise.resolve(true);
    }
    /**
     * 階層を移るときにカメラが寄る範囲: 箱 n の周り。箱いっぱいまで寄ると、文字が画面からあふれるほど
     * 大きくなって目が追えないので、DRILL_ZOOM 倍までにとどめる (残りは中の図の拡大 (.dg-enter-in) で見せる)
     */
    function nearRect(n) {
      var f = cam.full;
      var w = Math.max(n.w, f[2] / DRILL_ZOOM), hh = Math.max(n.h, f[3] / DRILL_ZOOM);
      return [n.x + n.w / 2 - w / 2, n.y + n.h / 2 - hh / 2, w, hh];
    }

    /** 利用者の操作で階層を移る (選択を解き、移った先で強調を付け直す) */
    function navigate(p, then) {
      selected = null;
      panel.hide();
      return go(p, true).then(function (ok) {
        if (!ok) return;
        baseFocus();
        if (then) then();
        else if (mapMode && p && info[p].raw.detail) panel.show(String(info[p].label).replace(/\n/g, ' '), info[p].raw.detail + links(p, true));
      });
    }

    /** 表示中の階層で見えているノード id に置き換える (深いノード・外のノードの id でも指定できる) */
    function visibleId(id) {
      var lv = level(cur);
      id = String(id);
      if (lv.byId[id]) return id;
      if (!info[id]) return null;
      var r = repIn(id, cur) || outsideRep(id, cur);
      return r && lv.byId[r] ? r : null;
    }

    /**
     * 強調: focusIds のノード (と、その間の矢印) を残して他を薄くし、flowKeys の矢印に点を流す。
     * opt.reverse: 矢印と逆向きに点を流す元の矢印の key、opt.current: 今の区間の元の矢印の key、opt.currentNodes: 今の区間の両端
     */
    function setFocus(focusIds, flowKeys, opt) {
      opt = opt || {};
      markKeys(null);
      var lv = level(cur);
      var focus = focusIds && focusIds.length ? new Set(focusIds.map(visibleId).filter(Boolean)) : null;
      var flow = flowKeys ? new Set(flowKeys) : null;
      var currentNodes = new Set((opt.currentNodes || []).map(visibleId).filter(Boolean));
      container.classList.toggle('has-focus', !!focus);
      layerNodes.querySelectorAll(':scope > .dg-node').forEach(function (g) {
        var id = g.getAttribute('data-id');
        g.classList.toggle('is-focus', !!focus && focus.has(id));
        g.classList.toggle('is-current', currentNodes.has(id));
      });
      layerEdges.querySelectorAll(':scope > .dg-edge').forEach(function (g) {
        var e = lv.edges[Number(g.getAttribute('data-idx'))];
        var hits = flow ? e.items.filter(function (i) { return flow.has(i.key); }) : [];
        var inFlow = !!flow && (flow.has(e.key) || hits.length > 0);
        var on = !!focus && focus.has(e.from) && focus.has(e.to);
        g.classList.toggle('is-focus', on || inFlow);
        g.classList.toggle('is-flowing', (flow ? inFlow : e.flow) && !IS_PRINT);
        g.classList.toggle('is-current', !!opt.current && e.items.some(function (i) { return i.key === opt.current; }));
        // 戻りのデータ (矢印と逆向きの流れ) は、点を逆向きに動かす
        var rev = !!opt.reverse && hits.length > 0 && hits.every(function (i) { return opt.reverse.has(i.key); });
        g.querySelectorAll('animateMotion').forEach(function (am) {
          if (rev) { am.setAttribute('keyPoints', '1;0'); am.setAttribute('keyTimes', '0;1'); am.setAttribute('calcMode', 'linear'); }
          else { am.removeAttribute('keyPoints'); am.removeAttribute('keyTimes'); am.removeAttribute('calcMode'); }
        });
      });
    }

    /** データの流れを強調する (upto があれば、その区間までを強調し、最後の区間を「今」として目立たせる) */
    function flowFocus(fs) {
      var segs = fs.upto ? fs.flow.segs.slice(0, fs.upto) : fs.flow.segs;
      var ids = [], keys = [], rev = new Set();
      segs.forEach(function (sg) {
        ids.push(sg.from, sg.to);
        if (sg.key) { keys.push(sg.key); if (sg.rev) rev.add(sg.key); }
      });
      var last = fs.upto ? segs[segs.length - 1] : null;
      setFocus(ids, keys, { reverse: rev, current: last && last.key, currentNodes: last ? [last.from, last.to] : [] });
    }

    /** 指定したデータ (edges の data) が流れる矢印を強調する */
    function dataFocus(name) {
      var es = allEdges.filter(function (e) { return (e.data || []).indexOf(name) >= 0; });
      var ids = [];
      es.forEach(function (e) { ids.push(e.from, e.to); });
      setFocus(ids, es.map(function (e) { return e.key; }));
      container.classList.add('has-focus'); // 該当がなくても、他を薄くして「ない」ことを示す
    }

    /** 選択のないときの強調: 流れを選んでいればその流れ、ステップが指す階層ならステップの指定 */
    function baseFocus() {
      var st = curStep();
      if (flowState) flowFocus(flowState);
      else if (dataState) dataFocus(dataState);
      else if (sim) simFocus();
      else if (cur === stepLevel(st)) setFocus(st.focus, st.flow);
      else setFocus(null, null);
      setCaption(captionText());
      updateFlowUI();
      updateSimUI();
    }

    /** 試しに遷移させる: 今の状態を光らせ、出ていける遷移に点を流す */
    function simFocus() {
      var out = outgoing(sim.cur);
      setFocus([sim.cur].concat(out.map(function (e) { return e.to; })), out.map(function (e) { return e.key; }), { currentNodes: [sim.cur] });
    }
    function simReset(id) {
      sim.cur = enterState(id || (states.filter(function (k) { return info[k].raw.initial && (info[k].parent === '' || info[info[k].parent].raw.kind !== 'state'); })[0] || states[0]));
      sim.history = [];
    }
    /** 遷移する: 行き先の状態 (中に状態があれば中の初期状態) へ移り、その状態が見える階層を表示する */
    function fire(e) {
      var from = sim.cur;
      sim.cur = enterState(e.to);
      sim.history.push({ from: from, to: sim.cur, event: e.event || e.label || '' });
      var p = info[sim.cur].parent;
      if (p === cur) baseFocus(); else navigate(p);
    }
    var simUI = null;
    if (sim) {
      simUI = h('div', 'dg-sim', container);
      simUI.addEventListener('click', function (ev) { ev.stopPropagation(); });
    }
    function updateSimUI() {
      if (!simUI) return;
      simUI.textContent = '';
      h('div', 'dg-sim-now', simUI, '今の状態: ' + chain(sim.cur).reverse().slice(1).filter(function (id) { return info[id].raw.kind === 'state'; }).map(function (id) { return String(info[id].label).replace(/\n/g, ' '); }).join(' › '));
      var out = outgoing(sim.cur);
      var row = h('div', 'dg-sim-events', simUI);
      if (!out.length) h('span', 'dg-sim-end', row, info[sim.cur].raw.final ? '終了' : '出ていく遷移がありません');
      out.forEach(function (e) {
        var b = h('button', 'dg-sim-btn', row, (e.event || e.label || '→') + ' → ' + String(info[e.to].label).replace(/\n/g, ' '));
        b.type = 'button';
        if (e.guard) b.title = '条件: ' + e.guard;
        b.addEventListener('click', function () { fire(e); });
      });
      var reset = h('button', 'dg-sim-btn is-reset', row, '↺ 最初から');
      reset.type = 'button';
      reset.addEventListener('click', function () { simReset(); var p = info[sim.cur].parent; if (p === cur) baseFocus(); else navigate(p); });
      if (sim.history.length) {
        h('div', 'dg-sim-history', simUI, '履歴: ' + sim.history.slice(-4).map(function (x) { return x.event; }).join(' → '));
      }
    }

    /** steps の at / zoom から階層を決める (中身のないノードなら、それが見える親の階層) */
    function levelOf(id) {
      if (id == null || id === '' || !info[String(id)]) return '';
      id = String(id);
      return info[id].kids.length ? id : info[id].parent;
    }

    function applyStep(animate) {
      selected = null;
      panel.hide();
      var st = curStep(), f = stepFlow(st);
      flowState = f ? { flow: f, upto: stepUpto(st, f), ui: false } : null;
      if (sim && (st.state || sim.cur == null)) simReset(st.state && info[st.state] ? String(st.state) : null);
      closeFlowMenu();
      setCaption(captionText());
      return go(stepLevel(st), animate).then(function (ok) {
        if (!ok) return;
        baseFocus();
        var sel = st.select && visibleId(st.select);
        if (sel) showDetail(level(cur).byId[sel]);
      });
    }

    function showDetail(n) {
      var extra = mapMode && !n.boundary ? links(n.id, false) : '';
      var cols = n.table ? '<table class="er-detail">' + n.cols.map(function (c) {
        return '<tr><td>' + (c.pk ? '<b>PK</b> ' : c.fk ? 'FK ' : '') + esc(c.name) + (c.note ? '<br><span class="muted">' + esc(c.note) + '</span>' : '') + '</td><td>' + esc(c.type) + '</td></tr>';
      }).join('') + '</table>' : '';
      if (n.detail || (n.sub && !n.boundary) || extra || cols) panel.show(String(n.label).replace(/\n/g, ' '), (n.detail || (n.sub ? esc(n.sub) : '')) + cols + extra);
    }

    /** マップ文書の詳細パネル用: 入ってくる・出ていく矢印と、通る流れ (inside: id の中の部品も含めて数える) */
    function links(id, inside) {
      function within(x) { return x === id || (inside && isAncestor(id, x)); }
      var ins = allEdges.filter(function (e) { return within(e.to) && !within(e.from); });
      var outs = allEdges.filter(function (e) { return within(e.from) && !within(e.to); });
      var through = flows.filter(function (f) { return f.segs.some(function (sg) { return within(sg.from) || within(sg.to); }); });
      function li(e, other) {
        var extra = [e.label, (e.data || []).join('・')].filter(Boolean).join(' / ');
        return '<li><a href="#" data-dg-go="' + esc(other) + '">' + nodeLabel(other) + '</a>' + (extra ? ' <span class="muted">' + esc(extra) + '</span>' : '') + '</li>';
      }
      function relLi(e, mine, other, otherCol) {
        return '<li><code>' + esc(mine) + '</code> → <a href="#" data-dg-go="' + esc(other) + '">' + nodeLabel(other) + '</a>.<code>' + esc(otherCol) + '</code> <span class="muted">' + esc(e.card) + '</span></li>';
      }
      var html = '';
      function section(title, list, fn) { if (list.length) html += '<h4>' + title + ' (' + list.length + ')</h4><ul>' + list.map(fn).join('') + '</ul>'; }
      function is(type) { return function (e) { return !e.rel && e.type === type; }; }
      function plain(e) { return !e.rel && e.type !== 'read' && e.type !== 'write'; }
      // 機能 → テーブルの読み書き (type: read / write) は、どちらの側から見ても「書く・読む」で並べる (CRUD 表の代わり)
      section('書き込む機能', ins.filter(is('write')), function (e) { return li(e, e.from); });
      section('読む機能', ins.filter(is('read')), function (e) { return li(e, e.from); });
      section('入ってくる', ins.filter(plain), function (e) { return li(e, e.from); });
      section('書き込む先', outs.filter(is('write')), function (e) { return li(e, e.to); });
      section('読む先', outs.filter(is('read')), function (e) { return li(e, e.to); });
      section('出ていく', outs.filter(plain), function (e) { return li(e, e.to); });
      section('参照している (外部キー)', outs.filter(function (e) { return e.rel; }), function (e) { return relLi(e, e.fromCol, e.to, e.toCol); });
      section('参照されている', ins.filter(function (e) { return e.rel; }), function (e) { return relLi(e, e.toCol, e.from, e.fromCol); });
      if (through.length) html += '<h4>通る流れ</h4><ul>' + through.map(function (f) { return '<li><a href="#" data-dg-flow="' + esc(f.id) + '">' + esc(f.label) + '</a></li>'; }).join('') + '</ul>';
      return html ? '<div class="dg-links">' + html + '</div>' : '';
    }

    /** id のノードが見える階層へ移り、中身のないノードなら選ぶ (目次・検索・URL から) */
    function reveal(id) {
      id = String(id == null ? '' : id);
      if (!info[id] || id === '') return navigate('');
      if (info[id].kids.length) return navigate(id);
      return navigate(info[id].parent, function () { selected = null; selectNode(id); });
    }
    // 詳細パネルの中のリンク。パネルは自分のクリックを外へ伝えないので、捕捉フェーズで受ける。
    // href="#" のまま既定の動作をさせると、<base> のある埋め込み (エディタのプレビュー) では
    // フレームごと別のページへ移ってしまう
    container.addEventListener('click', function (ev) {
      var a = ev.target.closest && ev.target.closest('[data-dg-go], [data-dg-flow]');
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (a.hasAttribute('data-dg-go')) reveal(a.getAttribute('data-dg-go'));
      else if (flowById[a.getAttribute('data-dg-flow')]) { dataState = null; pickFlow(flowById[a.getAttribute('data-dg-flow')]); }
    }, true);

    function nodeLabel(id) { return esc(String(info[id].label).replace(/\n/g, ' ')); }

    function selectNode(id) {
      var lv = level(cur), n = lv.byId[id];
      if (!n) return;
      if (n.boundary) { navigate(info[id].parent, function () { selectNode(id); }); return; } // 外のノード: それが見える階層へ移って選ぶ
      if (n.hasKids) { navigate(id); return; }
      if (selected === id) { clearSelection(); return; }
      selected = id;
      var near = lv.edges.filter(function (e) { return e.from === id || e.to === id; });
      setFocus([id].concat(near.map(function (e) { return e.from === id ? e.to : e.from; })), near.map(function (e) { return e.key; }));
      if (n.table) {
        var keys = new Set();
        near.forEach(function (e) { e.items.forEach(function (i) { if (i.rel) { keys.add(i.from + '.' + i.fromCol); keys.add(i.to + '.' + i.toCol); } }); });
        markKeys(keys);
      }
      panel.hide();
      showDetail(n);
      emit();
    }

    function selectEdge(e) {
      var key = 'edge:' + e.key;
      if (selected === key) { clearSelection(); return; }
      selected = key;
      setFocus([e.from, e.to], [e.key]);
      var html = '<ul>' + e.items.map(function (i) {
        var extra = [i.label, (i.data || []).join('・')].filter(Boolean).join(' / ');
        return '<li><b>' + nodeLabel(i.from) + '</b> → <b>' + nodeLabel(i.to) + '</b>' + (extra ? '<br><span class="muted">' + esc(extra) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
      var through = flows.filter(function (f) { return f.segs.some(function (sg) { return e.items.some(function (i) { return i.key === sg.key; }); }); });
      if (through.length) html += '<p class="muted">通る流れ: ' + through.map(function (f) { return esc(f.label); }).join('、') + '</p>';
      panel.show(String(info[e.from].label).replace(/\n/g, ' ') + ' → ' + String(info[e.to].label).replace(/\n/g, ' '), html);
    }

    function clearSelection() {
      var open = !container.querySelector(':scope > .dg-panel').hidden;
      if (!selected && !open) return false;
      selected = null;
      panel.hide();
      baseFocus();
      emit();
      return true;
    }

    function up() {
      if (!cur) return false;
      navigate(info[cur].parent);
      return true;
    }

    // ---- データの流れ: 右下の「流れ」ボタン (一覧から選ぶ・1 区間ずつ追う) ----
    var flowUI = null;
    if (flows.length && !IS_PRINT) {
      flowUI = h('div', 'dg-flowui', container);
      flowUI.addEventListener('click', function (ev) { ev.stopPropagation(); });
      var menu = h('div', 'dg-flowmenu', flowUI);
      menu.hidden = true;
      flows.forEach(function (f) {
        var b = h('button', 'dg-flowmenu-item', menu);
        b.type = 'button';
        b.setAttribute('data-flow', f.id);
        b.textContent = f.label;
        b.addEventListener('click', function () { closeFlowMenu(); pickFlow(f); });
      });
      var bar = h('div', 'dg-flowbar', flowUI);
      var toggle = h('button', 'dg-flowbtn dg-flow-pick', bar, '流れ ▾');
      toggle.addEventListener('click', function () { menu.hidden = !menu.hidden; });
      var prevB = h('button', 'dg-flowbtn dg-flow-prev', bar, '◀');
      var nextB = h('button', 'dg-flowbtn dg-flow-next', bar, '▶');
      var stopB = h('button', 'dg-flowbtn dg-flow-stop', bar, '×');
      [toggle, prevB, nextB, stopB].forEach(function (b) { b.type = 'button'; });
      prevB.setAttribute('aria-label', '前の区間');
      nextB.setAttribute('aria-label', '次の区間 (順に追う)');
      stopB.setAttribute('aria-label', '流れの強調をやめる');
      prevB.addEventListener('click', function () { if (flowState) moveFlow(flowState.upto && flowState.upto > 1 ? flowState.upto - 1 : null); });
      nextB.addEventListener('click', function () { if (flowState) moveFlow(Math.min(flowState.flow.segs.length, (flowState.upto || 0) + 1)); });
      stopB.addEventListener('click', function () { stopFlow(true); });
    }
    function closeFlowMenu() { if (flowUI) flowUI.querySelector('.dg-flowmenu').hidden = true; }
    function updateFlowUI() {
      if (!flowUI) return;
      var on = !!flowState;
      flowUI.classList.toggle('is-on', on);
      flowUI.querySelector('.dg-flow-pick').textContent = on ? flowState.flow.label + ' ▾' : '流れ ▾';
      flowUI.querySelectorAll('.dg-flowmenu-item').forEach(function (b) { b.classList.toggle('is-active', on && b.getAttribute('data-flow') === flowState.flow.id); });
      flowUI.querySelector('.dg-flow-prev').disabled = !on || !flowState.upto;
      flowUI.querySelector('.dg-flow-next').disabled = !on || flowState.upto === flowState.flow.segs.length;
    }
    /** 流れを選ぶ: 今の階層のまま、流れ全体を強調する */
    function pickFlow(f) {
      selected = null;
      panel.hide();
      flowState = { flow: f, upto: null, ui: true };
      baseFocus();
    }
    /** 流れを n 区間目まで進める (null で全体)。その区間が見える階層へ自動で移る */
    function moveFlow(n) {
      flowState = { flow: flowState.flow, upto: n, ui: true };
      if (!n) { baseFocus(); return; }
      var p = segLevel(flowState.flow.segs[n - 1]);
      if (p === cur) baseFocus(); else navigate(p);
    }
    /** 流れの強調をやめる (ステップが指定した流れに戻す)。force: ステップの流れも消す */
    function stopFlow(force) {
      if (!flowState || (!flowState.ui && !force)) return false;
      var st = curStep(), f = force ? null : stepFlow(st);
      flowState = f ? { flow: f, upto: stepUpto(st, f), ui: false } : null;
      closeFlowMenu();
      baseFocus();
      return true;
    }

    layerNodes.addEventListener('click', function (ev) {
      var g = ev.target.closest('.dg-node[data-id]');
      if (!g) return;
      ev.stopPropagation();
      selectNode(g.getAttribute('data-id'));
    });
    layerEdges.addEventListener('click', function (ev) {
      var g = ev.target.closest('.dg-edge[data-idx]');
      if (!g) return;
      ev.stopPropagation();
      selectEdge(level(cur).edges[Number(g.getAttribute('data-idx'))]);
    });
    svgEl.addEventListener('click', function () { closeFlowMenu(); if (selected) clearSelection(); });

    /** マップ文書・テストから使う操作 */
    container.jhDiagram = {
      title: String(info[''].label),
      nodes: function () { // 木の順 (親が先) のノード一覧
        var out = [];
        (function walk(p, depth) {
          info[p].kids.forEach(function (id) {
            var raw = info[id].raw;
            out.push({
              id: id, label: String(info[id].label).replace(/\n/g, ' '), parent: p, depth: depth, hasKids: info[id].kids.length > 0,
              kind: raw.kind || '', sub: raw.sub || '', tags: raw.tags || [], detail: raw.detail || '',
              columns: (info[id].cols || []).map(function (c) { return { name: c.name, type: c.type, pk: c.pk, fk: c.fk, note: c.note }; }),
            });
            walk(id, depth + 1);
          });
        })('', 0);
        return out;
      },
      path: function (id) { return chain(id).reverse().map(function (x) { return String(info[x].label).replace(/\n/g, ' '); }); },
      levels: function () { return [''].concat(this.nodes().filter(function (n) { return n.hasKids; }).map(function (n) { return n.id; })); },
      levelNodeCount: function (p) { return info[p] ? info[p].kids.length : 0; },
      dataNames: function () { return uniq([].concat.apply([], allEdges.map(function (e) { return e.data || []; }))); },
      level: function () { return cur; },
      selected: function () { return selected && selected.indexOf('edge:') !== 0 ? selected : null; },
      reveal: reveal,
      /** 階層 p をアニメーションなしで描く (印刷・検査用) */
      drawLevel: function (p) { selected = null; panel.hide(); draw(p, false); baseFocus(); },
      showData: function (name) { dataState = name || null; if (dataState) flowState = null; closeFlowMenu(); baseFocus(); },
      svg: svgEl,
      /** 状態遷移図: 今の状態と、出ていける遷移のイベント名 */
      simState: function () { return sim ? { cur: sim.cur, events: outgoing(sim.cur).map(function (e) { return e.event || e.label; }), history: sim.history.slice() } : null; },
    };

    instances.push({
      container: container,
      reset: function () { return clearSelection() || stopFlow() || up(); }, // Esc: 詳細 → 流れ → 上の階層の順に戻す
      back: function () { return up(); },
    });
    onSlideState(container, function () { applyStep(true); }, function () { selected = null; });
    if (IS_PRINT) { draw('', false); setFocus(null, null); } else applyStep(false);
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

  if (Deck && Deck.addAuditor) {
    Deck.addAuditor(function () {
      return dataIssues.map(function (d) {
        var sec = d.container.closest('section.slide');
        return { type: 'data', slide: sec ? Deck.slides.indexOf(sec) + 1 : 0, element: 'div.' + (d.container.className.split(' ')[0] || 'diagram'), message: d.message };
      });
    });
  }

  // Esc: 表示中のスライドで詳細を開いている図があれば、先に閉じる (エンジンの一覧表示より優先)
  // Esc / Backspace: 階層マップの中に入っていれば 1 つ上の階層へ戻る (エンジンの「前へ」より優先)
  window.addEventListener('keydown', function (ev) {
    if ((ev.key !== 'Escape' && ev.key !== 'Backspace') || ev.target.isContentEditable) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    var active = document.querySelector('.slide.active') || document.querySelector('.jh-map-stage');
    if (!active) return;
    var handled = false;
    instances.forEach(function (it) {
      if (!active.contains(it.container)) return;
      if (ev.key === 'Escape' ? it.reset() : it.back && it.back()) handled = true;
    });
    if (handled) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
})();
