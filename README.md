**English** · [简体中文](./README.zh-CN.md)

# pi-quote-blocks

Select any passage of a reply and respond to just that part — Codex-style
quote blocks, implemented entirely in the terminal.

```
❝ Q1 · 3 lines
│ The cache should expire after 24 hours.
│ … +1 more
❝ Q2 · 1 line
│ switch to docker compose deploy
──────────────────────────────────────────────
❯ [Q1] is this right? [Q2] and this?
```

## How it works

Terminal editors are plain text grids — no inline floating blocks. This
extension gets the same effect with three layers:

1. **Block cards** render in the widget area above the editor (same spot as
   image chips)
2. The draft only holds short `[Qn]` markers; marker position = quote anchor
3. **On submit** (an `input`-event transform) markers expand to standard
   Markdown quotes (`> …`) with blank-line separation so Markdown lazy
   continuation cannot swallow your annotations

## Usage

| Action | Effect |
|---|---|
| Drag-select transcript text + `Alt+Q` | Create a quote block, insert `[Qn]` at cursor |
| Repeat for more blocks | Blocks coexist; numbering restarts at Q1 per batch |
| Delete a `[Qn]` marker from the draft | Its card disappears |
| `Alt+Shift+Q` | Fold / expand all blocks |
| `/quotes` | List blocks; `clear`, `fold`, `unfold` subcommands |
| Submit | Markers expand to `> quotes`; unreferenced blocks are dropped |

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PI_QUOTE_FOLD_LINES` | `8` | Auto-fold beyond this many card lines |
| `PI_QUOTE_DEBUG` | off | `=1` enables the debug log |
| `PI_QUOTE_DEBUG_LOG` | `/tmp/quote-blocks-debug.log` | Log path |
| `PI_QUOTE_ALLOW_UNREVIEWED` | off | `=1` skips the reviewed-version allowlist |

## Compatibility

Reads the selection through renderer internals, so the upstream discipline
applies: versions listed in `REVIEWED_PI_VERSIONS` run; anything else refuses
with a hint until reviewed. Requires fullscreen mode (pi's default) and a
terminal with mouse selection.

Reviewed: **1.0.3** (upstream), **1.4.0** (this repo, 2026-10).

## Credits

Selection acquisition (the widget-bridge trick and API probing) derives from
[alandarev/pi-quote](https://github.com/alandarev/pi-quote) v0.1.2 (MIT).
The block architecture, marker expansion, and folding are this repo's work.
See `LICENSE`.

## Roadmap

- [ ] Clipboard fallback for unreviewed pi versions (read copy-on-select
      clipboard — public API only)
