/* ============================================================
   terminal.js — 终端内核：开机自检、输入行、历史、补全、指令派发
   ============================================================ */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var crt = $('crt'), screenEl = $('screen'), outEl = $('output');
  var entrybar = $('entrybar'), entrytag = $('entrytag'), promptEl = $('prompt');
  var beforeEl = $('before'), cursorEl = $('cursor'), afterEl = $('after');
  var kbd = $('kbd');

  var esc = global.escHtml || function (s) { return String(s); };
  var Commands = global.Commands;

  /* ---------------- 状态 ---------------- */
  var state = {
    cwd: [],
    history: [],
    histIdx: -1,
    draft: '',
    bootAt: Date.now(),
    cmdCount: 0,
    theme: 'green',
    sound: false,
    busy: false,
    locked: false,
    booted: false,
    kbdHidden: false,   // 触屏上用户主动收起键盘后，不要再自动弹回来
    fails: 0
  };

  var skipBoot = false;

  /* ---------------- 显示宽度（CJK 占 2 列） ---------------- */
  var dispWidth = global.Util.dispWidth;
  var padTo = global.Util.padTo;

  /* ---------------- 触屏 / 视口 ---------------- */
  var IS_TOUCH = false;
  try {
    IS_TOUCH = global.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch (e) { /* 老浏览器：当作桌面处理 */ }

  /** 输出区当前能排下多少个等宽字符（等宽字体近似 0.6em 一列） */
  function columns() {
    var cs = global.getComputedStyle ? getComputedStyle(screenEl) : null;
    var fs = cs ? parseFloat(cs.fontSize) : 13;
    var pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 24;
    var w = Math.max(120, screenEl.clientWidth - pad);
    return Math.max(20, Math.floor(w / ((fs || 13) * 0.6)));
  }
  function narrow() { return columns() < 52; }

  /* ---------------- 输出 ---------------- */
  function addLine() {
    var el = document.createElement('div');
    el.className = 'line';
    outEl.appendChild(el);
    // 控制 DOM 规模
    while (outEl.childNodes.length > 800) outEl.removeChild(outEl.firstChild);
    return el;
  }
  /* 只有停在底部时才自动跟随输出：手机上往上翻阅读旧记录时不会被拽回去 */
  var stick = true;
  screenEl.addEventListener('scroll', function () {
    stick = screenEl.scrollHeight - screenEl.scrollTop - screenEl.clientHeight < 56;
  });
  function scroll() { if (stick) screenEl.scrollTop = screenEl.scrollHeight; }

  function out(html, cls) {
    var el = addLine();
    el.innerHTML = html === '' ? '&nbsp;' : html;
    if (cls) el.classList.add(cls);
    scroll();
    return el;
  }
  function print(text, cls, raw) { return out(raw ? text : esc(text), cls); }
  function printHtml(html, cls) { return out(html, cls); }
  function blank() { return out(''); }

  function kv(pairs) {
    var w = 0;
    pairs.forEach(function (p) { w = Math.max(w, dispWidth(p[0])); });
    pairs.forEach(function (p) {
      out('  <span class="dim">' + padTo(esc(p[0]), w) + '</span>  ' +
          '<span class="accent">' + esc(p[1]) + '</span>');
    });
  }

  function table(head, rows, colClasses, linkCol) {
    if (narrow()) { tableNarrow(head, rows, colClasses, linkCol); return; }
    var cols = head.length, widths = [];
    head.forEach(function (h, i) { widths[i] = dispWidth(h); });
    rows.forEach(function (r) {
      for (var i = 0; i < cols; i++) widths[i] = Math.max(widths[i], dispWidth(String(r[i])));
    });
    function render(cells, cls) {
      var s = '';
      for (var i = 0; i < cols; i++) {
        var text = esc(String(cells[i]));
        var c = cls || (colClasses && colClasses[i]) || null;
        if (i === linkCol) c = 'link';
        s += (c ? '<span class="' + c + '">' + text + '</span>' : text) +
             ' '.repeat(widths[i] - dispWidth(String(cells[i])) + 2);
      }
      return s;
    }
    out(render(head, 'banner'));
    rows.forEach(function (r) { out(render(r)); });
  }

  /* 窄屏表格：不做列对齐（对齐会被折行打乱），单元格之间用 · 平铺 */
  function tableNarrow(head, rows, colClasses, linkCol) {
    function line(cells, cls) {
      var parts = [];
      for (var i = 0; i < cells.length; i++) {
        var c = cls || (colClasses && colClasses[i]) || null;
        if (i === linkCol) c = 'link';
        var text = esc(String(cells[i]));
        parts.push(c ? '<span class="' + c + '">' + text + '</span>' : text);
      }
      return parts.join('<span class="dim"> · </span>');
    }
    out(line(head, 'banner'));
    rows.forEach(function (r) { out(line(r)); });
  }

  /* 打字机效果 */
  function type(text, cls, speed) {
    speed = speed || 9;
    var el = addLine();
    if (cls) el.classList.add(cls);
    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        if (skipBoot) { el.textContent = text; scroll(); resolve(el); return; }
        el.textContent += text.charAt(i++);
        scroll();
        if (i < text.length) setTimeout(step, speed);
        else resolve(el);
      }
      step();
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* 进度条 */
  function progress(label, ms) {
    var el = addLine();
    var start = Date.now();
    return new Promise(function (resolve) {
      var id = setInterval(function () {
        var t = Math.min(1, (Date.now() - start) / ms);
        var filled = Math.round(t * 14);
        el.innerHTML = esc(label) + '  <span class="dim">[</span>' +
          '<span class="accent">' + '█'.repeat(filled) + '</span>' +
          '<span class="dim">' + '░'.repeat(14 - filled) + ']</span>';
        scroll();
        if (t >= 1) {
          clearInterval(id);
          el.innerHTML = esc(label) + '  <span class="ok">[ 完成 ]</span>';
          scroll();
          resolve();
        }
      }, 55);
    });
  }

  /* ---------------- 音效 ---------------- */
  var actx = null;
  function blip(freq, dur, vol) {
    if (!state.sound) return;
    try {
      actx = actx || new (global.AudioContext || global.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square';
      o.frequency.value = freq || 660;
      g.gain.value = (vol == null ? 0.02 : vol);
      o.connect(g); g.connect(actx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (dur || 0.04));
      o.stop(actx.currentTime + (dur || 0.04));
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 提示符 ---------------- */
  function level() { var s = Auth.current(); return s ? s.clearance : 1; }

  function promptHtml() {
    var s = Auth.current();
    var user = s ? s.user : 'visitor';
    var path = FS.pathOf(state.cwd);
    return '<span class="user">' + esc(user) + '</span>' +
           '<span class="dim at">@</span><span class="host">scp-node07</span>' +
           '<span class="dim sep">:</span><span class="path">' + esc(path) + '</span>' +
           '<span class="dim">' + (s ? '$' : '>') + '</span>';
  }
  function refresh() {
    promptEl.innerHTML = promptHtml();
    var s = Auth.current();
    entrytag.textContent = s ? 'L' + s.clearance + ' ' + s.user.toUpperCase() : '未登录';
    updateQuickbar(s);
  }

  /* ---------------- 快捷指令条（触屏 / 窄屏可见） ---------------- */
  var quickbar = $('quickbar'), qcmds = $('qcmds'), qkeys = $('qkeys');
  var QC_BUILT = false, themeChip = null;

  var THEME_CYCLE = ['green', 'amber', 'ice', 'mono'];

  var QC = [
    { label: 'help',   cmd: 'help' },
    { label: 'ls',     cmd: 'ls' },
    { label: 'ls -l',  cmd: 'ls -l' },
    { label: 'readme', cmd: 'cat readme.txt' },
    { label: '登录',   cmd: 'login admin admin123', guest: true },
    { label: '登出',   cmd: 'logout', auth: true },
    { label: 'whoami', cmd: 'whoami' },
    { label: 'users',  cmd: 'users' },
    { label: 'theme',  act: 'theme' },
    { label: 'clear',  cmd: 'clear' }
  ];
  var QK = [
    { label: '↑', act: 'prev', title: '上一条指令' },
    { label: '⇥', act: 'tab',  title: '补全指令或路径' },
    { label: '⌨', act: 'kbd',  title: '显示 / 收起键盘' },
    { label: '↵', act: 'run',  title: '执行当前指令' }
  ];

  function buildQuickbar() {
    if (QC_BUILT) return;
    QC.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qchip';
      b.textContent = c.label;
      b.setAttribute('data-q', String(i));
      if (c.act === 'theme') themeChip = b;
      qcmds.appendChild(b);
    });
    QK.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qchip qkey';
      b.textContent = k.label;
      b.title = k.title;
      b.setAttribute('aria-label', k.title);
      b.setAttribute('data-k', k.act);
      qkeys.appendChild(b);
    });
    quickbar.addEventListener('pointerdown', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      // 触屏：阻止默认行为，别把焦点从输入框抢走（否则软键盘会收起再弹起）
      if (e.pointerType && e.pointerType !== 'mouse') e.preventDefault();
      b.classList.add('pressed');
      setTimeout(function () { b.classList.remove('pressed'); }, 140);
    });
    quickbar.addEventListener('click', onQuickClick);
    qcmds.addEventListener('scroll', syncChipFade);
    QC_BUILT = true;
  }

  function onQuickClick(e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b || !quickbar.contains(b)) return;
    if (state.busy || state.locked) return;
    if (b.hasAttribute('data-k')) { quickKey(b.getAttribute('data-k')); return; }
    var c = QC[+b.getAttribute('data-q')];
    if (!c) return;
    blip(660, 0.04);
    if (c.act === 'theme') { quickRun('theme ' + nextTheme()); return; }
    quickRun(c.cmd);
  }

  function nextTheme() {
    var i = THEME_CYCLE.indexOf(state.theme);
    return THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
  }

  function quickRun(cmd) {
    if (!cmd) return;
    stick = true;
    submit(cmd);          // 与手动回车走同一条路径（回显、历史、繁忙状态都一致）
  }

  function quickKey(act) {
    blip(820, 0.03);
    if (act === 'prev') {
      if (!state.history.length) { print('（还没有历史指令）', 'dim'); return; }
      focusInput(true);
      historyPrev();
      return;
    }
    if (act === 'tab') { focusInput(true); complete(); return; }
    if (act === 'run') {
      var v = kbd.value;
      if (!v.trim()) return;
      focusInput(true);
      stick = true;
      submit(v);
      return;
    }
    if (act === 'kbd') { toggleKbd(); return; }
  }

  function toggleKbd() {
    if (document.activeElement === kbd) {
      state.kbdHidden = true;
      kbd.blur();
    } else {
      state.kbdHidden = false;
      focusInput(true);
    }
    syncKbdChip();
  }

  /* 快捷指令横向滑动时，滚到最右就把右侧渐隐去掉 */
  function syncChipFade() {
    var atEnd = qcmds.scrollLeft + qcmds.clientWidth >= qcmds.scrollWidth - 2;
    qcmds.classList.toggle('at-end', atEnd);
  }

  function syncKbdChip() {
    var b = qkeys.querySelector('[data-k="kbd"]');
    if (b) b.classList.toggle('on', document.activeElement === kbd);
  }

  function updateQuickbar(s) {
    buildQuickbar();
    quickbar.hidden = !state.booted || state.locked;
    [].forEach.call(qcmds.children, function (b) {
      var c = QC[+b.getAttribute('data-q')];
      if (!c) return;
      b.hidden = (c.guest && !!s) || (c.auth && !s);
    });
    if (themeChip) themeChip.title = '切换荧光配色（下一套：' + nextTheme() + '）';
    syncKbdChip();
    syncChipFade();
  }

  /* ---------------- 输入行渲染 ---------------- */
  var SENSITIVE = { login: 1, signin: 1, register: 1, passwd: 1 };

  function maskBuffer(raw) {
    var m = /^(\s*)(\S+)(\s+)([\s\S]*)$/.exec(raw);
    if (!m) return raw;
    var cmd = m[2].toLowerCase();
    if (!SENSITIVE[cmd]) return raw;
    if (cmd === 'login' || cmd === 'signin' || cmd === 'register') {
      var k = /^(\S+)(\s*)([\s\S]*)$/.exec(m[4]);
      if (k) return m[1] + m[2] + m[3] + k[1] + k[2] + '*'.repeat(k[3].length);
    }
    return m[1] + m[2] + m[3] + '*'.repeat(m[4].length);
  }

  function render() {
    var raw = kbd.value;
    var caret = kbd.selectionStart == null ? raw.length : kbd.selectionStart;
    var shown = maskBuffer(raw);
    caret = Math.min(caret, shown.length);
    beforeEl.textContent = shown.slice(0, caret);
    var ch = shown.charAt(caret);
    if (ch === '' || ch === ' ') {
      cursorEl.textContent = ch === '' ? ' ' : ' ';
      cursorEl.classList.add('space');
    } else {
      cursorEl.textContent = ch;
      cursorEl.classList.remove('space');
    }
    afterEl.textContent = shown.slice(caret + 1);
    scroll();
  }

  function setBusy(b) {
    var wasFocused = document.activeElement === kbd;
    state.busy = b;
    entrybar.hidden = state.locked;
    entrybar.classList.toggle('dimmed', b || state.locked);
    quickbar.classList.toggle('dimmed', b || state.locked);
    cursorEl.classList.toggle('busy', b);
    // 用 readOnly 而不是 disabled：不会夺走焦点，手机上软键盘不会一开一合
    kbd.readOnly = b;
    if (!b) {
      render();
      if (!IS_TOUCH || wasFocused) focusInput();
    }
    syncKbdChip();
  }

  function focusInput(force) {
    if (state.locked) return;
    if (IS_TOUCH && state.kbdHidden && !force) return;   // 用户主动收起过键盘
    try { kbd.focus({ preventScroll: true }); } catch (e) { kbd.focus(); }
  }

  /* ---------------- 词法分析 ---------------- */
  function tokenize(str) {
    var out = [], cur = '', quote = null, has = false;
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (quote) {
        if (c === quote) quote = null; else cur += c;
      } else if (c === '"' || c === "'") {
        quote = c; has = true;
      } else if (/\s/.test(c)) {
        if (cur || has) { out.push(cur); cur = ''; has = false; }
      } else cur += c;
    }
    if (cur || has) out.push(cur);
    return out;
  }

  /* ---------------- Tab 补全 ---------------- */
  function complete() {
    var raw = kbd.value;
    var head = raw.slice(0, kbd.selectionStart == null ? raw.length : kbd.selectionStart);
    var m = /(\S*)$/.exec(head);
    var word = m ? m[1] : '';
    var isFirst = /^\s*\S*$/.test(head);
    var pool = [];

    if (isFirst) {
      pool = Object.keys(Commands).sort();
    } else {
      var parts = head.trim().split(/\s+/);
      var cmdName = parts[0].toLowerCase();
      if (cmdName === 'cd' || cmdName === 'ls' || cmdName === 'cat' || cmdName === 'dir') {
        var partial = word;
        var slash = partial.lastIndexOf('/');
        var dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
        var base = slash >= 0 ? partial.slice(slash + 1) : partial;
        var segs = FS.resolve(state.cwd, dirPart || '.');
        pool = FS.names(segs, level()).filter(function (n) {
          return n.indexOf(base) === 0;
        }).map(function (n) { return dirPart + n; });
      }
    }

    var hits = pool.filter(function (c) { return c.indexOf(word) === 0; });
    if (!hits.length) { blip(220, 0.05); return; }

    if (hits.length === 1) {
      var add = hits[0].slice(word.length);
      var isDir = /\/$/.test(hits[0]);
      insert(add + (isDir ? '' : ' '));
      blip(880, 0.03);
    } else {
      // 公共前缀
      var prefix = hits[0];
      hits.forEach(function (h) {
        var i = 0;
        while (i < prefix.length && i < h.length && prefix[i] === h[i]) i++;
        prefix = prefix.slice(0, i);
      });
      if (prefix.length > word.length) insert(prefix.slice(word.length));
      printHtml('<span class="dim">' + hits.map(esc).join('   ') + '</span>');
      refresh();
    }
  }

  function insert(text) {
    var v = kbd.value;
    var p = kbd.selectionStart == null ? v.length : kbd.selectionStart;
    kbd.value = v.slice(0, p) + text + v.slice(p);
    var np = p + text.length;
    kbd.setSelectionRange(np, np);
    render();
  }

  /* ---------------- 历史 ---------------- */
  function historyPrev() {
    if (!state.history.length) return;
    if (state.histIdx === -1) state.draft = kbd.value;
    state.histIdx = Math.min(state.history.length - 1, state.histIdx + 1);
    kbd.value = state.history[state.history.length - 1 - state.histIdx];
    toEnd();
  }
  function historyNext() {
    if (state.histIdx <= -1) return;
    state.histIdx--;
    kbd.value = state.histIdx === -1 ? state.draft
              : state.history[state.history.length - 1 - state.histIdx];
    toEnd();
  }
  function toEnd() {
    var n = kbd.value.length;
    kbd.setSelectionRange(n, n);
    render();
  }

  /* ---------------- 指令派发 ---------------- */
  var ctx = {
    state: state,
    print: print,
    html: printHtml,
    dim: function (t) { print(t, 'dim'); },
    ok: function (t) { print(t, 'ok'); },
    warn: function (t) { print(t, 'warn'); },
    err: function (t) { print(t, 'err'); },
    banner: function (t) { print(t, 'banner'); },
    blank: blank,
    type: type,
    kv: kv,
    table: table,
    progress: progress,
    esc: esc,
    clear: function () { outEl.innerHTML = ''; },
    level: level,
    narrow: narrow,
    columns: columns,
    touch: IS_TOUCH,
    session: function () { return Auth.current(); },
    refresh: refresh,
    setTheme: setTheme,
    setSound: function (on) {
      state.sound = on;
      try { localStorage.setItem('scp.sound', on ? '1' : '0'); } catch (e) {}
      if (on) blip(740, 0.05);
    },
    lock: function () {
      state.locked = true;
      entrybar.hidden = true;
      quickbar.hidden = true;
      return new Promise(function (resolve) {
        function again(e) {
          if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
          document.removeEventListener('keydown', again);
          screenEl.removeEventListener('pointerdown', again);
          state.locked = false;
          state.cwd = [];
          resolve();
          boot();
        }
        setTimeout(function () {
          document.addEventListener('keydown', again);
          screenEl.addEventListener('pointerdown', again);
        }, 300);
      });
    },
    beep: blip
  };

  function echoLine(raw) {
    out('<span class="e-prompt">' + promptHtml() + '</span> ' +
        '<span class="e-cmd">' + esc(maskBuffer(raw)) + '</span>', 'echo');
  }

  function nearest(name) {
    var best = null, bestD = 99;
    Object.keys(Commands).forEach(function (k) {
      var d = editDist(name, k);
      if (d < bestD) { bestD = d; best = k; }
    });
    return bestD <= 3 ? best : null;
  }
  function editDist(a, b) {
    var m = a.length, n = b.length, prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur.slice();
    }
    return prev[n];
  }

  function submit(raw) {
    var line = raw.replace(/\s+$/, '');
    stick = true;                 // 主动执行指令时回到“跟随输出”模式
    echoLine(raw);
    if (line.trim()) {
      state.history.push(maskBuffer(line));
      if (state.history.length > 200) state.history.shift();
      state.cmdCount++;
    }
    state.histIdx = -1;
    kbd.value = '';
    render();

    var tokens = tokenize(line);
    if (!tokens.length) return Promise.resolve();

    var name = tokens[0].toLowerCase();
    var cmd = Commands[name];
    if (!cmd) {
      ctx.err('sh: 未知指令：' + esc(tokens[0]));
      var guess = nearest(name);
      if (guess) ctx.dim('你是不是想输入 “' + guess + '”？输入 help 查看全部指令。');
      else ctx.dim('输入 help 查看可用指令。');
      return Promise.resolve();
    }

    if (cmd.minLevel && level() < cmd.minLevel) {
      ctx.err(esc(name) + ': 权限不足（需要 L' + cmd.minLevel + '，当前 L' + level() + '）');
      if (!Auth.current()) ctx.dim('请先登录：login <用户名> <口令>');
      return Promise.resolve();
    }

    setBusy(true);
    return Promise.resolve()
      .then(function () { return cmd.run(tokens.slice(1), ctx); })
      .catch(function (err) {
        ctx.err('内部错误：' + (err && err.message ? err.message : String(err)));
      })
      .then(function () { setBusy(false); refresh(); });
  }

  /* ---------------- 键盘 ---------------- */
  kbd.addEventListener('input', function () { render(); blip(1200 + Math.random() * 300, 0.012, 0.012); });
  kbd.addEventListener('keyup', render);
  kbd.addEventListener('click', render);
  kbd.addEventListener('select', render);

  kbd.addEventListener('keydown', function (e) {
    if (state.busy || state.locked) { e.preventDefault(); return; }
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        blip(520, 0.05);
        submit(kbd.value);
        break;
      case 'Tab':
        e.preventDefault();
        complete();
        break;
      case 'ArrowUp':
        e.preventDefault();
        historyPrev();
        break;
      case 'ArrowDown':
        e.preventDefault();
        historyNext();
        break;
      case 'l':
      case 'L':
        if (e.ctrlKey) { e.preventDefault(); outEl.innerHTML = ''; }
        break;
      case 'c':
      case 'C':
        if (e.ctrlKey) {
          e.preventDefault();
          echoLine(kbd.value + '^C');
          kbd.value = '';
          render();
        }
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        setTimeout(render, 0);
        break;
    }
  });

  kbd.addEventListener('focus', function () { state.kbdHidden = false; syncKbdChip(); });
  kbd.addEventListener('blur', syncKbdChip);

  /* 触屏：短按才聚焦输入框；长按 / 滑动留给“选中文本”和“滚动阅读” */
  var tapInfo = null;

  function hitCmd(el) { return !!(el && el.closest && el.closest('[data-cmd]')); }

  screenEl.addEventListener('pointerdown', function (e) {
    if (hasSelection() || hitCmd(e.target)) return;
    if (e.pointerType && e.pointerType !== 'mouse') {
      tapInfo = { x: e.clientX, y: e.clientY, t: Date.now() };
      return;
    }
    state.kbdHidden = false;
    setTimeout(focusInput, 0);
  });
  screenEl.addEventListener('pointerup', function (e) {
    if (!tapInfo) return;
    var dx = Math.abs(e.clientX - tapInfo.x), dy = Math.abs(e.clientY - tapInfo.y);
    var dt = Date.now() - tapInfo.t;
    tapInfo = null;
    if (dx > 12 || dy > 12 || dt > 500) return;
    if (hasSelection()) return;
    state.kbdHidden = false;
    setTimeout(focusInput, 0);
  });
  screenEl.addEventListener('pointercancel', function () { tapInfo = null; });

  entrybar.addEventListener('pointerdown', function () {
    state.kbdHidden = false;
    setTimeout(focusInput, 0);
  });

  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;   // 触屏走上面的精确判断
    if (e.target === kbd) return;
    if (e.target.closest && e.target.closest('.quickbar')) return;
    if (hasSelection()) return;          // 允许用户选中文本复制
    setTimeout(focusInput, 0);
  });

  /* 点输出里的文件名 = cd / cat：移动端少打很多字 */
  outEl.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-cmd]');
    if (!t || state.busy || state.locked) return;
    if (hasSelection()) return;
    var cmd = t.getAttribute('data-cmd');
    if (cmd) quickRun(cmd);
  });

  function hasSelection() {
    var s = window.getSelection && String(window.getSelection());
    return !!(s && s.length);
  }
  document.addEventListener('keydown', function (e) {
    if (state.locked) return;
    if (e.key === 'Escape' || e.key === 'Enter') skipBoot = true;
    if (document.activeElement !== kbd && !e.metaKey && !e.ctrlKey && !e.altKey) focusInput(true);
  });

  /* ---------------- 主题 ---------------- */
  function setTheme(t) {
    state.theme = t;
    crt.setAttribute('data-theme', t);
    try { localStorage.setItem('scp.theme', t); } catch (err) {}
    // 手机上让浏览器地址栏配色跟着荧光色走
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && global.getComputedStyle) {
      var bg = getComputedStyle(crt).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
    if (themeChip) themeChip.title = '切换荧光配色（下一套：' + nextTheme() + '）';
  }

  /* ---------------- 开机自检 ---------------- */
  /* 宽屏用完整 Banner；窄屏换成 22 列的紧凑版，避免 ASCII 艺术被折行拆碎 */
  var BANNER_WIDE = [
    '  ███████╗ ██████╗██████╗    ████████╗███████╗██████╗ ███╗   ███╗',
    '  ██╔════╝██╔════╝██╔══██╗   ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║',
    '  ███████╗██║     ██████╔╝█████╗██║   █████╗  ██████╔╝██╔████╔██║',
    '  ╚════██║██║     ██╔═══╝ ╚════╝██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║',
    '  ███████║╚██████╗██║           ██║   ███████╗██║  ██║██║ ╚═╝ ██║',
    '  ╚══════╝ ╚═════╝╚═╝           ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝'
  ];

  var BANNER_COMPACT = [
    '  ██████  ████  █████ ',
    '  ██     ██    ██  ██',
    '  ██████ ██    █████ ',
    '      ██ ██    ██    ',
    '  ██████  ████ ██    '
  ];

  function bootLines() {
    var cols = columns();
    var compact = cols < 74;
    var rows = [];

    (compact ? BANNER_COMPACT : BANNER_WIDE).forEach(function (l) {
      rows.push([l, 'banner', 0]);
    });
    rows.push(['', null, 0]);

    if (compact) {
      rows.push(['  SCP FOUNDATION — SECURE TERMINAL', 'accent', 0]);
      rows.push(['  v2.7.3 · node-07 · 仅限内部使用', 'dim', 0]);
    } else {
      rows.push(['  SCP FOUNDATION — SECURE TERMINAL  v2.7.3   node-07', 'accent', 0]);
      rows.push(['  (C) 2026 SCP Foundation · 内部使用 · 禁止外传', 'dim', 0]);
    }
    rows.push(['', null, 0]);

    var pad = compact ? 26 : 36;
    [
      ['BIOS CHECK', 'OK'],
      ['MEMORY 65536K', 'OK'],
      ['MOUNT /vault', 'OK'],
      ['CLEARANCE DATABASE', 'OK'],
      ['UPLINK site-07', 'OK'],
      ['KEYSTROKE AUDIT LOGGER', 'ENABLED']
    ].forEach(function (c) {
      var dots = '.'.repeat(Math.max(3, pad - c[0].length));
      rows.push(['  ' + c[0] + ' ' + dots + ' ' + c[1],
                 c[1] === 'ENABLED' ? 'warn' : null, 60]);
    });

    rows.push(['', null, 0]);
    rows.push(['[WARN] 本终端记录全部按键，未授权访问将被追溯。', 'warn', 90]);
    rows.push([compact ? '[WARN] 演示终端：请勿输入真实口令。'
                       : '[WARN] 这是演示终端：请勿输入真实口令，账号数据仅存于你的浏览器。', 'warn', 90]);
    rows.push(['', null, 0]);
    return rows;
  }

  function boot() {
    outEl.innerHTML = '';
    skipBoot = false;
    state.booted = false;
    stick = true;
    setBusy(true);
    refresh();

    var p = Promise.resolve();
    bootLines().forEach(function (row) {
      p = p.then(function () {
        if (row[0] === '') { blank(); return sleep(skipBoot ? 0 : 40); }
        return type(row[0], row[1], 4).then(function () {
          return sleep(skipBoot ? 0 : row[2] || 30);
        });
      });
    });

    return p.then(function () { return Auth.ensureSeeded(); }).then(function () {
      var s = Auth.restore();
      if (s) {
        out('  检测到已有会话：<span class="accent">' + esc(s.user) +
            '</span>（' + esc(s.role) + ' · L' + s.clearance + '）', 'ok');
      } else {
        out('  未检测到有效会话 —— 当前权限等级 L0。');
      }
      blank();
      refresh();
      state.booted = true;
      updateQuickbar(Auth.current());
      setBusy(false);
      focusInput();
    });
  }

  /* ---------------- 视口（软键盘 / 旋转） ---------------- */
  /* 把 visualViewport 的尺寸同步给 CSS，输入行就始终贴在软键盘上方 */
  function syncViewport() {
    var vv = global.visualViewport;
    if (!vv) return;
    var root = document.documentElement;
    root.style.setProperty('--vvh', Math.round(vv.height) + 'px');
    root.style.setProperty('--vvtop', Math.round(vv.offsetTop) + 'px');
    if (stick) scroll();
  }

  function watchViewport() {
    syncViewport();
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', syncViewport);
      global.visualViewport.addEventListener('scroll', syncViewport);
    }
    var timer = null;
    global.addEventListener('resize', function () {
      syncViewport();
      clearTimeout(timer);
      timer = setTimeout(function () { syncViewport(); refresh(); render(); }, 160);
    });
    global.addEventListener('orientationchange', function () {
      setTimeout(function () { syncViewport(); refresh(); }, 250);
    });
  }

  /* ---------------- 时钟 ---------------- */
  function tickClock() {
    var el = $('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    try {
      var t = localStorage.getItem('scp.theme');
      if (t) setTheme(t);
      state.sound = localStorage.getItem('scp.sound') === '1';
    } catch (e) {}
    if (IS_TOUCH) state.kbdHidden = true;   // 手机上别自动弹出键盘
    setInterval(tickClock, 1000);
    tickClock();
    watchViewport();
    refresh();
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
