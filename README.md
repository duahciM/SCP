# SCP

一个 **CRT 终端风格的可交互网页**：外观是老式荧光显示器，操作方式是**打字输入指令**。
零依赖（原生 HTML / CSS / JS），桌面与手机都能直接用，由 GitHub Pages 直接托管。

## 在线体验

推送到 `main` 后由 `.github/workflows/static.yml` 自动部署到 Pages，打开站点根目录即可。
本地预览：

```bash
python3 -m http.server 8000   # 然后访问 http://localhost:8000
```

## 指令一览

| 指令 | 说明 |
| --- | --- |
| `login <用户名> <口令>` | **登录终端**，按账号权限等级（L1–L4）解锁档案 |
| `logout` | 结束当前会话 |
| `register <用户名> <口令>` | 注册新账号（默认 L1，口令 ≥ 6 位） |
| `passwd <旧口令> <新口令>` | 修改当前账号口令 |
| `whoami` / `users` | 查看当前身份 / 账号列表（L2） |
| `ls [-l] [路径]` / `cd <路径>` / `pwd` / `cat <文件>` | 浏览虚拟文件系统（受权限等级限制） |
| `help [指令]`、`clear`、`echo`、`date`、`uptime`、`history` | 常规工具 |
| `theme <green\|amber\|ice\|mono>`、`sound <on\|off>` | 切换荧光配色 / 机械音效 |
| `sudo`、`exit` | 彩蛋 / 结束会话并锁屏 |

快捷键：`↑`/`↓` 翻历史指令 · `Tab` 补全指令与路径 · `Ctrl+L` 清屏 · `Ctrl+C` 取消当前行。

## 移动端

手机上自动切成全屏布局：标题栏 / 输出区 / 输入行 / 快捷指令条，并为触屏单独做了这些处理：

- **快捷指令条**：`help`、`ls`、`ls -l`、`readme`、`登录`（一键演示登录）、`whoami`、`users`、`theme`、`clear`
  点一下直接执行；右侧固定四个按键 —— `↑` 取回上一条指令、`⇥` 补全、`⌨` 收起/唤起键盘、`↵` 执行当前输入。
- **点文件名**：`ls` 输出里的名字可以直接点，目录等于 `cd`、文件等于 `cat`，不用在手机键盘上抠路径。
- **软键盘不挡输入行**：布局高度跟随 `visualViewport` 同步，键盘弹出时输入行始终贴在键盘上方；
  执行指令期间输入框用 `readOnly` 而非 `disabled`，软键盘不会一开一合。
- **触屏手势**：轻点输出区唤起键盘；长按或滑动仍然可以正常选中复制、上下滚动阅读（往上翻时输出不会把你拽回底部）。
- **开机不自动弹键盘**；提示符精简为 `user:/path$`，ASCII Banner 换成紧凑版，
  `ls -l` 表格与 `help` 在窄屏自动改为折行友好的逐行布局。
- 浏览器地址栏配色跟随荧光主题（`theme-color`），并适配刘海屏安全区（`env(safe-area-inset-*)`）。

桌面端行为保持不变（快捷条由 CSS 在宽屏隐藏，`ls -l` 仍是列对齐表格）。

## 演示账号

| 账号 | 口令 | 权限 |
| --- | --- | --- |
| `admin` | `admin123` | L4（可读取 `/secure/o5-memo.txt`） |
| `researcher` | `researcher` | L3（可进入 `/secure`） |
| `guard` | `guard123` | L2（可查看 `/incidents`） |
| `guest` | `guest` | L1（仅公开目录） |

```text
login admin admin123
```

## 关于 `login` 的实现

- 口令以 **随机 salt + SHA-256** 的摘要形式存入浏览器 `localStorage`（键 `scp.accounts.v1`），
  不保存明文；非 HTTPS 环境（如 `file://`）自动降级为本地哈希并在摘要前标记 `insecure$`。
- 会话写入 `sessionStorage`（键 `scp.session.v1`），刷新页面可恢复，关闭标签页即失效。
- 输入时口令以 `*` 回显，且写入历史记录的也是掩码后的文本。
- 同一账号连续失败 5 次会锁定 30 秒，锁定状态记录在内存中，刷新即重置。

> ⚠️ 这是演示用的前端玩具：校验完全在浏览器内完成，**不具备任何真实安全性，请勿输入真实密码**。

## 目录结构

```text
index.html          页面骨架
css/terminal.css    CRT 外观（扫描线、荧光、暗角、四套配色）
js/util.js          HTML 转义与等宽显示宽度计算
js/auth.js          账号 / 口令校验 / 会话 / 失败锁定
js/filesystem.js    虚拟文件系统与权限等级
js/commands.js      指令表
js/terminal.js      终端内核：开机自检、输入行、历史、补全、指令派发
```
