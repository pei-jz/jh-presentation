/*!
 * JH Deck Engine — 依存なしの軽量 HTML プレゼンエンジン
 *
 * - 1920x1080 の固定キャンバスを画面サイズに合わせて拡縮
 * - スライド送り / ステップ表示 / URL ハッシュ同期 (#3 または #3.2)
 * - 発表者ビュー (S)・一覧 (O)・ブラックアウト (B)・全画面 (F)
 * - ?print で PDF 用レイアウト, ?embed で発表者ビュー内プレビュー用
 * - Deck.onSlide(id, { enter, leave, step, print }) でスライド単位のフック
 * - Deck.audit() でスライドからはみ出した要素を検出
 *
 * classic script なので file:// で直接開いても動作する。
 */
(function () {
  'use strict';

  var W = 1920, H = 1080;
  var params = new URLSearchParams(location.search);
  var MODE = params.has('print') ? 'print'
    : params.has('presenter') ? 'presenter'
    : params.has('embed') ? 'embed'
    : 'main';
  var KEY = location.pathname; // 発表者ビューとの通信キー

  var slides = [];
  var state = { index: 0, step: 0 };
  var started = false;
  var deckEl, stage, chrome = {};
  var slideHooks = {};
  var changeListeners = [];
  var activeCleanup = null;
  var peer = null; // 発表者ビュー <-> メイン の相手ウィンドウ

  var printTasks = [];   // print フックが返した Promise
  var busyTasks = [];    // 部品が登録した進行中の演出 (カウントアップ・タイプライターなど)

  /** フォント・画像の読み込みと、PDF 用の非同期描画が終わるまで待つ */
  function whenReady() {
    var waits = [];
    if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready);
    Array.prototype.forEach.call(document.images, function (img) {
      if (img.decode) waits.push(img.decode().catch(function () { /* 壊れた画像は監査で報告 */ }));
    });
    return Promise.all(waits.concat(printTasks.map(function (t) { return t.catch(function (e) { console.error('[deck] print フックでエラー', e); }); })));
  }

  /**
   * 表示が落ち着くまで待つ: whenReady + 有限の CSS アニメーション・トランジション + 部品の演出
   * (無限に繰り返すアニメーションは待たない)。timeout ms を過ぎたら打ち切る
   */
  function settled(timeout) {
    var finite = (document.getAnimations ? document.getAnimations() : []).filter(function (a) {
      var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
      return t.iterations !== Infinity && a.playState !== 'finished';
    }).map(function (a) { return a.finished.catch(function () { /* キャンセル */ }); });
    var all = Promise.all([whenReady()].concat(finite, busyTasks.slice()));
    return Promise.race([all, new Promise(function (r) { setTimeout(r, timeout || 8000); })]);
  }

  /** 部品から、進行中の演出を登録する (settled が完了を待つ) */
  function track(promise) {
    busyTasks.push(promise);
    promise.then(function () { busyTasks.splice(busyTasks.indexOf(promise), 1); }, function () { busyTasks.splice(busyTasks.indexOf(promise), 1); });
    return promise;
  }

  var Deck = window.Deck = {
    mode: MODE,
    W: W,
    H: H,
    /** スライド(id)ごとのフックを登録: { enter(el), leave(el), step(el, n), print(el) }
     *  enter が関数を返した場合、leave 時にクリーンアップとして呼ばれる */
    onSlide: function (id, handlers) { slideHooks[id] = handlers; },
    /** 状態変化(スライド/ステップ)ごとに呼ばれる: fn({ index, step, slide }) */
    onChange: function (fn) { changeListeners.push(fn); },
    next: next,
    prev: prev,
    goto: function (index, step) { go(index, step == null ? 0 : step); },
    audit: audit,
    whenReady: whenReady,
    settled: settled,
    track: track,
    get index() { return state.index; },
    get step() { return state.step; },
    get slides() { return slides; },
  };

  // ------------------------------------------------------------------
  // ユーティリティ
  // ------------------------------------------------------------------
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function baseUrl() { return location.href.split('#')[0].split('?')[0]; }
  function hashFor(index, step) { return '#' + (index + 1) + (step ? '.' + step : ''); }
  function parseHash() {
    var m = /^#(\d+)(?:\.(\d+))?$/.exec(location.hash);
    return m ? { index: Number(m[1]) - 1, step: m[2] ? Number(m[2]) : 0 } : null;
  }
  function hookFor(slide) { return slide.id ? slideHooks[slide.id] : null; }
  function emit(slide, name, detail) {
    slide.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true }));
  }

  // ------------------------------------------------------------------
  // ステップ
  //   - data-step なし      : DOM 順にそれぞれ 1 ステップ
  //   - data-step="ラベル"  : 同じラベルは同時に表示 (最初に出現した位置の順)
  //   - スライド内の全ステップが数値ラベルなら数値順
  // ------------------------------------------------------------------
  function computeSteps(slide) {
    var groups = [], byKey = {}, allNumeric = true;
    slide.querySelectorAll('.step').forEach(function (e) {
      var key = e.getAttribute('data-step');
      if (key == null || key === '') {
        allNumeric = false;
        groups.push({ key: null, els: [e] });
        return;
      }
      if (isNaN(Number(key))) allNumeric = false;
      if (!byKey[key]) { byKey[key] = { key: key, els: [] }; groups.push(byKey[key]); }
      byKey[key].els.push(e);
    });
    if (allNumeric) groups.sort(function (a, b) { return Number(a.key) - Number(b.key); });
    return groups.map(function (g) { return g.els; });
  }

  // ------------------------------------------------------------------
  // 遷移
  // ------------------------------------------------------------------
  function go(index, step, fromPeer) {
    if (!slides.length) return;
    index = clamp(index, 0, slides.length - 1);
    var max = slides[index]._steps.length;
    step = step === Infinity ? max : clamp(step || 0, 0, max);

    var slideChanged = !started || index !== state.index;
    var stepChanged = !started || slideChanged || step !== state.step;
    if (!stepChanged) return;

    if (started && slideChanged) leaveSlide(slides[state.index]);
    state.index = index;
    state.step = step;
    started = true;

    render();
    var cur = slides[index];
    if (slideChanged) enterSlide(cur);
    // どの入り方 (順送り・戻る・#3.2 への直接移動・発表者ビュー) でも同じ表示になるよう、
    // スライドに入ったときも step を呼ぶ。step は「現在のステップ数から表示を決める」(冪等) ように書く
    var h = hookFor(cur);
    if (h && h.step) safeCall(h.step, cur, step);
    emit(cur, 'deck:step', { step: step });

    if (MODE === 'main' || MODE === 'presenter') {
      try { history.replaceState(null, '', hashFor(index, step)); } catch (e) { /* srcdoc など */ }
    }
    if (MODE === 'main') postHost({ type: 'state', index: index, step: step });
    if (!fromPeer) sendState();
    changeListeners.forEach(function (fn) { fn({ index: index, step: step, slide: cur }); });
  }

  function next() {
    var max = slides[state.index]._steps.length;
    if (state.step < max) go(state.index, state.step + 1);
    else if (state.index < slides.length - 1) go(state.index + 1, 0);
  }

  function prev() {
    if (state.step > 0) go(state.index, state.step - 1);
    else if (state.index > 0) go(state.index - 1, Infinity);
  }

  function safeCall(fn, a, b) {
    try { return fn(a, b); } catch (e) { console.error('[deck] スライドのフックでエラー', e); return undefined; }
  }

  function enterSlide(slide) {
    var h = hookFor(slide);
    if (h && h.enter) {
      var ret = safeCall(h.enter, slide);
      if (typeof ret === 'function') activeCleanup = ret;
    }
    emit(slide, 'deck:enter', {});
  }

  function leaveSlide(slide) {
    if (activeCleanup) { try { activeCleanup(); } catch (e) { console.error(e); } activeCleanup = null; }
    var h = hookFor(slide);
    if (h && h.leave) safeCall(h.leave, slide);
    emit(slide, 'deck:leave', {});
  }

  function render() {
    slides.forEach(function (s, i) {
      s.classList.toggle('active', i === state.index);
      s.classList.toggle('past', i < state.index);
      s.classList.toggle('future', i > state.index);
      s.setAttribute('aria-hidden', i === state.index ? 'false' : 'true');
    });
    var cur = slides[state.index];
    cur._steps.forEach(function (group, i) {
      group.forEach(function (e) {
        e.classList.toggle('visible', i < state.step);
        e.classList.toggle('current', i === state.step - 1);
      });
    });
    if (chrome.progress) {
      var total = slides.length > 1 ? slides.length - 1 : 1;
      chrome.progress.style.transform = 'scaleX(' + (state.index / total) + ')';
    }
    if (chrome.pageno) {
      chrome.pageno.textContent = (state.index + 1) + ' / ' + slides.length;
      chrome.pageno.hidden = cur.classList.contains('no-chrome');
    }
    if (chrome.brand) {
      chrome.brand.className = 'deck-brand-holder brand-' + brand.pos + ' ' + brandState(cur);
    }
    if (MODE === 'presenter') renderPresenter();
  }

  // ------------------------------------------------------------------
  // 画面フィット
  // ------------------------------------------------------------------
  function scale() { return Math.min(window.innerWidth / W, window.innerHeight / H); }
  function fit() {
    if (!stage || MODE === 'print') return;
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale() + ')';
  }

  // ------------------------------------------------------------------
  // 発表者ビュー連携 (window.open + postMessage: file:// でも動作)
  // ------------------------------------------------------------------
  function sendState() {
    if (!peer || peer.closed) return;
    try {
      peer.postMessage({ __deck: KEY, type: 'state', index: state.index, step: state.step }, '*');
    } catch (e) { /* 相手が閉じた */ }
  }

  function onMessage(e) {
    var d = e.data;
    if (!d || d.__deck !== KEY) return;
    if (d.type === 'hello') { peer = e.source; sendState(); return; }
    if (d.type === 'state') {
      peer = e.source;
      if (d.index !== state.index || d.step !== state.step) go(d.index, d.step, true);
    }
  }

  function openPresenter() {
    var url = baseUrl() + '?presenter' + hashFor(state.index, state.step);
    peer = window.open(url, 'deck-presenter', 'width=1400,height=860');
  }

  // ------------------------------------------------------------------
  // 発表者ビュー
  // ------------------------------------------------------------------
  var pv = {};
  function buildPresenter() {
    document.body.classList.add('deck-presenter-mode');
    var root = el('div', 'pv');
    root.innerHTML =
      '<div class="pv-current"><div class="pv-label">現在</div><div class="pv-frame"><iframe title="現在のスライド"></iframe></div></div>' +
      '<div class="pv-side">' +
      '  <div class="pv-next"><div class="pv-label">次</div><div class="pv-frame"><iframe title="次のスライド"></iframe></div><div class="pv-end">終了</div></div>' +
      '  <div class="pv-meta"><div class="pv-timer" title="クリックで一時停止 / ダブルクリックでリセット">00:00</div><div class="pv-clock"></div><div class="pv-pos"></div></div>' +
      '</div>' +
      '<div class="pv-notes"><div class="pv-label">ノート</div><div class="pv-notes-body"></div></div>';
    document.body.appendChild(root);
    var frames = root.querySelectorAll('iframe');
    pv.cur = frames[0];
    pv.next = frames[1];
    pv.nextWrap = root.querySelector('.pv-next');
    pv.notes = root.querySelector('.pv-notes-body');
    pv.pos = root.querySelector('.pv-pos');
    pv.timer = root.querySelector('.pv-timer');
    pv.clock = root.querySelector('.pv-clock');
    var embed = baseUrl() + '?embed';
    pv.cur.src = embed + hashFor(state.index, state.step);
    pv.next.src = embed + '#1';

    // タイマー
    var elapsed = 0, last = Date.now(), running = true;
    function tick() {
      var now = Date.now();
      if (running) elapsed += now - last;
      last = now;
      var s = Math.floor(elapsed / 1000);
      pv.timer.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      pv.timer.classList.toggle('paused', !running);
      var d = new Date();
      pv.clock.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    pv.timer.addEventListener('click', function () { running = !running; tick(); });
    pv.timer.addEventListener('dblclick', function () { elapsed = 0; running = true; tick(); });
    setInterval(tick, 500);
    tick();

    // メインウィンドウへ接続 (メイン側がリロードされても再接続できるよう定期的に送る)
    if (window.opener) {
      peer = window.opener;
      var hello = function () {
        try { window.opener.postMessage({ __deck: KEY, type: 'hello' }, '*'); } catch (e) { /* noop */ }
      };
      hello();
      setInterval(hello, 2000);
    }
  }

  function setFrameHash(frame, hash) {
    var url = baseUrl() + '?embed' + hash;
    try {
      // 同一オリジン(http)ならリロードせずに遷移
      if (frame.contentWindow && frame.contentWindow.Deck) {
        frame.contentWindow.location.hash = hash;
        return;
      }
    } catch (e) { /* file:// などでアクセス不可 */ }
    if (frame.src !== url) frame.src = url;
  }

  function renderPresenter() {
    if (!pv.cur) return;
    var cur = slides[state.index];
    setFrameHash(pv.cur, hashFor(state.index, state.step));
    var max = cur._steps.length;
    var isEnd = state.index === slides.length - 1 && state.step >= max;
    pv.nextWrap.classList.toggle('is-end', isEnd);
    if (!isEnd) {
      setFrameHash(pv.next, state.step < max ? hashFor(state.index, state.step + 1) : hashFor(state.index + 1, 0));
    }
    var notes = cur.querySelector('aside.notes');
    pv.notes.innerHTML = notes ? notes.innerHTML : '<span class="pv-empty">(ノートなし)</span>';
    pv.pos.textContent = 'スライド ' + (state.index + 1) + ' / ' + slides.length +
      (max ? '　ステップ ' + state.step + ' / ' + max : '');
  }

  // ------------------------------------------------------------------
  // 一覧 (Overview)
  // ------------------------------------------------------------------
  var overview = null;
  function toggleOverview(force) {
    var show = force != null ? force : !overview;
    if (!show) {
      if (overview) { overview.remove(); overview = null; }
      return;
    }
    overview = el('div', 'deck-overview');
    slides.forEach(function (s, i) {
      var thumb = el('button', 'deck-thumb' + (i === state.index ? ' is-current' : ''));
      thumb.type = 'button';
      var inner = el('div', 'deck-thumb-inner');
      var clone = s.cloneNode(true);
      clone.classList.remove('active', 'past', 'future');
      clone.classList.add('deck-thumb-slide');
      clone.querySelectorAll('.step').forEach(function (e) { e.classList.add('visible'); });
      inner.appendChild(clone);
      thumb.appendChild(inner);
      thumb.appendChild(el('span', 'deck-thumb-no', String(i + 1)));
      thumb.addEventListener('click', function () { toggleOverview(false); go(i, 0); });
      overview.appendChild(thumb);
    });
    document.body.appendChild(overview);
    var curThumb = overview.querySelector('.is-current');
    if (curThumb) curThumb.scrollIntoView({ block: 'center' });
  }

  // ------------------------------------------------------------------
  // ヘルプ・ブラックアウト
  // ------------------------------------------------------------------
  var helpEl = null;
  function toggleHelp() {
    if (helpEl) { helpEl.remove(); helpEl = null; return; }
    helpEl = el('div', 'deck-help',
      '<div class="deck-help-box"><h2>キーボード操作</h2><table>' +
      '<tr><td>→ ↓ Space PageDown Enter</td><td>次へ</td></tr>' +
      '<tr><td>← ↑ PageUp Backspace</td><td>前へ</td></tr>' +
      '<tr><td>Home / End</td><td>最初 / 最後</td></tr>' +
      '<tr><td>数字 + Enter</td><td>指定スライドへ移動</td></tr>' +
      '<tr><td>O / Esc</td><td>スライド一覧</td></tr>' +
      '<tr><td>S</td><td>発表者ビュー</td></tr>' +
      '<tr><td>E</td><td>文字の編集モード</td></tr>' +
      '<tr><td>F</td><td>全画面 (F11 / Esc で解除)</td></tr>' +
      '<tr><td>B または .</td><td>ブラックアウト</td></tr>' +
      '<tr><td>?</td><td>このヘルプ</td></tr>' +
      '</table></div>');
    helpEl.addEventListener('click', toggleHelp);
    document.body.appendChild(helpEl);
  }

  function toggleBlack() { document.body.classList.toggle('deck-black'); }

  function toggleFullscreen() {
    autoFullscreenPending = false;
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () { /* noop */ });
  }

  // ------------------------------------------------------------------
  // 最初の操作で全画面 (発表モード): <div class="deck" data-auto-fullscreen="true"> または URL に ?fullscreen
  //   ブラウザは操作なしの全画面化を許さないので、最初の → キー・クリック・スワイプで全画面にする (1 回だけ)
  // ------------------------------------------------------------------
  var autoFullscreenPending = false;
  var NAV_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: 1, ArrowUp: 1, ' ': 1, PageDown: 1, PageUp: 1, Enter: 1, Home: 1, End: 1 };

  function setupAutoFullscreen() {
    var on = deckEl.getAttribute('data-auto-fullscreen') === 'true' || params.has('fullscreen');
    if (!on || MODE !== 'main' || HAS_PARENT || !document.documentElement.requestFullscreen) return;
    if (isFullscreenNow()) return; // 全画面のウィンドウで開かれている (open_deck の fullscreen)
    autoFullscreenPending = true;
    toast('→ キーかクリックで全画面になります');
  }

  function isFullscreenNow() {
    return !!document.fullscreenElement || (window.innerWidth >= screen.width - 1 && window.innerHeight >= screen.height - 1);
  }

  function maybeAutoFullscreen() {
    if (!autoFullscreenPending) return;
    autoFullscreenPending = false;
    if (isFullscreenNow()) return;
    document.documentElement.requestFullscreen().catch(function () { /* 許可されなかった */ });
  }

  // ------------------------------------------------------------------
  // 入力
  // ------------------------------------------------------------------
  var jumpBuffer = '';
  function isTyping(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    var k = e.key;
    // デモ内のボタンにフォーカスがある時の Space / Enter はボタン操作を優先
    if ((k === ' ' || k === 'Enter') && e.target && e.target.closest && e.target.closest('button, a[href], summary')) return;
    if (NAV_KEYS[k] && !overview && !helpEl) maybeAutoFullscreen();

    if (/^[0-9]$/.test(k)) { jumpBuffer += k; return; }
    if (k === 'Enter' && jumpBuffer) {
      go(Number(jumpBuffer) - 1, 0);
      jumpBuffer = '';
      e.preventDefault();
      return;
    }
    jumpBuffer = '';

    if (overview && (k === 'Escape' || k === 'o' || k === 'O')) { toggleOverview(false); e.preventDefault(); return; }
    if (helpEl && (k === 'Escape' || k === '?')) { toggleHelp(); e.preventDefault(); return; }

    switch (k) {
      case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown': case 'Enter':
        next(); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
        prev(); break;
      case 'Home': go(0, 0); break;
      case 'End': go(slides.length - 1, Infinity); break;
      case 'Escape':
        if (MODE !== 'main') return;
        if (edit.on) setEditMode(false); // 編集モード中の Esc (枠の外) は編集モードを終了
        else if (hostPresenting) postHost({ type: 'present-exit' });
        else toggleOverview();
        break;
      case 'o': case 'O':
        if (MODE === 'main') toggleOverview(); else return;
        break;
      case 's': case 'S':
        if (MODE === 'main') openPresenter(); else return;
        break;
      case 'e': case 'E':
        if (MODE === 'main' && EditLib) setEditMode(!edit.on); else return;
        break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'b': case 'B': case '.': toggleBlack(); break;
      case '?': toggleHelp(); break;
      default: return;
    }
    e.preventDefault();
  }

  function bindTouch() {
    var x0 = null, y0 = null;
    stage.addEventListener('touchstart', function (e) {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { maybeAutoFullscreen(); if (dx < 0) next(); else prev(); }
      x0 = null;
    });
  }

  // ------------------------------------------------------------------
  // 印刷 (PDF) モード
  // ------------------------------------------------------------------
  function setupPrint() {
    document.body.classList.add('deck-print-mode');
    slides.forEach(function (s, i) {
      s.classList.add('active');
      s.querySelectorAll('.step').forEach(function (e) { e.classList.add('visible'); });
      if (!s.classList.contains('no-chrome')) {
        s.appendChild(el('div', 'deck-print-pageno', (i + 1) + ' / ' + slides.length));
      }
      if (brand) {
        var holder = el('div', 'deck-brand-holder ' + brandState(s) + ' brand-' + brand.pos);
        brand.parts.forEach(function (p) { holder.appendChild(p.cloneNode(true)); });
        s.appendChild(holder);
      }
      var h = hookFor(s);
      if (h && h.print) {
        var r = safeCall(h.print, s);
        if (r && typeof r.then === 'function') printTasks.push(r);
      }
    });
  }

  // ------------------------------------------------------------------
  // 監査: スライドからはみ出している要素を返す
  //   AI やスクリプトから Deck.audit() で呼び出し、レイアウト崩れを検出する
  // ------------------------------------------------------------------
  /**
   * レイアウトの検査。問題ごとに { type, slide, element, ... } を返す (空配列 = 検査した範囲では問題なし)
   *   overflow : スライドの外にはみ出している (SVG 内の文字ラベルも対象)   … 許可: .allow-overflow
   *   clipped  : overflow:hidden などで中身が切れている
   *   overlap  : 文字同士が重なっている                                     … 許可: .allow-overlap
   *   contrast : 文字と背景のコントラスト比が 3:1 未満 (背景が単色の場合のみ) … 許可: .allow-low-contrast
   *   asset    : data-asset の画像が埋め込まれていない
   *   image    : 画像を読み込めない (壊れている・参照先がない)
   * 見た目の良し悪しまでは判定できないので、スクリーンショットでの確認と組み合わせる。
   */
  function audit(options) {
    var tol = (options && options.tolerance) || 2;
    document.body.classList.add('deck-auditing');
    var k = MODE === 'print' ? 1 : scale();
    var issues = [];
    var textOf = function (e) { return (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40); };

    slides.forEach(function (s, i) {
      var r = s.getBoundingClientRect();
      var texts = [];
      s.querySelectorAll('*').forEach(function (e) {
        if (e.closest('aside.notes')) return;
        var inSvg = !!e.closest('svg') && e.tagName.toLowerCase() !== 'svg';
        var isSvgText = inSvg && e.tagName.toLowerCase() === 'text';
        if (inSvg && !isSvgText) return;
        var cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.position === 'fixed' || cs.visibility === 'hidden') return;
        var b = e.getBoundingClientRect();
        if (!b.width && !b.height) return;

        // はみ出し
        if (!e.closest('.allow-overflow')) {
          var worst = Math.max((r.left - b.left) / k, (b.right - r.right) / k, (r.top - b.top) / k, (b.bottom - r.bottom) / k);
          if (worst > tol) issues.push({ type: 'overflow', slide: i + 1, element: describe(e), overflowPx: Math.round(worst), text: textOf(e) });
        }
        // 内部で切れている
        if (!inSvg && e !== s && cs.overflowX !== 'visible' && cs.overflowY !== 'visible' && !e.closest('.allow-overflow')) {
          var clipY = e.scrollHeight - e.clientHeight, clipX = e.scrollWidth - e.clientWidth;
          if (clipY > tol || clipX > tol) {
            issues.push({ type: 'clipped', slide: i + 1, element: describe(e), clippedPx: Math.max(clipX, clipY), direction: clipX > clipY ? 'horizontal' : 'vertical', text: textOf(e) });
          }
        }
        // 文字を持つ要素 (重なり・コントラストの対象)
        var rects = isSvgText ? [b] : ownTextRects(e);
        if (rects.length) {
          texts.push({ e: e, rects: rects });
          if (!inSvg && !e.closest('.allow-low-contrast')) {
            var ratio = contrastOf(e, cs);
            if (ratio != null && ratio < 3) issues.push({ type: 'contrast', slide: i + 1, element: describe(e), ratio: Math.round(ratio * 100) / 100, text: textOf(e) });
          }
        }
      });

      // 文字同士の重なり (親子関係にあるものは除く)
      for (var a = 0; a < texts.length; a++) {
        for (var c = a + 1; c < texts.length; c++) {
          var A = texts[a], B = texts[c];
          if (A.e.contains(B.e) || B.e.contains(A.e)) continue;
          if (A.e.closest('.allow-overlap') || B.e.closest('.allow-overlap')) continue;
          var hit = overlapRatio(A.rects, B.rects);
          if (hit > 0.2) {
            issues.push({ type: 'overlap', slide: i + 1, element: describe(A.e) + ' × ' + describe(B.e), overlap: Math.round(hit * 100) + '%', text: textOf(A.e) + ' × ' + textOf(B.e) });
          }
        }
      }

      // 画像
      s.querySelectorAll('img').forEach(function (img) {
        if (img.hasAttribute('data-asset') && !img.getAttribute('src')) return; // asset として報告済み
        if (!img.getAttribute('src') || (img.complete && !img.naturalWidth)) {
          issues.push({ type: 'image', slide: i + 1, element: describe(img), src: (img.getAttribute('src') || '(なし)').slice(0, 60) });
        }
      });
    });

    missingAssets.forEach(function (m) {
      var sec = m.el.closest('section.slide');
      issues.push({ type: 'asset', slide: sec ? slides.indexOf(sec) + 1 : 0, element: describe(m.el), asset: m.name });
    });
    document.body.classList.remove('deck-auditing');
    return issues;
  }

  /** 要素が直接持つ文字 (子要素の文字を除く) の表示範囲 */
  function ownTextRects(e) {
    var rects = [];
    Array.prototype.forEach.call(e.childNodes, function (n) {
      if (n.nodeType !== 3 || !n.textContent.trim()) return;
      var range = document.createRange();
      range.selectNodeContents(n);
      Array.prototype.forEach.call(range.getClientRects(), function (rc) { if (rc.width > 1 && rc.height > 1) rects.push(rc); });
    });
    return rects;
  }

  /** 2 つの矩形群の重なり (小さい方の面積に対する割合の最大値) */
  function overlapRatio(as, bs) {
    var best = 0;
    as.forEach(function (p) {
      bs.forEach(function (q) {
        var w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        var h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w <= 0 || h <= 0) return;
        var small = Math.min(p.width * p.height, q.width * q.height);
        if (small > 0) best = Math.max(best, (w * h) / small);
      });
    });
    return best;
  }

  function parseColor(str) {
    var m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function luminance(c) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function blend(top, bottom) {
    var a = top.a;
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
  }

  /** 文字色と、その下の背景色のコントラスト比。背景に画像・グラデーションがある場合は null (判定しない) */
  function contrastOf(e, cs) {
    var fg = parseColor(cs.color);
    if (!fg || fg.a === 0) return null;
    var layers = [];
    for (var n = e; n && n.nodeType === 1; n = n.parentElement) {
      var ns = n === e ? cs : getComputedStyle(n);
      if (ns.backgroundImage && ns.backgroundImage !== 'none') return null;
      var bg = parseColor(ns.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      if (n.classList && n.classList.contains('deck-stage')) break;
    }
    var base = { r: 255, g: 255, b: 255, a: 1 };
    for (var j = layers.length - 1; j >= 0; j--) base = blend(layers[j], base);
    var text = fg.a < 1 ? blend(fg, base) : fg;
    var l1 = luminance(text), l2 = luminance(base);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function describe(e) {
    var s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    if (e.classList.length) s += '.' + Array.prototype.join.call(e.classList, '.');
    return s;
  }

  // ------------------------------------------------------------------
  // 文字編集モード (E キー / ホストからの指示)
  //   編集できる要素は deck-edit.js のルールで決め、スライド番号 + 順番で特定する。
  //   ホスト (jh-editor など、親ウィンドウ) がいれば変更を postMessage で通知し、
  //   単体で開いている場合は Ctrl+S で File System Access API を使って保存する。
  //   通信の仕様: docs/edit-protocol.md
  // ------------------------------------------------------------------
  var EditLib = window.JhDeckEdit;
  var editTargets = [];  // [スライド][順番] = Element
  var edit = { on: false, hosted: false, pending: {}, dirty: false, badge: null, handle: null, timer: null };
  var HAS_PARENT = window.parent && window.parent !== window;

  /** スクリプト実行時点 (デッキ専用 JS が DOM を変える前) に、編集できる要素へ印を付ける */
  function tagEditables() {
    var d = document.querySelector('.deck');
    if (!EditLib || !d) return;
    var secs = d.querySelectorAll(':scope > section.slide');
    editTargets = Array.prototype.map.call(secs, function (sec, si) {
      return EditLib.editableElements(sec).map(function (e, i) {
        e.setAttribute('data-jh-edit', si + ':' + i);
        e._jhSource = EditLib.normText(e.textContent, false); // ソースと照合するための文字
        e._jhHtml = e.innerHTML;
        return e;
      });
    });
  }
  tagEditables();

  function postHost(msg) {
    if (!HAS_PARENT) return;
    msg.jhdeck = EditLib ? EditLib.PROTOCOL : 1;
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* noop */ }
  }

  var toastTimer = null;
  function toast(message) {
    var t = document.querySelector('.deck-toast') || document.body.appendChild(el('div', 'deck-toast'));
    t.textContent = message;
    t.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-show'); }, 3200);
  }

  function setEditMode(on, fromHost) {
    if (!EditLib || MODE !== 'main') return;
    edit.on = !!on;
    document.body.classList.toggle('deck-editing', edit.on);
    editTargets.forEach(function (list) {
      list.forEach(function (e) {
        if (edit.on) { e.setAttribute('contenteditable', 'true'); e.spellcheck = false; }
        else e.removeAttribute('contenteditable');
      });
    });
    if (edit.on && !edit.badge) {
      edit.badge = el('div', 'deck-edit-badge',
        '<b>✎ 編集モード</b>' +
        '<span class="deck-edit-hint">枠をクリックして編集 / Enter で確定 / Esc で取り消し</span>' +
        '<span class="deck-edit-state"></span>' +
        '<button type="button" class="deck-edit-btn" data-act="save" title="Ctrl+S">保存</button>' +
        '<button type="button" class="deck-edit-btn is-exit" data-act="exit" title="E / Esc">✕ 終了</button>');
      edit.badge.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); // 編集中の枠からフォーカスを奪わない
      edit.badge.addEventListener('click', function (ev) {
        var act = ev.target.closest && ev.target.closest('[data-act]');
        if (!act) return;
        var cur = document.activeElement;
        if (cur && cur.hasAttribute && cur.hasAttribute('data-jh-edit')) commit(cur);
        if (act.getAttribute('data-act') === 'save') save();
        else setEditMode(false);
      });
      document.body.appendChild(edit.badge);
    }
    if (edit.badge) {
      edit.badge.hidden = !edit.on;
      updateBadge();
    }
    if (!edit.on) {
      if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
      if (edit.dirty && !edit.hosted) toast('未保存の変更があります。Ctrl+S で保存できます');
    }
    if (!fromHost) postHost({ type: 'edit-mode', on: edit.on });
  }

  /** 編集バーの「未保存」表示を更新する */
  function updateBadge() {
    if (!edit.badge) return;
    var st = edit.badge.querySelector('.deck-edit-state');
    st.textContent = edit.hosted ? '' : (edit.dirty ? '● 未保存の変更あり' : '');
    edit.badge.querySelector('[data-act="save"]').hidden = !edit.hosted && !edit.dirty;
  }

  /** ダブルクリックした枠を編集モードで開き、クリック位置にカーソルを置く */
  function editAt(target, x, y) {
    if (!edit.on) setEditMode(true);
    target.focus();
    var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (range && target.contains(range.startContainer)) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /** 送信用の HTML (プレビュー側で付いたクラスなどを除く) */
  function cleanHtml(e) {
    var c = e.cloneNode(true);
    c.querySelectorAll('.visible, .current').forEach(function (x) {
      x.classList.remove('visible', 'current');
      if (!x.getAttribute('class')) x.removeAttribute('class');
    });
    c.querySelectorAll('[style*="--i"]').forEach(function (x) {
      var s = x.getAttribute('style').replace(/--i\s*:\s*\d+;?\s*/g, '').trim();
      if (s) x.setAttribute('style', s); else x.removeAttribute('style');
    });
    return EditLib.sanitize(c.innerHTML);
  }

  function commit(e) {
    var key = e.getAttribute('data-jh-edit');
    if (!key) return;
    var html = cleanHtml(e);
    if (html === EditLib.sanitize(e._jhHtml)) return; // 変更なし
    var p = key.split(':');
    var change = { slide: Number(p[0]), index: Number(p[1]), html: html, before: e._jhSource };
    if (edit.hosted) {
      postHost({ type: 'change', slide: change.slide, index: change.index, html: html, before: change.before, text: EditLib.normText(e.textContent, false), protocol: EditLib.PROTOCOL });
      // ホストのソースはこの内容に更新される前提で、照合用の文字を進める
      e._jhSource = EditLib.normText(e.textContent, false);
      e._jhHtml = e.innerHTML;
    } else {
      // 単体: 保存時にまとめて反映する (before は保存済みファイルの内容)
      var prev = edit.pending[key];
      change.before = prev ? prev.before : e._jhSource;
      edit.pending[key] = change;
      edit.dirty = true;
      e._jhHtml = e.innerHTML;
      updateBadge();
    }
  }

  function bindEditEvents() {
    // ダブルクリックで、その枠をすぐ編集できる (編集モードでなくても)
    document.addEventListener('dblclick', function (ev) {
      if (edit.on && ev.target.closest && ev.target.closest('[contenteditable="true"]')) return; // 編集中は通常の単語選択
      var t = ev.target.closest && ev.target.closest('[data-jh-edit]');
      if (!t || !t.closest('.slide.active')) return;
      ev.preventDefault();
      editAt(t, ev.clientX, ev.clientY);
    });
    document.addEventListener('focusin', function (ev) {
      if (edit.on && ev.target.hasAttribute && ev.target.hasAttribute('data-jh-edit')) ev.target._jhFocusHtml = ev.target.innerHTML;
    });
    document.addEventListener('focusout', function (ev) {
      if (edit.on && ev.target.hasAttribute && ev.target.hasAttribute('data-jh-edit')) commit(ev.target);
    });
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!edit.on || !t.hasAttribute || !t.hasAttribute('data-jh-edit')) return;
      clearTimeout(edit.timer);
      edit.timer = setTimeout(function () { commit(t); }, 600); // 入力が止まったら反映
    });
    document.addEventListener('keydown', function (ev) {
      var t = ev.target;
      var inEdit = edit.on && t.hasAttribute && t.hasAttribute('data-jh-edit');
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        // 編集していなくても、ブラウザ標準の保存 (表示中の状態を書き出してデッキを壊す) は常に止める
        ev.preventDefault();
        if (inEdit) commit(t);
        save();
        return;
      }
      if (!inEdit) return;
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); t.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); clearTimeout(edit.timer); t.innerHTML = t._jhFocusHtml; commit(t); t.blur(); }
      ev.stopPropagation();
    }, true);
    // 貼り付けは書式を捨てて文字だけ
    document.addEventListener('paste', function (ev) {
      if (!edit.on || !ev.target.closest || !ev.target.closest('[data-jh-edit]')) return;
      ev.preventDefault();
      var txt = (ev.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, txt);
    });
    window.addEventListener('beforeunload', function (ev) {
      if (!edit.hosted && edit.dirty) { ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  /**
   * 保存 (Ctrl+S)。ブラウザ標準の「名前を付けて保存」は表示中の状態を書き出してデッキを壊すので使わせない。
   *   1. ホスト (jh-editor) の中 → ホストに保存を依頼
   *   2. ローカルサーバー経由 (MCP の open_deck / npm run dev) → サーバーが元のファイルに直接書き込む
   *   3. file:// で直接開いた → このファイルを選んでもらい書き込む (選んだファイルは記憶し、次回から選び直し不要)
   */
  function save() {
    if (edit.hosted) { postHost({ type: 'save' }); return; }
    if (!edit.dirty) { setEditMode(false); toast('変更はありません'); return; }
    if (window.__JH_SAVE__) saveToServer(); else saveStandalone();
  }

  function markSaved() {
    Object.keys(edit.pending).forEach(function (k) {
      var e = document.querySelector('[data-jh-edit="' + k + '"]');
      if (e) e._jhSource = EditLib.normText(e.textContent, false);
    });
    edit.pending = {};
    edit.dirty = false;
    updateBadge();
  }

  async function saveToServer() {
    var cfg = window.__JH_SAVE__;
    var changes = Object.keys(edit.pending).map(function (k) { return edit.pending[k]; });
    try {
      var res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-JH-Token': cfg.token },
        body: JSON.stringify({ file: cfg.file, protocol: EditLib.PROTOCOL, changes: changes }),
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
      markSaved();
      setEditMode(false); // 保存できたら編集モードを終える
      toast('保存しました: ' + (body.path || cfg.file));
    } catch (e) {
      if (e instanceof TypeError) { // サーバーに届かない (停止している) → ファイルを選んで保存
        toast('サーバーに接続できないため、ファイルを選んで保存します');
        saveStandalone();
        return;
      }
      toast('保存できませんでした: ' + (e.message || e));
    }
  }

  /** 選んだファイルのハンドルを記憶する (IndexedDB。ファイルのパスごと) */
  function handleStore(op, key, value) {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open('jh-deck', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('handles'); };
        req.onerror = function () { resolve(null); };
        req.onsuccess = function () {
          var st = req.result.transaction('handles', op === 'get' ? 'readonly' : 'readwrite').objectStore('handles');
          var q = op === 'get' ? st.get(key) : st.put(value, key);
          q.onsuccess = function () { resolve(op === 'get' ? q.result : true); };
          q.onerror = function () { resolve(null); };
        };
      } catch (e) { resolve(null); }
    });
  }

  /** 単体 (file://) で開いている場合の保存: このファイル自体を選んでもらい、編集箇所だけを書き換える */
  async function saveStandalone() {
    if (!window.showOpenFilePicker) { toast('このブラウザでは保存できません (Chrome / Edge で開いてください)'); return; }
    var fileKey = 'file:' + decodeURIComponent(location.pathname);
    var fileName = decodeURIComponent(location.pathname.split('/').pop() || '');
    try {
      if (!edit.handle) edit.handle = await handleStore('get', fileKey);
      if (!edit.handle) {
        toast('保存先として、このファイル (' + fileName + ') を選んでください。次回からは選び直し不要です');
        var opts = { multiple: false, id: 'jh-deck', types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }] };
        var last = await handleStore('get', 'last');
        if (last) opts.startIn = last; // 前回選んだファイルのフォルダから開く
        var picked = await window.showOpenFilePicker(opts);
        edit.handle = picked[0];
        if (fileName && edit.handle.name !== fileName &&
          !window.confirm('選んだファイル (' + edit.handle.name + ') は、表示中のファイル (' + fileName + ') と名前が違います。保存しますか？')) { edit.handle = null; return; }
      }
      if ((await edit.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') { toast('書き込みが許可されませんでした'); return; }
      var src = await (await edit.handle.getFile()).text();
      if (!EditLib.isDeck(src)) throw new Error('選んだファイルはデッキではありません');
      var title = (src.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
      if (title && EditLib.normText(title, true) !== EditLib.normText(document.title, false) &&
        !window.confirm('選んだファイルのタイトルが、表示中のデッキと違います。保存しますか？')) { edit.handle = null; return; }
      Object.keys(edit.pending).forEach(function (k) { src = EditLib.applyEdit(src, edit.pending[k]).source; });
      var w = await edit.handle.createWritable();
      await w.write(src);
      await w.close();
      handleStore('put', fileKey, edit.handle);
      handleStore('put', 'last', edit.handle);
      markSaved();
      setEditMode(false);
      toast('保存しました: ' + edit.handle.name);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      edit.handle = null;
      toast('保存できませんでした: ' + (e.message || e));
    }
  }

  // ホストが発表 (全画面) 表示にしているか。そのときの Esc は発表の終了をホストに頼む
  var hostPresenting = false;

  /**
   * エディタ (ホスト) の iframe の中で動いているときのキー操作。
   *   - F5 / Ctrl+R: ブラウザの再読み込みは止める (iframe の中で押すと、エディタ全体が読み込み直されるため)。
   *     ホストがあれば F5 は「発表」としてホストに渡す
   *   - Ctrl+Z / Ctrl+Y: 枠の編集中でなければ、ホストの元に戻す / やり直す
   */
  function onHostedKey(ev) {
    if (!HAS_PARENT) return;
    var k = ev.key;
    var mod = ev.ctrlKey || ev.metaKey;
    if (k === 'F5' || (mod && (k === 'r' || k === 'R'))) {
      ev.preventDefault();
      if (edit.hosted && k === 'F5') postHost({ type: 'present' });
      return;
    }
    if (!edit.hosted || !mod || isTyping(ev.target)) return;
    if (k === 'z' || k === 'Z') { ev.preventDefault(); postHost({ type: ev.shiftKey ? 'redo' : 'undo' }); }
    else if (k === 'y' || k === 'Y') { ev.preventDefault(); postHost({ type: 'redo' }); }
  }

  /** ホスト (親ウィンドウ) からのメッセージ */
  function onHostMessage(ev) {
    var d = ev.data;
    if (!d || !d.jhdeck || ev.source !== window.parent) return;
    edit.hosted = true;
    if (d.type === 'edit') setEditMode(d.on, true);
    else if (d.type === 'goto') go(d.index || 0, d.step == null ? 0 : d.step, true);
    else if (d.type === 'error') toast(d.message || 'エディタ側で反映できませんでした');
    else if (d.type === 'saved') { if (edit.on) setEditMode(false); toast('保存しました'); }
    else if (d.type === 'present') hostPresenting = !!d.on;
  }

  // ------------------------------------------------------------------
  // 埋め込み画像: <img data-asset="logo.png"> → jh-assets の data URI を設定
  // ------------------------------------------------------------------
  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent || 'null'); } catch (e) { console.error('[deck] ' + id + ' を読めません', e); return null; }
  }

  var missingAssets = [];
  function resolveAssets() {
    var assets = readJson('jh-assets') || {};
    document.querySelectorAll('[data-asset]').forEach(function (e) {
      var uri = assets[e.getAttribute('data-asset')];
      if (!uri) {
        missingAssets.push({ el: e, name: e.getAttribute('data-asset') });
        console.warn('[deck] asset が見つかりません: ' + e.getAttribute('data-asset'));
        return;
      }
      if (e.tagName.toLowerCase() === 'image') e.setAttribute('href', uri);
      else if (/^(IMG|SOURCE|VIDEO|AUDIO|IFRAME)$/.test(e.tagName)) e.setAttribute('src', uri);
      else e.style.backgroundImage = 'url("' + uri + '")';
    });
  }

  // ------------------------------------------------------------------
  // ブランド枠 (名前・ロゴ): <div class="deck" data-brand="header|footer|both">
  //   表紙・結び (.no-chrome) とセクション扉では帯を隠し、表紙・結びには小さなロゴを出す
  // ------------------------------------------------------------------
  var brand = null;
  function buildBrand() {
    var pos = deckEl.getAttribute('data-brand') || 'none';
    var data = readJson('jh-brand');
    if (pos === 'none' || !data || !(data.name || data.logo || data.label)) return null;
    function make(kind) {
      var bar = el('div', 'deck-brand deck-brand-' + kind);
      var id = el('div', 'deck-brand-id');
      if (data.logo) { var img = el('img', 'deck-brand-logo'); img.src = data.logo; img.alt = ''; id.appendChild(img); }
      if (data.name) id.appendChild(el('span', 'deck-brand-name', '')).textContent = data.name;
      bar.appendChild(id);
      if (data.label && kind !== 'cover') bar.appendChild(el('span', 'deck-brand-label', '')).textContent = data.label;
      return bar;
    }
    var parts = [];
    if (pos === 'header' || pos === 'both') parts.push(make('header'));
    if (pos === 'footer' || pos === 'both') parts.push(make('footer'));
    parts.push(make('cover'));
    return { pos: pos, parts: parts };
  }

  function brandState(slide) {
    var layout = Array.prototype.filter.call(slide.classList, function (c) { return c.indexOf('layout-') === 0; })[0];
    var on = ' on-' + (layout || 'default'); // テーマが背景色に合わせて色を変えられるように
    if (slide.classList.contains('no-chrome')) return 'is-cover' + on;
    if (slide.classList.contains('layout-section')) return 'is-plain' + on;
    return 'is-normal' + on;
  }

  // ------------------------------------------------------------------
  // 初期化
  // ------------------------------------------------------------------
  function init() {
    deckEl = document.querySelector('.deck');
    if (!deckEl) { console.error('[deck] .deck が見つかりません'); return; }
    resolveAssets();
    brand = buildBrand();

    // .deck 直下の section.slide を stage に移す
    stage = el('div', 'deck-stage');
    // ブラウザの「名前を付けて保存」で表示中の状態のまま保存されたファイル: 表示はできるようにしつつ警告する
    var savedStage = deckEl.querySelector(':scope > .deck-stage');
    if (savedStage) {
      savedStage.querySelectorAll(':scope > section.slide').forEach(function (s) { deckEl.insertBefore(s, savedStage); });
      savedStage.remove();
      document.body.appendChild(el('div', 'deck-broken-banner',
        'このファイルはブラウザの「名前を付けて保存」で保存されたため、正しく動かない可能性があります。' +
        'AI に「このデッキを repair_deck で直して」と頼むか、<code>npm run repair -- ファイル名</code> で復旧できます。'));
    }
    slides = Array.prototype.slice.call(deckEl.querySelectorAll(':scope > section.slide'));
    var defaultTransition = deckEl.getAttribute('data-transition') || 'fade';
    slides.forEach(function (s, i) {
      s._steps = computeSteps(s);
      s.dataset.index = String(i + 1);
      if (!s.hasAttribute('data-transition')) s.setAttribute('data-transition', defaultTransition);
      stage.appendChild(s);
    });
    deckEl.appendChild(stage);
    document.body.classList.add('deck-mode-' + MODE);

    if (MODE === 'print') {
      setupPrint();
      document.documentElement.classList.add('deck-ready');
      return;
    }

    if (brand) {
      chrome.brand = el('div', 'deck-brand-holder brand-' + brand.pos);
      brand.parts.forEach(function (p) { chrome.brand.appendChild(p); });
      stage.appendChild(chrome.brand);
    }
    if (MODE === 'main') {
      chrome.progress = el('div', 'deck-progress');
      chrome.pageno = el('div', 'deck-pageno');
      stage.appendChild(chrome.progress);
      stage.appendChild(chrome.pageno);
    }

    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('message', onMessage);

    if (MODE === 'presenter') buildPresenter();
    setupAutoFullscreen();
    if (MODE === 'main') {
      bindEditEvents();
      window.addEventListener('message', onHostMessage);
    }
    if (MODE !== 'embed') {
      document.addEventListener('keydown', onKey);
      document.addEventListener('keydown', onHostedKey, true);
      // 最初のクリックで全画面 (発表モード)。デモのボタン・リンク・編集中の枠のクリックは除く
      document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (t.closest && t.closest('button, a[href], input, select, textarea, [contenteditable="true"], .deck-edit-badge, .deck-overview, .deck-help')) return;
        maybeAutoFullscreen();
      });
      bindTouch();
    }
    window.addEventListener('hashchange', function () {
      var h = parseHash();
      if (h) go(h.index, h.step);
    });

    var h = parseHash();
    go(h ? h.index : 0, h ? h.step : 0, MODE === 'main');
    document.documentElement.classList.add('deck-ready');
    if (MODE === 'main') {
      postHost({
        type: 'ready',
        version: (document.querySelector('meta[name="generator"]') || {}).content || '',
        title: document.title,
        slides: slides.length,
        editables: editTargets.map(function (l) { return l.length; }),
        index: state.index,
        step: state.step,
      });
    }
  }

  // deck.js などで onSlide を登録してから初期化されるよう DOMContentLoaded を待つ
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
})();
