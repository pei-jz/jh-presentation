/*!
 * マップ文書のビューア (依存なし)
 *   スライドなしで、階層マップ (.diagram) を画面いっぱいに表示し、全体から細部へたどって読む。
 *   - 左: 目次 (ノードの階層)。クリックでその階層へ
 *   - 上: 検索 (名前・説明・タグ)、データでの絞り込み、印刷
 *   - URL: #/<階層>/<選んだノード>。ブラウザの戻る・進むで階層を行き来でき、リンクで共有できる
 *   - ?print: 階層ごとに 1 ページ (図 + その階層の部品の説明) を並べた印刷用の表示
 *   - JhMap.audit() (= Deck.audit()): データの誤り・1 階層のノード数・文字の重なりを検査する
 *   - エディタの iframe の中: F5 を「発表」としてホストに渡し、再読み込みを止める (bindHost)
 * 読み込み順: mapdoc.js → diagrams.js → JhMap.start()
 */
(function () {
  'use strict';

  var PRINT = /[?&]print\b/.test(location.search);
  var tracked = [], auditors = [];
  var quiet = false; // 検査中は URL・目次を動かさない

  // diagrams.js はスライドのエンジン (window.Deck) の一部を使うので、マップ文書用に最小限を用意する
  if (!window.Deck) {
    window.Deck = {
      mode: PRINT ? 'print' : 'map',
      slides: [],
      track: function (p) {
        tracked.push(p);
        p.then(function () { tracked.splice(tracked.indexOf(p), 1); }, function () { tracked.splice(tracked.indexOf(p), 1); });
        return p;
      },
      addAuditor: function (fn) { auditors.push(fn); },
      /** 進行中の演出 (ズームなど) が終わるまで待つ */
      settled: function (timeout) {
        return Promise.race([
          (function wait() { return tracked.length ? Promise.all(tracked.slice()).then(wait) : Promise.resolve(); })(),
          new Promise(function (r) { setTimeout(r, timeout || 4000); }),
        ]);
      },
      audit: function () { return JhMap.audit(); },
    };
  }

  function h(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function plain(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    return d.textContent || '';
  }

  // ---- 画面の骨組み (diagrams.js が .diagram を描く前に作る) ----
  var dataEl = document.getElementById('jh-map-data');
  var brandEl = document.getElementById('jh-brand');
  var brand = {};
  try { brand = JSON.parse(brandEl ? brandEl.textContent : '{}'); } catch (e) { /* なし */ }

  var head = h('header', 'jh-map-head', null);
  var main = h('div', 'jh-map-main', null);
  var toc = h('nav', 'jh-map-toc', main);
  toc.setAttribute('aria-label', '目次');
  var stage = h('main', 'jh-map-stage', main);
  var container = h('div', 'diagram', stage);
  container.setAttribute('data-map', '');
  var script = document.createElement('script');
  script.type = 'application/json';
  script.textContent = dataEl ? dataEl.textContent : '{"nodes":[]}';
  container.appendChild(script);
  document.body.insertBefore(main, document.body.firstChild);
  document.body.insertBefore(head, main);

  var JhMap = window.JhMap = {
    start: start,
    audit: audit,
    get api() { return container.jhDiagram; },
  };

  function start() {
    var api = container.jhDiagram;
    if (!api) { document.documentElement.classList.add('map-ready'); return; }
    buildHead(api);
    buildToc(api);
    if (PRINT) buildPrint(api);
    else { bindUrl(api); bindHost(); }
    document.documentElement.classList.add('map-ready');
  }

  // ---- エディタ (ホスト) の iframe の中で動くとき ----
  //   スライドのエンジンと同じ約束 (docs/edit-protocol.md) のうち、表示に関わるものだけを話す。
  //   - ready に kind: 'map' を付けて、スライドのないマップ文書だと知らせる
  //   - F5 / Ctrl+R: ブラウザの再読み込みを止める (iframe の中で押すと、エディタ全体が読み込み直される)。
  //     F5 は「発表」としてホストに渡す
  //   - 発表中の Esc: 図が使わなければ (詳細パネル・階層が閉じきっていれば)、発表の終了をホストに頼む
  function bindHost() {
    if (!window.parent || window.parent === window) return;
    var presenting = false;
    function post(msg) {
      msg.jhdeck = 2;
      try { window.parent.postMessage(msg, '*'); } catch (e) { /* なし */ }
    }
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!d || !d.jhdeck || ev.source !== window.parent) return;
      if (d.type === 'present') presenting = !!d.on;
    });
    document.addEventListener('keydown', function (ev) {
      var k = ev.key, mod = ev.ctrlKey || ev.metaKey;
      if (k === 'F5' || (mod && (k === 'r' || k === 'R'))) {
        ev.preventDefault();
        if (k === 'F5') post({ type: 'present' });
        return;
      }
      // 図の Esc (diagrams.js) は先に捕捉フェーズで処理して止めるので、ここへ来るのは図が使わなかった Esc
      if (k === 'Escape' && presenting && !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) {
        ev.preventDefault();
        post({ type: 'present-exit' });
      }
    });
    post({ type: 'ready', kind: 'map', slides: 0, index: 0, step: 0 });
  }

  // ---- 上の帯: ブランド・題名・検索・データ・印刷 ----
  function buildHead(api) {
    var showBrand = document.body.getAttribute('data-brand') && document.body.getAttribute('data-brand') !== 'none';
    var tocBtn = h('button', 'jh-map-btn jh-map-toc-toggle', head, '☰');
    tocBtn.type = 'button';
    tocBtn.setAttribute('aria-label', '目次を開く');
    tocBtn.addEventListener('click', function () { document.body.classList.toggle('jh-toc-open'); });
    if (showBrand && (brand.logo || brand.name)) {
      var b = h('div', 'jh-map-brand', head);
      if (brand.logo) { var img = h('img', null, b); img.src = brand.logo; img.alt = brand.name || ''; }
      else h('span', null, b, brand.name);
    }
    h('h1', 'jh-map-title', head, document.title || api.title);
    if (showBrand && brand.label) h('span', 'jh-map-label', head, brand.label);
    if (PRINT) return;

    var tools = h('div', 'jh-map-tools', head);
    var searchBox = h('div', 'jh-map-search', tools);
    var input = h('input', null, searchBox);
    input.type = 'search';
    input.placeholder = '検索 (名前・説明)';
    input.setAttribute('aria-label', '検索');
    var results = h('ul', 'jh-map-results', searchBox);
    results.hidden = true;
    var index = api.nodes().map(function (n) {
      var cols = (n.columns || []).map(function (c) { return c.name + ' ' + (c.note || ''); }).join(' ');
      return { n: n, text: [n.label, n.sub, (n.tags || []).join(' '), plain(n.detail), cols].join(' ').toLowerCase() };
    });
    function search() {
      var q = input.value.trim().toLowerCase();
      results.textContent = '';
      if (!q) { results.hidden = true; return; }
      var hits = index.filter(function (it) { return q.split(/\s+/).every(function (w) { return it.text.indexOf(w) >= 0; }); }).slice(0, 20);
      if (!hits.length) h('li', 'jh-map-noresult', results, '見つかりません');
      hits.forEach(function (it) {
        var li = h('li', null, results);
        var a = h('button', 'jh-map-result', li);
        a.type = 'button';
        a.setAttribute('data-id', it.n.id);
        h('b', null, a, it.n.label);
        h('span', 'jh-map-result-path', a, api.path(it.n.parent).join(' › '));
        a.addEventListener('click', function () { go(it.n.id); });
      });
      results.hidden = false;
    }
    function go(id) {
      results.hidden = true;
      input.value = '';
      input.blur(); // Esc / Backspace を図の操作 (閉じる・上へ) に戻す
      document.body.classList.remove('jh-toc-open');
      api.reveal(id);
    }
    input.addEventListener('input', search);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { var first = results.querySelector('.jh-map-result'); if (first) go(first.getAttribute('data-id')); }
      if (ev.key === 'Escape') { input.value = ''; results.hidden = true; ev.stopPropagation(); }
    });
    document.addEventListener('click', function (ev) { if (!searchBox.contains(ev.target)) results.hidden = true; });

    var names = api.dataNames();
    if (names.length) {
      var sel = h('select', 'jh-map-data', tools);
      sel.setAttribute('aria-label', 'データで絞り込む');
      h('option', null, sel, 'データ: すべて').value = '';
      names.forEach(function (n) { h('option', null, sel, n).value = n; });
      sel.addEventListener('change', function () { api.showData(sel.value); });
    }
    var printBtn = h('button', 'jh-map-btn', tools, '印刷');
    printBtn.type = 'button';
    printBtn.addEventListener('click', function () { window.open(location.pathname + '?print&autoprint', '_blank'); });
  }

  // ---- 目次 ----
  function buildToc(api) {
    var ul = h('ul', null, toc);
    var items = {};
    function item(id, label, depth, hasKids) {
      var li = h('li', null, ul);
      var b = h('button', 'jh-toc-item' + (hasKids ? ' has-kids' : ''), li, label);
      b.type = 'button';
      b.style.setProperty('--depth', depth);
      b.setAttribute('data-id', id);
      b.addEventListener('click', function () { document.body.classList.remove('jh-toc-open'); api.reveal(id); });
      items[id] = b;
    }
    item('', api.title, 0, true);
    api.nodes().forEach(function (n) { item(n.id, n.label, n.depth + 1, n.hasKids); });
    function mark(level, sel) {
      Object.keys(items).forEach(function (id) {
        items[id].classList.toggle('is-current', id === level);
        items[id].classList.toggle('is-selected', id === sel);
      });
      var on = items[sel] || items[level];
      if (on && on.scrollIntoView && !PRINT) on.scrollIntoView({ block: 'nearest' });
    }
    container.addEventListener('dg:change', function (ev) { if (!quiet) mark(ev.detail.level, ev.detail.selected); });
    mark(api.level(), api.selected());
  }

  // ---- URL (#/<階層>/<選んだノード>) ----
  function bindUrl(api) {
    var lastLevel = api.level();
    function hashOf(level, sel) { return '#/' + encodeURIComponent(level) + (sel ? '/' + encodeURIComponent(sel) : ''); }
    function read() {
      var m = location.hash.match(/^#\/([^/]*)(?:\/(.+))?$/);
      return m ? { level: decodeURIComponent(m[1]), sel: m[2] ? decodeURIComponent(m[2]) : null } : null;
    }
    container.addEventListener('dg:change', function (ev) {
      if (quiet) return;
      var hs = hashOf(ev.detail.level, ev.detail.selected);
      if (hs === location.hash || (!location.hash && hs === '#/')) { lastLevel = ev.detail.level; return; }
      try {
        if (ev.detail.level !== lastLevel) history.pushState(null, '', hs); // 階層の移動は履歴に残す (戻るで戻れる)
        else history.replaceState(null, '', hs);
      } catch (e) { /* 埋め込み (srcdoc・<base> 付き) では URL を変えられない。表示はそのまま続ける */ }
      lastLevel = ev.detail.level;
    });
    function apply() {
      var r = read() || { level: '', sel: null }; // ハッシュがなければ全体
      if (r.sel) api.reveal(r.sel);
      else if (r.level !== api.level() || api.selected()) api.reveal(r.level);
    }
    window.addEventListener('popstate', apply);
    window.addEventListener('hashchange', apply);
    apply();
  }

  // ---- 印刷: 階層ごとに 1 ページ ----
  function buildPrint(api) {
    document.body.classList.add('jh-map-printing');
    var pages = h('div', 'jh-map-print', null);
    document.body.insertBefore(pages, main);
    var nodes = api.nodes();
    api.levels().forEach(function (p) {
      api.drawLevel(p);
      var page = h('section', 'jh-print-page', pages);
      h('h2', null, page, api.path(p).join(' › '));
      var fig = h('div', 'jh-print-fig dg is-drill', page); // 図の部品の見た目 (.dg.is-drill …) をそのまま使う
      var svg = api.svg.cloneNode(true);
      svg.removeAttribute('id');
      fig.appendChild(svg);
      var kids = nodes.filter(function (n) { return n.parent === p; });
      var rows = kids.filter(function (n) { return n.sub || n.detail || n.hasKids || (n.columns && n.columns.length); });
      if (rows.length) {
        var table = h('table', 'table jh-print-table', page);
        rows.forEach(function (n) {
          var tr = h('tr', null, table);
          var th = h('th', null, tr, n.label);
          if (n.hasKids) h('span', 'jh-print-more', th, '→ 次のページ以降');
          var td = h('td', null, tr);
          if (n.sub) h('div', 'muted', td, n.sub);
          if (n.detail) { var d = h('div', null, td); d.innerHTML = n.detail; }
          if (n.columns && n.columns.length) { // テーブル: 列の一覧
            h('div', 'jh-print-cols', td, n.columns.map(function (c) { return (c.pk ? 'PK ' : c.fk ? 'FK ' : '') + c.name + (c.type ? ' ' + c.type : ''); }).join(' / '));
          }
        });
      }
    });
    api.drawLevel('');
    if (/[?&]autoprint\b/.test(location.search)) setTimeout(function () { window.print(); }, 300);
  }

  // ---- 検査 ----
  /**
   * 問題ごとに { type, level, ... } を返す (空配列 = 検査した範囲では問題なし)
   *   data    : データの誤り (存在しない id への矢印、流れの途切れ、id の重複)
   *   density : 1 つの階層のノードが多すぎる (12 個を超える)
   *   overlap : 図の中の文字同士が重なっている (全階層を描いて調べる)
   */
  function audit() {
    var issues = [];
    auditors.forEach(function (fn) {
      (fn() || []).forEach(function (i) { issues.push({ type: i.type, message: i.message }); });
    });
    var api = container.jhDiagram;
    if (!api) return issues;
    var keepLevel = api.level(), keepSel = api.selected();
    quiet = true;
    try { checkLevels(api, issues); } finally { api.drawLevel(keepLevel); quiet = false; }
    if (keepSel) api.reveal(keepSel);
    return issues;
  }

  function checkLevels(api, issues) {
    api.levels().forEach(function (p) {
      var where = api.path(p).join(' › ');
      var count = api.levelNodeCount(p);
      if (count > 12) issues.push({ type: 'density', level: where, count: count, message: '1 つの階層のノードが ' + count + ' 個あります。12 個程度までにし、多ければ children で入れ子にする' });
      api.drawLevel(p);
      var texts = Array.prototype.slice.call(api.svg.querySelectorAll('.dg-nodes text, .dg-edge-label')).map(function (t) {
        return { t: t, r: t.getBoundingClientRect(), node: t.closest('.dg-node') };
      }).filter(function (x) { return x.r.width && x.r.height && x.t.textContent.trim(); });
      for (var i = 0; i < texts.length; i++) {
        for (var j = i + 1; j < texts.length; j++) {
          var A = texts[i], B = texts[j];
          if (A.node && A.node === B.node) continue;
          var w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
          var hh = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
          if (w <= 0 || hh <= 0) continue;
          var ratio = (w * hh) / Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
          if (ratio > 0.2) issues.push({ type: 'overlap', level: where, overlap: Math.round(ratio * 100) + '%', text: A.t.textContent.trim() + ' × ' + B.t.textContent.trim() });
        }
      }
    });
  }
})();
