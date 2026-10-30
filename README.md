**English** · [简体中文](./docs/README.zh-CN.md)

# pi-quote-blocks

Select any passage of a reply and respond to just that part — Codex-style
quote blocks, entirely in the terminal.

```
❝ Q1 · 3 lines
│ The cache should expire after 24 hours.
│ … +1 more
❝ Q2 · 1 line
│ switch to docker compose deploy
──────────────────────────────────────────────
❯ [Q1] is this right? [Q2] and this?
```

## Install

```bash
pi install npm:pi-quote-blocks
```

Or from source: `pi install git:github.com/codelllc09/pi-quote-blocks`

## Usage

| Action | Effect |
|---|---|
| Drag-select transcript + `Alt+Q` | Quote it; `[Qn]` lands at the cursor |
| `Alt+Q` without a selection | Falls back to the clipboard (pi's copy-on-select keeps it in sync) |
| `/quote [n]` | Quote the nth-last assistant reply (default: last) |
| `Alt+E` | Block manager — docked window, live preview; `e` edit · `r` remove · `i` insert marker · Enter for more |
| `Alt+H` | Fold / expand cards |
| Submit | Markers expand to `> quotes`; unreferenced blocks are dropped |

`/quotes` opens the same manager (subcommands: `clear` `fold` `unfold`
`edit Qn` `remove Qn` `preview`). Cards render above the editor while you
compose; delete a `[Qn]` marker and its card disappears. Numbering
restarts at Q1 per batch.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PI_QUOTE_KEY_QUOTE` · `_FOLD` · `_MANAGE` | `alt+q` · `alt+h` · `alt+e` | Key(s) per action; comma-separated lists bind several keys |
| `PI_QUOTE_FOLD_LINES` | `8` | Auto-fold beyond this many card lines |
| `PI_QUOTE_CLIPBOARD` | on | `=0` disables the clipboard fallback |
| `PI_QUOTE_ALLOW_UNREVIEWED` | off | `=1` skips the reviewed-version allowlist |
| `PI_QUOTE_DEBUG` / `PI_QUOTE_DEBUG_LOG` | off / `/tmp/quote-blocks-debug.log` | Debug log |

Keys use pi's key-id format; set them per terminal (WezTerm pane env,
direnv, …) when a default collides. `alt+shift+<letter>` matches no
encoding in pi-tui 1.4.0 and warns at startup.

## How it works

Terminal editors are plain text grids, so no inline floating blocks:

1. **Cards** render in the widget area above the editor
2. The draft holds only short `[Qn]` markers — position = quote anchor
3. **On submit** an input-event transform expands markers to Markdown
   quotes (`> …`), blank-line padded so lazy continuation cannot swallow
   your annotations

## Compatibility

Live selection reads renderer internals, gated by `REVIEWED_PI_VERSIONS`
(**1.0.3**, **1.4.0**); everything else — and regular (non-fullscreen)
mode — uses the public clipboard path instead (`pbpaste` / `xclip` /
`xsel` / `wl-paste` / `termux-clipboard-get` / `Get-Clipboard`).

## Development

```bash
npm install && npm run typecheck && npm test
```

## Credits

Selection acquisition (the widget-bridge trick and API probing) derives
from [alandarev/pi-quote](https://github.com/alandarev/pi-quote) v0.1.2
(MIT); the block architecture, marker expansion, and folding are this
repo's work. See `LICENSE`.
