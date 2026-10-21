/* ============================================================
   filesystem.js — 虚拟文件系统（含权限等级）
   目录 = { __dir: { name: node } }
   文件 = { __file: "内容", __clearance: 1, __mtime: "2026-01-01" }
   ============================================================ */
(function (global) {
  'use strict';

  function dir(children, clearance) {
    return { __dir: children, __clearance: clearance || 1 };
  }
  function file(content, clearance, mtime) {
    return { __file: content, __clearance: clearance || 1, __mtime: mtime || '2026-01-07' };
  }

  var root = dir({
    'readme.txt': file(
      'SCP 基金会 · 站点-07 内部终端\n' +
      '---------------------------------------------\n' +
      '1. 本终端记录全部按键与会话，未授权访问将被追溯。\n' +
      '2. 权限等级（Clearance）决定你可读取的档案。\n' +
      '3. 需要帮助请输入 help，登录请输入 login <用户名> <口令>。\n', 1, '2025-11-02'),

    'manifest.txt': file(
      '站点-07 人员名册（节选）\n' +
      '- 主管   : 1 名（L4）\n' +
      '- 研究员 : 14 名（L3）\n' +
      '- 安保   : 62 名（L2）\n' +
      '- 见习   : 9 名（L1）\n', 2, '2026-02-19'),

    'incidents': dir({
      '2026-01-14.log': file(
        '[03:12] 收容单元 B-12 压力异常，误差 0.4%。\n' +
        '[03:20] 自动复位完成，无需人员介入。\n' +
        '[03:21] 备注：值班员报告听见敲击声，未复现。\n', 2, '2026-01-14'),
      '2026-03-02.log': file(
        '[22:47] 等级 3 警报：档案柜 7 非授权开启。\n' +
        '[22:51] 安保抵达，现场无异常。\n' +
        '[23:05] 调查结论：门锁固件缺陷，已修补。\n', 3, '2026-03-02')
    }, 2),

    'dossiers': dir({
      'object-117.txt': file(
        '项目编号：SCP-117（虚构示例）\n' +
        '等级：Safe\n' +
        '描述：一台 1983 年产阴极射线终端，通电后显示未发送过的邮件草稿。\n' +
        '收容：存放于低价值物品库，每日记录屏幕内容。\n', 2, '2025-09-30'),
      'object-402.txt': file(
        '项目编号：SCP-402（虚构示例）\n' +
        '等级：Euclid\n' +
        '描述：一段 11 秒音频，听者会在 24 小时后忘记自己听过它。\n' +
        '收容：音频存放于隔音服务器，禁止任何回放设备联网。\n', 3, '2026-04-11')
    }, 2),

    'secure': dir({
      'notice.txt': file(
        '权限等级 ≥ 3 方可浏览本目录。\n' +
        '任何复制、拍照、转述行为均按三级违规处理。\n', 3, '2026-05-06'),
      'o5-memo.txt': file(
        '仅限 L4。\n' +
        '站点-07 的年度审计将于本月进行，请提前归档所有临时账号。\n', 4, '2026-06-01'),
      'keys.txt': file('（空）\n', 4, '2026-06-01')
    }, 3)
  }, 1);

  /* ---------- 路径工具 ---------- */
  function isDir(n) { return !!n && !!n.__dir; }
  function isFile(n) { return !!n && typeof n.__file === 'string'; }

  /** 把 cwd(数组) 与任意路径解析为规范化的绝对路径片段 */
  function resolve(cwd, path) {
    var segs;
    if (!path || path === '~') path = '/';
    if (path.charAt(0) === '/') segs = path.split('/');
    else if (path === '..' || path.indexOf('../') === 0) segs = cwd.concat(path.split('/'));
    else segs = cwd.concat(path.split('/'));

    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return out;
  }

  function get(segs) {
    var node = root;
    for (var i = 0; i < segs.length; i++) {
      if (!isDir(node)) return null;
      node = node.__dir[segs[i]];
      if (!node) return null;
    }
    return node || null;
  }

  function pathOf(segs) { return '/' + segs.join('/'); }

  function canRead(node, clearance) {
    if (!node) return false;
    return (clearance || 1) >= (node.__clearance || 1);
  }

  function list(segs, clearance) {
    var node = get(segs);
    if (!isDir(node)) return null;                 // null = 路径不是目录
    if (!canRead(node, clearance)) return 'denied'; // 'denied' = 权限不足
    return Object.keys(node.__dir).sort().map(function (name) {
      var child = node.__dir[name];
      return {
        name: name + (isDir(child) ? '/' : ''),
        dir: isDir(child),
        clearance: child.__clearance || 1,
        size: isFile(child) ? child.__file.length : 0,
        mtime: child.__mtime || '-'
      };
    });
  }

  function read(segs, clearance) {
    var node = get(segs);
    if (!node) return { err: 'no such file or directory' };
    if (isDir(node)) return { err: 'is a directory' };
    if (!canRead(node, clearance)) return { denied: true, need: node.__clearance };
    return { content: node.__file };
  }

  /** 供 Tab 补全使用：列出某目录下的可见名称 */
  function names(segs, clearance) {
    var items = list(segs, clearance);
    if (!Array.isArray(items)) return [];
    return items.map(function (i) { return i.name; });
  }

  global.FS = {
    resolve: resolve, get: get, list: list, read: read,
    isDir: isDir, isFile: isFile, pathOf: pathOf, canRead: canRead, names: names
  };
})(window);
