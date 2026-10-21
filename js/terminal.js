/* ============================================================
   terminal.js — 终端内核：开机自检、输入行、历史、补全、指令派发
   ============================================================ */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var crt = $('crt'), screenEl = $('screen'), outEl = $('output');
  var inputLine = $('inputline'), promptEl = $('prompt');
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
    fails: 0
  };

  var skipBoot = false;

  /* ---------------- 显示宽度（CJK 占 2 列） ---------------- */
  var dispWidth = global.Util.dispWidth;
  var padTo = global.Util.padTo;

  /* ---------------- 输出 ---------------- */
  function addLine() {
    var el = document.createElement('div');
    el.className = 'line';
    outEl.appendChild(el);
    // 控制 DOM 规模
    while (outEl.childNodes.length > 800) outEl.removeChild(outEl.firstChild);
    return el;
  }
  function scroll() { screenEl.scrollTop = screenEl.scrollHeight; }

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
           '<span class="dim">@</span><span class="host">scp-node07</span>' +
           '<span class="dim">:</span><span class="path">' + esc(path) + '</span>' +
           '<span class="dim">' + (s ? '$' : '>') + '</span>';
  }
  function refresh() { promptEl.innerHTML = promptHtml(); }

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
    state.busy = b;
    inputLine.hidden = b || state.locked;
    cursorEl.classList.toggle('busy', b);
    kbd.disabled = b;
    if (!b) { render(); focusInput(); }
  }

  function focusInput() {
    if (!state.locked) { try { kbd.focus({ preventScroll: true }); } catch (e) { kbd.focus(); } }
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
      inputLine.hidden = true;
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

  screenEl.addEventListener('pointerdown', function (e) {
    if (window.getSelection && String(window.getSelection()) ) return;
    setTimeout(focusInput, 0);
  });
  document.addEventListener('pointerdown', function (e) {
    if (e.target === kbd) return;
    if (hasSelection()) return;          // 允许用户选中文本复制
    setTimeout(focusInput, 0);
  });
  function hasSelection() {
    var s = window.getSelection && String(window.getSelection());
    return !!(s && s.length);
  }
  document.addEventListener('keydown', function (e) {
    if (state.locked) return;
    if (e.key === 'Escape' || e.key === 'Enter') skipBoot = true;
    if (document.activeElement !== kbd && !e.metaKey && !e.ctrlKey && !e.altKey) focusInput();
  });

  /* ---------------- 主题 ---------------- */
  function setTheme(t) {
    state.theme = t;
    crt.setAttribute('data-theme', t);
    try { localStorage.setItem('scp.theme', t); } catch (err) {}
  }

  /* ---------------- 开机自检 ---------------- */
  var BOOT = [
    ['  ███████╗ ██████╗██████╗    ████████╗███████╗██████╗ ███╗   ███╗', 'banner', 0],
    ['  ██╔════╝██╔════╝██╔══██╗   ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║', 'banner', 0],
    ['  ███████╗██║     ██████╔╝█████╗██║   █████╗  ██████╔╝██╔████╔██║', 'banner', 0],
    ['  ╚════██║██║     ██╔═══╝ ╚════╝██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║', 'banner', 0],
    ['  ███████║╚██████╗██║           ██║   ███████╗██║  ██║██║ ╚═╝ ██║', 'banner', 0],
    ['  ╚══════╝ ╚═════╝╚═╝           ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝', 'banner', 0],
    ['', null, 0],
    ['  SCP FOUNDATION — SECURE TERMINAL  v2.7.3   node-07', 'accent', 0],
    ['  (C) 2026 SCP Foundation · 内部使用 · 禁止外传', 'dim', 0],
    ['', null, 0],
    ['BIOS  CHECK ...................... OK', null, 60],
    ['MEMORY 65536K .................... OK', null, 60],
    ['MOUNT /vault ..................... OK', null, 60],
    ['CLEARANCE DATABASE ............... OK', null, 60],
    ['UPLINK site-07 ................... OK', null, 60],
    ['KEYSTROKE AUDIT LOGGER ........... ENABLED', 'warn', 60],
    ['', null, 0],
    ['[WARN] 本终端记录全部按键，未授权访问将被追溯。', 'warn', 90],
    ['[WARN] 这是演示终端：请勿输入真实口令，账号数据仅存于你的浏览器。', 'warn', 90],
    ['', null, 0]
  ];

  function boot() {
    outEl.innerHTML = '';
    skipBoot = false;
    inputLine.hidden = true;
    screenEl.classList.add('boot');

    var p = Promise.resolve();
    BOOT.forEach(function (row) {
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
        out('  输入 logout 可结束会话。', 'dim');
      } else {
        out('  未检测到有效会话 —— 当前权限等级 L0（访客）。');
        out('  登录后按权限等级解锁档案：');
        out('    <span class="accent">login &lt;用户名&gt; &lt;口令&gt;</span>   例：<span class="accent">login admin admin123</span>', null);
        out('    <span class="accent">help</span>                 查看全部指令', null);
        out('  演示账号：<span class="dim">' + Auth.DEMO.join('   ') + '</span>', null);
      }
      blank();
      screenEl.classList.remove('boot');
      refresh();
      setBusy(false);
      focusInput();
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
    setInterval(tickClock, 1000);
    tickClock();
    refresh();
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
