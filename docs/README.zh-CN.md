[English](../README.md) · **简体中文**

# pi-quote-blocks

选中回复里的任意一段话，变成「引用块」再针对它回复 —— Codex 式的引用体验，纯终端实现。

```
❝ Q1 · 3 lines
│ The cache should expire after 24 hours.
│ … +1 more
❝ Q2 · 1 line
│ 改用 docker compose 部署
──────────────────────────────────────────────
❯ [Q1] 这个设计对吗？[Q2] 那这个呢
```

## 安装

```bash
pi install npm:pi-quote-blocks
```

或从源码安装：`pi install git:github.com/codelllc09/pi-quote-blocks`

## 用法

| 操作 | 效果 |
|---|---|
| 对话区拖选 + `Alt+Q` | 建引用块，`[Qn]` 插入光标处 |
| `Alt+Q` 无选区 | 回退读系统剪贴板（pi 拖选自动复制，默认开启） |
| `/quote [n]` | 引用倒数第 n 条回复（默认最后一条） |
| `Alt+E` | 块管理器——停靠窗口、实时预览；`e` 编辑 · `r` 删除 · `i` 重插 marker · Enter 更多 |
| `Alt+H` | 折叠 / 展开卡片 |
| 发送 | 标记展开为 `> 引用`，未引用的块清除 |

`/quotes` 打开同一管理器（子命令：`clear` `fold` `unfold` `edit Qn`
`remove Qn` `preview`）。编写时卡片显示在输入框上方；删掉草稿里的
`[Qn]` 标记，对应卡片即消失。编号每批从 Q1 重新开始。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_QUOTE_KEY_QUOTE` · `_FOLD` · `_MANAGE` | `alt+q` · `alt+h` · `alt+e` | 各动作键位；逗号分隔可绑多键 |
| `PI_QUOTE_FOLD_LINES` | `8` | 卡片总行数超过即自动折叠 |
| `PI_QUOTE_CLIPBOARD` | 开 | `=0` 关闭剪贴板回退 |
| `PI_QUOTE_ALLOW_UNREVIEWED` | 关 | `=1` 跳过版本白名单 |
| `PI_QUOTE_DEBUG` / `PI_QUOTE_DEBUG_LOG` | 关 / `/tmp/quote-blocks-debug.log` | 调试日志 |

键位格式同 pi 的 key-id；默认键冲突时可按终端设置（WezTerm pane env、direnv 等）。
`alt+shift+<字母>` 在 pi-tui 1.4.0 中无法匹配任何编码，配置后启动时会警告。

## 工作方式

终端输入框是纯文本网格，做不了行内浮动块，因此分三层：

1. **卡片**渲染在输入框上方的 widget 区
2. 正文只放 `[Qn]` 短标记——位置即引用锚点
3. **发送时**由 input 事件 transform 把标记展开为 Markdown 引用
   （`> …`），前后补空行避免惰性延续吞掉批注

## 兼容性

实时选区读取用了渲染器内部 API，由 `REVIEWED_PI_VERSIONS`（**1.0.3**、
**1.4.0**）把关；其余版本及非全屏模式走公开的剪贴板路径
（`pbpaste` / `xclip` / `xsel` / `wl-paste` / `termux-clipboard-get` /
`Get-Clipboard`）。

## 开发

```bash
npm install && npm run typecheck && npm test
```

## 致谢

「全屏选区获取」（widget-bridge 技巧与 API 探测）改自
[alandarev/pi-quote](https://github.com/alandarev/pi-quote) v0.1.2（MIT）；
块架构、标记展开、折叠为本仓库实现。详见 `LICENSE`。
