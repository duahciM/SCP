/* ============================================================
   auth.js — 账号存储 / 口令校验 / 会话 / 失败锁定
   纯前端演示：口令经 salt + SHA-256 存于 localStorage，
   不参与任何真实鉴权，请勿使用真实密码。
   ============================================================ */
(function (global) {
  'use strict';

  var STORE_KEY = 'scp.accounts.v1';
  var SESSION_KEY = 'scp.session.v1';

  /* ---------- 预置演示账号（首次访问时写入 localStorage） ---------- */
  var SEED = [
    { user: 'admin',      pass: 'admin123',    clearance: 4, role: '站点主管' },
    { user: 'researcher', pass: 'researcher',  clearance: 3, role: '研究员' },
    { user: 'guard',      pass: 'guard123',    clearance: 2, role: '安保人员' },
    { user: 'guest',      pass: 'guest',       clearance: 1, role: '访客' }
  ];

  var USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;

  /* ---------- 工具 ---------- */
  function randHex(n) {
    var b = new Uint8Array(n), s = '';
    (global.crypto || global.msCrypto).getRandomValues(b);
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  function sha256(str) {
    var subtle = global.crypto && global.crypto.subtle;
    if (subtle && typeof TextEncoder !== 'undefined') {
      return subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        var a = Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        });
        return a.join('');
      });
    }
    // 非安全上下文（如 file://）下的降级哈希
    return Promise.resolve(fallbackHash(str));
  }

  function fallbackHash(str) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      h1 = (h1 ^ str.charCodeAt(i)) * 16777619 >>> 0;
      h2 = (h2 + str.charCodeAt(i) * (i + 7)) * 2654435761 >>> 0;
    }
    return 'insecure$' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /* ---------- 存储 ---------- */
  var cache = null;

  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(localStorage.getItem(STORE_KEY)) || null;
    } catch (e) { cache = null; }
    return cache;
  }

  function save(accounts) {
    cache = accounts;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(accounts)); } catch (e) {}
  }

  /** 首次运行播种演示账号（异步，因为需要算哈希） */
  function ensureSeeded() {
    if (load()) return Promise.resolve();
    var jobs = SEED.map(function (s) {
      var salt = randHex(8);
      return sha256(salt + s.pass).then(function (hash) {
        return { user: s.user, salt: salt, hash: hash, clearance: s.clearance,
                 role: s.role, created: Date.now() };
      });
    });
    return Promise.all(jobs).then(function (list) {
      var accounts = {};
      list.forEach(function (a) { accounts[a.user] = a; });
      save(accounts);
    });
  }

  function all() { return load() || {}; }

  function find(user) { return all()[String(user).toLowerCase()] || null; }

  /* ---------- 账号操作 ---------- */
  function create(user, pass, clearance) {
    var name = String(user).toLowerCase();
    if (!USERNAME_RE.test(name)) {
      return { ok: false, msg: '用户名需为 3-16 位字母、数字、_ . 或 -' };
    }
    if (pass.length < 6) {
      return { ok: false, msg: '口令至少 6 位' };
    }
    if (find(name)) return { ok: false, msg: '账号 “' + name + '” 已存在' };

    var accounts = all();
    var salt = randHex(8);
    return sha256(salt + pass).then(function (hash) {
      accounts[name] = { user: name, salt: salt, hash: hash,
                         clearance: clearance || 1, role: '见习人员',
                         created: Date.now() };
      save(accounts);
      return { ok: true, user: name };
    });
  }

  function verify(user, pass) {
    var acc = find(user);
    if (!acc) return Promise.resolve(false);
    return sha256(acc.salt + pass).then(function (h) { return h === acc.hash; })
      .catch(function () { return false; });
  }

  function setPass(user, newPass) {
    var acc = find(user);
    if (!acc) return Promise.resolve({ ok: false, msg: '账号不存在' });
    if (newPass.length < 6) return Promise.resolve({ ok: false, msg: '新口令至少 6 位' });
    var accounts = all();
    var salt = randHex(8);
    return sha256(salt + newPass).then(function (hash) {
      acc.salt = salt; acc.hash = hash;
      accounts[acc.user] = acc;
      save(accounts);
      return { ok: true };
    });
  }

  /* ---------- 会话 ---------- */
  var session = null;   // { user, clearance, role, since, ip }

  function restore() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !find(s.user)) { sessionStorage.removeItem(SESSION_KEY); return null; }
      session = s;
    } catch (e) { session = null; }
    return session;
  }

  function login(acc) {
    session = {
      user: acc.user,
      clearance: acc.clearance,
      role: acc.role || '人员',
      since: Date.now(),
      ip: (session && session.ip) || randIp()
    };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
    return session;
  }

  function logout() {
    session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function current() { return session; }

  function randIp() {
    return '10.' + (Math.floor(Math.random() * 200) + 1) + '.' +
           (Math.floor(Math.random() * 254) + 1) + '.' +
           (Math.floor(Math.random() * 254) + 1);
  }

  /* ---------- 失败尝试锁定（内存态，刷新即重置） ---------- */
  var fails = {};          // user -> { n, until }
  var MAX_FAILS = 5;
  var LOCK_MS = 30000;

  function lockedFor(user) {
    var f = fails[String(user).toLowerCase()];
    if (!f || !f.until) return 0;
    var left = f.until - Date.now();
    if (left <= 0) { delete fails[String(user).toLowerCase()]; return 0; }
    return left;
  }

  function noteFail(user) {
    var k = String(user).toLowerCase();
    var f = fails[k] || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    fails[k] = f;
    return { count: f.n, locked: !!f.until, max: MAX_FAILS };
  }

  function clearFails(user) { delete fails[String(user).toLowerCase()]; }

  global.Auth = {
    USERNAME_RE: USERNAME_RE,
    DEMO: SEED.map(function (s) { return s.user + '/' + s.pass; }),
    ensureSeeded: ensureSeeded,
    all: all, find: find, create: create, verify: verify, setPass: setPass,
    restore: restore, login: login, logout: logout, current: current,
    lockedFor: lockedFor, noteFail: noteFail, clearFails: clearFails,
    MAX_FAILS: MAX_FAILS
  };
})(window);
