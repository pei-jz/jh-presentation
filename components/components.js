/*!
 * 部品用スクリプト
 *   - コードのシンタックスハイライトと行ステップ   <code class="hl" data-lang="js" data-emph="2-3|5">
 *   - 数値のカウントアップ                         <span data-count-to="1200">1,200</span>
 *   - タイプライター表示                           <span data-typewriter>テキスト</span>
 *   - .anim-stagger の子要素に順番 (--i) を付与
 *   - .anim-draw の SVG 図形に pathLength="1" を付与
 *
 * DOM の変換はスクリプト読み込み時に即実行する (engine の初期化=ステップ計算より前に終わらせるため)。
 */
(function () {
  'use strict';

  var isPrint = window.Deck && window.Deck.mode === 'print';

  // ------------------------------------------------------------------
  // シンタックスハイライト
  // ------------------------------------------------------------------
  var C_LIKE = { line: '//', block: true };
  var LANGS = {
    js: Object.assign({ kw: 'const let var function return if else for while do break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this null undefined true false switch case yield super static get set' }, C_LIKE),
    ts: Object.assign({ kw: 'const let var function return if else for while do break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this null undefined true false switch case yield super static get set interface type enum implements private public protected readonly as keyof declare namespace abstract string number boolean any unknown never void' }, C_LIKE),
    cs: Object.assign({ kw: 'using namespace class struct record interface enum public private protected internal static void int long string bool double decimal var new return if else for foreach in while do break continue try catch finally throw async await null true false this base override virtual abstract sealed readonly const get set init where select from out ref params' }, C_LIKE),
    java: Object.assign({ kw: 'package import class interface enum extends implements public private protected static final void int long double boolean String var new return if else for while do break continue try catch finally throw throws null true false this super abstract' }, C_LIKE),
    go: Object.assign({ kw: 'package import func var const type struct interface map chan go defer return if else for range switch case default break continue select nil true false' }, C_LIKE),
    rust: Object.assign({ kw: 'fn let mut pub struct enum impl trait use mod match if else for in while loop return self Self true false as where async await move ref crate dyn const static' }, C_LIKE),
    py: { kw: 'def return if elif else for while break continue class import from as with try except finally raise lambda None True False and or not in is pass yield async await self global nonlocal', line: '#' },
    bash: { kw: 'if then else elif fi for in do done while case esac function return export local echo cd exit', line: '#' },
    sql: { kw: 'select from where and or not insert into values update set delete join left right inner outer full on group by order having limit offset as create table alter drop index view null is in like between distinct count sum avg max min case when then else end union all with primary key foreign references default', line: '--', block: true, ci: true },
    html: { kw: '', block: false },
    json: { kw: 'true false null' },
  };
  LANGS.javascript = LANGS.js; LANGS.typescript = LANGS.ts; LANGS.csharp = LANGS.cs;
  LANGS.python = LANGS.py; LANGS.sh = LANGS.bash; LANGS.shell = LANGS.bash;

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** 共通インデントと前後の空行を取り除く (HTML 内でインデントして書けるように) */
  function dedent(text) {
    var lines = text.replace(/\t/g, '  ').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    var min = Infinity;
    lines.forEach(function (l) { if (l.trim()) min = Math.min(min, l.match(/^ */)[0].length); });
    return lines.map(function (l) { return l.slice(min === Infinity ? 0 : min); }).join('\n');
  }

  /** テキストを [ { cls, text } ] のトークン列に分解 */
  function tokenize(text, lang) {
    var parts = [];
    if (lang.block) parts.push('(\\/\\*[\\s\\S]*?\\*\\/)');
    else parts.push('(?!)');
    parts.push(lang.line ? '(' + reEsc(lang.line) + '.*)' : '(?!)');
    parts.push('("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)');
    parts.push('(\\b\\d+(?:\\.\\d+)?\\b)');
    parts.push('([A-Za-z_$][\\w$]*)');
    var re = new RegExp(parts.join('|'), 'g');
    var kw = {};
    (lang.kw || '').split(/\s+/).forEach(function (w) { if (w) kw[lang.ci ? w.toLowerCase() : w] = 1; });

    var out = [], last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ cls: null, text: text.slice(last, m.index) });
      var cls = null;
      if (m[1] || m[2]) cls = 'tok-c';
      else if (m[3]) cls = 'tok-s';
      else if (m[4]) cls = 'tok-n';
      else if (m[5]) {
        var w = lang.ci ? m[5].toLowerCase() : m[5];
        if (kw[w]) cls = 'tok-k';
        else if (/^\s*\(/.test(text.slice(re.lastIndex))) cls = 'tok-f';
      }
      out.push({ cls: cls, text: m[0] });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ cls: null, text: text.slice(last) });
    return out;
  }

  /** トークン列を行ごとの HTML 配列に (複数行にまたがるトークンも行で分割) */
  function toLines(tokens) {
    var lines = [''];
    tokens.forEach(function (t) {
      t.text.split('\n').forEach(function (piece, i) {
        if (i > 0) lines.push('');
        if (!piece) return;
        lines[lines.length - 1] += t.cls ? '<span class="' + t.cls + '">' + esc(piece) + '</span>' : esc(piece);
      });
    });
    return lines;
  }

  /** "2-3|5|7" → [[2,3],[5],[7]] / "1,3-4" → [[1,3,4]] */
  function parseGroups(spec) {
    return spec.split('|').map(function (seg) {
      var nums = [];
      seg.split(',').forEach(function (r) {
        var m = r.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!m) return;
        for (var n = Number(m[1]); n <= Number(m[2] || m[1]); n++) nums.push(n);
      });
      return nums;
    }).filter(function (g) { return g.length; });
  }

  var codeSeq = 0;
  function highlight(code) {
    var lang = LANGS[(code.getAttribute('data-lang') || '').toLowerCase()] || { kw: '' };
    var text = dedent(code.textContent);
    var lines = toLines(tokenize(text, lang));
    var id = 'code' + (++codeSeq);
    var stepOf = {}; // 行番号 → ステップラベル
    var emph = code.getAttribute('data-emph');
    // data-emph-labels="a|b|c" でステップのラベルを指定すると、
    // 同じ data-step="a" を持つ他の要素 (説明文など) と同時に表示できる
    var labels = (code.getAttribute('data-emph-labels') || '').split('|');
    if (emph) {
      parseGroups(emph).forEach(function (g, gi) {
        var label = (labels[gi] || '').trim() || id + '-' + gi;
        g.forEach(function (n) { stepOf[n] = label; });
      });
    }
    var marked = {};
    var mark = code.getAttribute('data-mark');
    if (mark) parseGroups(mark).forEach(function (g) { g.forEach(function (n) { marked[n] = 1; }); });

    code.innerHTML = lines.map(function (html, i) {
      var n = i + 1, cls = 'line';
      var attr = '';
      if (stepOf[n]) { cls += ' step emph'; attr = ' data-step="' + stepOf[n] + '"'; }
      if (marked[n]) cls += ' marked';
      return '<span class="' + cls + '"' + attr + '>' + (html || ' ') + '</span>';
    }).join('');
  }

  document.querySelectorAll('code.hl').forEach(highlight);

  // ------------------------------------------------------------------
  // .anim-stagger の子要素に順番を付与
  // ------------------------------------------------------------------
  document.querySelectorAll('.anim-stagger').forEach(function (parent) {
    Array.prototype.forEach.call(parent.children, function (child, i) {
      child.style.setProperty('--i', String(i));
    });
  });

  // ------------------------------------------------------------------
  // .anim-draw の SVG 図形を pathLength=1 に正規化
  // ------------------------------------------------------------------
  var SHAPES = 'path, line, polyline, polygon, circle, rect, ellipse';
  document.querySelectorAll('.anim-draw').forEach(function (e) {
    if (e.matches(SHAPES)) e.setAttribute('pathLength', '1');
    e.querySelectorAll(SHAPES).forEach(function (s) { s.setAttribute('pathLength', '1'); });
  });

  // ------------------------------------------------------------------
  // 数値カウントアップ / タイプライター
  //   HTML には最終値を書いておく。スライド表示時(またはステップ表示時)に再生。
  // ------------------------------------------------------------------
  function formatNumber(v, decimals, sep) {
    var s = v.toFixed(decimals);
    if (!sep) return s;
    var p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }

  function runCounter(e) {
    var to = Number(e.getAttribute('data-count-to'));
    var from = Number(e.getAttribute('data-count-from') || 0);
    var dur = Number(e.getAttribute('data-duration') || 1400);
    var decimals = (String(to).split('.')[1] || '').length;
    var sep = e.getAttribute('data-sep') !== 'false';
    var start = null, done;
    cancelAnimationFrame(e._raf);
    if (e._done) e._done();
    trackBusy(new Promise(function (r) { done = e._done = r; }));
    function frame(t) {
      if (start == null) start = t;
      var p = Math.min(1, (t - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      e.textContent = formatNumber(from + (to - from) * eased, decimals, sep);
      if (p < 1) e._raf = requestAnimationFrame(frame);
      else done();
    }
    e._raf = requestAnimationFrame(frame);
  }

  function runTypewriter(e) {
    if (e._full == null) e._full = e.textContent;
    var full = e._full, i = 0;
    var speed = Number(e.getAttribute('data-speed') || 45);
    clearInterval(e._timer);
    if (e._done) e._done();
    var done;
    trackBusy(new Promise(function (r) { done = e._done = r; }));
    e.textContent = '';
    e.classList.add('is-typing');
    e._timer = setInterval(function () {
      e.textContent = full.slice(0, ++i);
      if (i >= full.length) { clearInterval(e._timer); e.classList.remove('is-typing'); done(); }
    }, speed);
  }

  function trackBusy(p) {
    if (window.Deck && window.Deck.track) window.Deck.track(p);
  }

  function hiddenByStep(e) {
    var s = e.closest('.step');
    return s && !s.classList.contains('visible');
  }

  function play(slide, onlyNew) {
    slide.querySelectorAll('[data-count-to], [data-typewriter]').forEach(function (e) {
      if (hiddenByStep(e)) { e._played = false; return; }
      if (onlyNew && e._played) return;
      e._played = true;
      if (e.hasAttribute('data-count-to')) runCounter(e); else runTypewriter(e);
    });
  }

  if (!isPrint) {
    document.addEventListener('deck:enter', function (ev) {
      ev.target.querySelectorAll('[data-count-to], [data-typewriter]').forEach(function (e) { e._played = false; });
      play(ev.target, false);
    });
    document.addEventListener('deck:step', function (ev) { play(ev.target, true); });
    // 離脱時は最終状態に戻す (一覧表示や戻った時に途中の値が見えないように)
    document.addEventListener('deck:leave', function (ev) {
      ev.target.querySelectorAll('[data-count-to]').forEach(function (e) {
        cancelAnimationFrame(e._raf);
        if (e._done) e._done();
        var to = Number(e.getAttribute('data-count-to'));
        e.textContent = formatNumber(to, (String(to).split('.')[1] || '').length, e.getAttribute('data-sep') !== 'false');
      });
      ev.target.querySelectorAll('[data-typewriter]').forEach(function (e) {
        clearInterval(e._timer);
        if (e._done) e._done();
        if (e._full != null) e.textContent = e._full;
        e.classList.remove('is-typing');
      });
    });
  }
})();
