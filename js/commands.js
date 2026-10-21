/* ============================================================
   commands.js — 指令表
   每条指令：{ usage, desc, minLevel, run(args, ctx) -> void|Promise }
   ctx 提供：print/html/type/clear/esc/state/session 等
   ============================================================ */
(function (global) {
  'use strict';

  var esc = global.Util.esc;
  var dispWidth = global.Util.dispWidth;

  var THEMES = ['green', 'amber', 'ice', 'mono'];

  var CMDS = {

    /* ---------------- 核心：登录 ---------------- */
    login: {
      usage: 'login <用户名> <口令>',
      desc: '以指定账号登录终端，登录后按权限等级解锁档案',
      run: function (args, ctx) {
        if (args.length !== 2) {
          ctx.err('用法：login <用户名> <口令>');
          ctx.dim('示例：login admin admin123');
          return;
        }
        if (ctx.session()) {
          ctx.err('已登录为 ' + ctx.session().user + '，请先执行 logout。');
          return;
        }

        var user = args[0], pass = args[1];

        var left = Auth.lockedFor(user);
        if (left > 0) {
          ctx.err('账号已锁定：因连续失败次数过多，请 ' + Math.ceil(left / 1000) + ' 秒后重试。');
          ctx.dim('如需帮助请联系站点管理员（分机 07-114）。');
          return;
        }

        return ctx.progress('验证凭据', 700).then(function () {
          return Auth.verify(user, pass);
        }).then(function (ok) {
          if (!ok) {
            var f = Auth.noteFail(user);
            ctx.err('登录失败：用户名或口令不正确。');
            if (f.locked) {
              ctx.err('连续失败 ' + Auth.MAX_FAILS + ' 次 —— 该账号已锁定 30 秒。');
              ctx.state.fails++;
            } else {
              ctx.warn('剩余尝试次数：' + (Auth.MAX_FAILS - f.count) + ' / ' + Auth.MAX_FAILS);
            }
            ctx.dim('提示：本终端的口令使用 salt + SHA-256 存储于本机 localStorage。');
            return;
          }

          var acc = Auth.find(user);
          var s = Auth.login(acc);
          Auth.clearFails(user);
          ctx.state.cwd = [];
          ctx.refresh();

          ctx.blank();
          ctx.html('<span class="banner">  认证通过 · ACCESS GRANTED</span>');
          ctx.blank();
          ctx.kv([
            ['用户', s.user],
            ['职务', s.role],
            ['权限等级', 'L' + s.clearance + ' / L4'],
            ['来源', s.ip],
            ['会话开始', new Date(s.since).toLocaleString('zh-CN')]
          ]);
          ctx.blank();
          if (s.clearance >= 3) ctx.ok('已解锁 /secure 档案库，可读取 L3 及以上文件。');
          else ctx.dim('当前等级不足，/secure 目录拒绝访问（需要 L3）。');
          ctx.blank();
          ctx.dim('输入 help 查看指令，logout 退出登录。');
        });
      }
    },

    logout: {
      usage: 'logout',
      desc: '结束当前会话，退回未登录状态',
      run: function (args, ctx) {
        var s = ctx.session();
        if (!s) { ctx.warn('当前没有登录的会话。'); return; }
        var secs = Math.max(1, Math.round((Date.now() - s.since) / 1000));
        Auth.logout();
        ctx.state.cwd = [];
        ctx.refresh();
        ctx.ok('已登出 ' + s.user + '，本次会话时长 ' + secs + ' 秒。');
        ctx.dim('会话记录已归档。');
      }
    },

    register: {
      usage: 'register <用户名> <口令>',
      desc: '注册新账号（默认 L1，口令至少 6 位）',
      run: function (args, ctx) {
        if (args.length !== 2) {
          ctx.err('用法：register <用户名> <口令>');
          return;
        }
        return Auth.create(args[0], args[1]).then(function (r) {
          if (!r.ok) { ctx.err('注册失败：' + r.msg); return; }
          ctx.ok('账号 ' + r.user + ' 建立成功（L1 · 见习人员）。');
          ctx.dim('现在可以执行：login ' + r.user + ' <口令>');
        });
      }
    },

    passwd: {
      usage: 'passwd <旧口令> <新口令>',
      desc: '修改当前账号的口令（需已登录）',
      minLevel: 1,
      run: function (args, ctx) {
        var s = ctx.session();
        if (!s) { ctx.err('需要登录：请先 login <用户名> <口令>'); return; }
        if (args.length !== 2) { ctx.err('用法：passwd <旧口令> <新口令>'); return; }
        return Auth.verify(s.user, args[0]).then(function (ok) {
          if (!ok) { ctx.err('旧口令不正确，未做任何修改。'); return; }
          return Auth.setPass(s.user, args[1]).then(function (r) {
            if (!r.ok) { ctx.err('修改失败：' + r.msg); return; }
            ctx.ok('口令已更新，下次登录生效。');
            ctx.dim('（口令以 salt + SHA-256 形式保存在本机）');
          });
        });
      }
    },

    whoami: {
      usage: 'whoami',
      desc: '显示当前登录身份与权限等级',
      run: function (args, ctx) {
        var s = ctx.session();
        if (!s) { ctx.print('visitor（未登录）'); ctx.dim('权限等级 L0 —— 仅可访问公开目录。'); return; }
        ctx.print(s.user + '  ·  ' + s.role + '  ·  L' + s.clearance);
        ctx.dim('会话来源 ' + s.ip + '，开始于 ' + new Date(s.since).toLocaleTimeString('zh-CN'));
      }
    },

    users: {
      usage: 'users',
      desc: '列出终端上已登记的账号',
      minLevel: 2,
      run: function (args, ctx) {
        var list = Object.keys(Auth.all()).sort().map(function (u) {
          var a = Auth.find(u);
          return [u, a.role || '人员', 'L' + a.clearance,
                  new Date(a.created || Date.now()).toLocaleDateString('zh-CN')];
        });
        ctx.table(['账号', '职务', '等级', '建立日期'], list);
      }
    },

    /* ---------------- 文件系统 ---------------- */
    ls: {
      usage: 'ls [-l] [路径]',
      desc: '列出目录内容（-l 显示权限等级与修改日期）',
      run: function (args, ctx) {
        var long = false, path = null;
        args.forEach(function (a) {
          if (a === '-l' || a === '-la') long = true; else path = a;
        });
        var segs = FS.resolve(ctx.state.cwd, path || '.');
        var items = FS.list(segs, ctx.level());
        if (items === 'denied') { ctx.err('ls: ' + FS.pathOf(segs) + ': 权限不足'); return; }
        if (items === null) { ctx.err('ls: ' + FS.pathOf(segs) + ': 不是目录'); return; }
        if (!items.length) { ctx.dim('（空目录）'); return; }

        if (!long) {
          ctx.print(items.map(function (i) {
            return i.dir ? '<span class="link">' + esc(i.name) + '</span>'
                         : esc(i.name);
          }).join('   '), null, true);
          return;
        }
        ctx.table(['权限', '大小', '修改日期', '名称'],
          items.map(function (i) {
            return ['L' + i.clearance, i.dir ? '-' : i.size + 'B', i.mtime, i.name];
          }), ['link'], 3);
      }
    },

    cd: {
      usage: 'cd <路径>',
      desc: '切换当前目录（支持 .. 与绝对路径）',
      run: function (args, ctx) {
        var target = args[0] || '/';
        var segs = FS.resolve(ctx.state.cwd, target);
        var node = FS.get(segs);
        if (!node) { ctx.err('cd: ' + target + ': 无此目录'); return; }
        if (!FS.isDir(node)) { ctx.err('cd: ' + target + ': 不是目录'); return; }
        if (!FS.canRead(node, ctx.level())) { ctx.err('cd: ' + target + ': 权限不足'); return; }
        ctx.state.cwd = segs;
        ctx.refresh();
      }
    },

    pwd: {
      usage: 'pwd',
      desc: '显示当前所在目录',
      run: function (args, ctx) { ctx.print(FS.pathOf(ctx.state.cwd)); }
    },

    cat: {
      usage: 'cat <文件>',
      desc: '读取文本文件内容（受权限等级限制）',
      run: function (args, ctx) {
        if (!args.length) { ctx.err('用法：cat <文件>'); return; }
        return (function next(i) {
          if (i >= args.length) return Promise.resolve();
          var segs = FS.resolve(ctx.state.cwd, args[i]);
          var r = FS.read(segs, ctx.level());
          if (r.denied) {
            ctx.err('cat: ' + FS.pathOf(segs) + ': 权限不足（需要 L' + r.need + '，当前 L' + ctx.level() + '）');
          } else if (r.err) {
            ctx.err('cat: ' + FS.pathOf(segs) + ': ' + r.err);
          } else {
            ctx.print(r.content);
          }
          return next(i + 1);
        })(0);
      }
    },

    /* ---------------- 系统 ---------------- */
    help: {
      usage: 'help [指令]',
      desc: '显示全部指令，或查看某条指令的用法',
      run: function (args, ctx) {
        if (args.length) {
          var name = args[0].toLowerCase();
          var c = CMDS[name];
          if (!c) { ctx.err('help: 没有 “' + name + '” 这条指令'); return; }
          ctx.html('<span class="accent">' + esc(c.usage) + '</span>');
          ctx.print('  ' + c.desc + (c.minLevel ? '（需要 L' + c.minLevel + '）' : ''));
          return;
        }
        ctx.html('<span class="banner">可用指令</span>');
        var seen = {};
        var rows = Object.keys(CMDS).sort().map(function (k) {
          var c = CMDS[k];
          if (c.aliasOf || seen[c.usage]) return null;
          seen[c.usage] = 1;
          return [c.usage, c.desc + (c.minLevel && c.minLevel > 1 ? '（需要 L' + c.minLevel + '）' : '')];
        }).filter(Boolean);
        rows.forEach(function (r) {
          ctx.html('  <span class="accent">' + esc(r[0]) + '</span>' +
                   ' '.repeat(Math.max(1, 28 - dispWidth(r[0]))) +
                   '<span class="dim">' + esc(r[1]) + '</span>');
        });
        ctx.blank();
        ctx.dim('快捷键：↑/↓ 翻历史 · Tab 补全 · Ctrl+L 清屏 · Ctrl+C 取消当前行');
        ctx.dim('演示账号：' + Auth.DEMO.join('   '));
      }
    },

    clear: {
      usage: 'clear',
      desc: '清空屏幕（Ctrl+L）',
      run: function (args, ctx) { ctx.clear(); }
    },

    echo: {
      usage: 'echo <文本>',
      desc: '原样输出一段文本',
      run: function (args, ctx) { ctx.print(args.join(' ')); }
    },

    date: {
      usage: 'date',
      desc: '显示当前系统时间',
      run: function (args, ctx) {
        var d = new Date();
        var off = -d.getTimezoneOffset();               // 分钟，东半球为正
        var sign = off >= 0 ? '+' : '-';
        var oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
        ctx.print(d.toLocaleString('zh-CN', { hour12: false }) +
                  '  ·  UTC' + sign + oh + (om ? ':' + String(om).padStart(2, '0') : '') +
                  '  ·  第 ' + Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1) + ' 天');
      }
    },

    uptime: {
      usage: 'uptime',
      desc: '显示本次页面的运行时长',
      run: function (args, ctx) {
        var s = Math.floor((Date.now() - ctx.state.bootAt) / 1000);
        ctx.print('终端已运行 ' + Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒 · 已执行 ' +
                  ctx.state.cmdCount + ' 条指令');
      }
    },

    history: {
      usage: 'history',
      desc: '列出本次会话输入过的指令',
      run: function (args, ctx) {
        var h = ctx.state.history;
        if (!h.length) { ctx.dim('（暂无记录）'); return; }
        h.forEach(function (line, i) {
          ctx.print(String(i + 1).padStart(4, ' ') + '  ' + line);
        });
      }
    },

    theme: {
      usage: 'theme <green|amber|ice|mono>',
      desc: '切换显示器的荧光配色',
      run: function (args, ctx) {
        if (!args.length) {
          ctx.print('当前配色：' + ctx.state.theme + '　可选：' + THEMES.join(' / '));
          return;
        }
        var t = args[0].toLowerCase();
        if (THEMES.indexOf(t) < 0) { ctx.err('theme: 不支持 “' + t + '”'); return; }
        ctx.setTheme(t);
        ctx.ok('荧光配色已切换为 ' + t + '。');
      }
    },

    sound: {
      usage: 'sound <on|off>',
      desc: '开启/关闭按键与输出的机械音效',
      run: function (args, ctx) {
        if (!args.length) { ctx.print('音效：' + (ctx.state.sound ? '开' : '关')); return; }
        var v = args[0].toLowerCase();
        if (v !== 'on' && v !== 'off') { ctx.err('用法：sound <on|off>'); return; }
        ctx.setSound(v === 'on');
        ctx.ok('音效已' + (v === 'on' ? '开启' : '关闭') + '。');
      }
    },

    sudo: {
      usage: 'sudo <指令>',
      desc: '以提升权限执行指令（本终端不提供提权）',
      run: function (args, ctx) {
        ctx.err('权限提升失败：本终端不记录 sudoers。');
        ctx.dim('该尝试已写入 /incidents 审计日志（虚构）。');
        ctx.dim('分机 07-114 已收到通知。 :)');
      }
    },

    exit: {
      usage: 'exit',
      desc: '结束会话并锁定屏幕',
      run: function (args, ctx) {
        ctx.ok('会话结束，屏幕已锁定。');
        ctx.dim('按任意键重新启动终端…');
        return ctx.lock();
      }
    }
  };

  /* 别名（不在 help 列表中重复出现） */
  function alias(name, target) {
    var c = Object.create(CMDS[target]);
    c.aliasOf = target;
    CMDS[name] = c;
  }
  alias('cls', 'clear');
  alias('quit', 'exit');
  alias('man', 'help');
  alias('dir', 'ls');
  alias('who', 'whoami');
  alias('signin', 'login');
  alias('logoff', 'logout');
  alias('type', 'cat');

  global.Commands = CMDS;
})(window);
