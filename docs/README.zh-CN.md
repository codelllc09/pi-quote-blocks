[English](../README.md) · **简体中文**

# pi-quote-blocks

选中回复里的任意一段话，变成「引用块」再针对它回复 —— Codex GUI 式的引用体验，纯终端实现。

```
❝ Q1 · 3 lines
│ The cache should expire after 24 hours.
│ … +1 more
❝ Q2 · 1 line
│ 改用 docker compose 部署
──────────────────────────────────────────────
❯ [Q1] 这个设计对吗？[Q2] 那这个呢
```

## 工作方式

终端输入框是纯文本网格，做不了行内浮动块。本扩展用三层结构达到同样效果：

1. **块卡片**渲染在输入框上方的 widget 区（和图片 chips 同一位置）
2. 正文里只放 `[Qn]` 短标记，位置即引用锚点
3. **发送时**（`input` 事件 transform）把标记展开为标准 Markdown 引用块（`> …`），
   前后自动补空行，避免 Markdown 惰性延续把批注吞进引用里

## 用法

| 操作 | 效果 |
|---|---|
| 在对话区拖选任意文本 + `Alt+Q` | 建引用块，光标处插入 `[Qn]` |
| `Alt+Q` 无选区 / pi 版本未验证 | 回退读系统剪贴板（pi 拖选自动复制） |
| 继续选、继续 `Alt+Q` | 多块并存，编号每批从 Q1 开始 |
| 删掉正文里的 `[Qn]` | 对应卡片即时消失 |
| `Alt+Shift+Q` | 折叠 / 展开所有块 |
| `Alt+E` | 打字途中管理引用块：浏览时有全文预览，选块后可编辑 / 删除 / 重插 marker / 全部清空 |
| `/quote` · `/quote 2` | 将上一条 / 倒数第二条回复整段建为引用块 |
| `/quotes` | 打开块管理器（同 Alt+E 对话框）；子命令 `clear` / `fold` / `unfold` / `edit Qn` / `remove Qn` / `preview` |
| `/quotes edit Q1` | 编辑引用块内容（可删无关行） |
| `/quotes remove Q1` | 删除单个引用块（连 marker 一起清掉） |
| `/quotes preview` | 预览提交时实际展开的文本 |
| 发送 | 标记展开为 `> 引用`，未被引用的块清除 |

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_QUOTE_FOLD_LINES` | `8` | 卡片总行数超过即自动折叠 |
| `PI_QUOTE_CLIPBOARD` | 开 | `=0` 关闭 Alt+Q 的剪贴板回退 |
| `PI_QUOTE_DEBUG` | 关 | `=1` 开启调试日志（`/tmp/quote-blocks-debug.log`） |
| `PI_QUOTE_DEBUG_LOG` | `/tmp/quote-blocks-debug.log` | 日志路径 |
| `PI_QUOTE_ALLOW_UNREVIEWED` | 关 | `=1` 跳过版本白名单（自担风险） |

## 安装

```bash
pi install npm:pi-quote-blocks
```

或从源码安装：`pi install git:github.com/codelllc09/pi-quote-blocks`

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit（严格模式）
npm test            # vitest：纯函数 + mock 运行时测试
```

## 兼容性

实时选区读取用了 pi 渲染器的内部 API，因此沿用上游的**逐版验证纪律**：
`REVIEWED_PI_VERSIONS` 白名单内使用实时选区；其他版本、以及非全屏模式，自动回退读系统剪贴板
（`pbpaste` / `xclip` / `xsel` / `wl-paste` / `termux-clipboard-get` / `Get-Clipboard`；
pi 的拖选自动复制默认开启）。`PI_QUOTE_CLIPBOARD=0` 可关闭。

已验证版本：**1.0.3**（上游验证）、**1.4.0**（本仓库验证，2026-10）。

## 致谢

「全屏选区获取」（widget-bridge 技巧与 API 探测）改自
[alandarev/pi-quote](https://github.com/alandarev/pi-quote) v0.1.2（MIT），
块架构、标记展开、折叠为本仓库实现。详见 `LICENSE`。

## 路线图

- [x] 未验证 pi 版本的剪贴板降级路径（copy-on-select 读剪贴板，纯公开 API）
