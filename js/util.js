/* ============================================================
   util.js — 公共小工具（需最先加载）
   ============================================================ */
(function (global) {
  'use strict';

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** HTML 转义 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  /** 显示宽度：中日韩全角字符占 2 列 */
  function dispWidth(s) {
    s = String(s);
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xffff) i++;
      w += fullwidth(c) ? 2 : 1;
    }
    return w;
  }

  function fullwidth(c) {
    return c >= 0x1100 && (
      c <= 0x115f ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6));
  }

  /** 右侧补空格到指定显示宽度 */
  function padTo(s, width) {
    return String(s) + ' '.repeat(Math.max(1, width - dispWidth(s)));
  }

  global.Util = { esc: esc, dispWidth: dispWidth, padTo: padTo };
  global.escHtml = esc;
})(window);
