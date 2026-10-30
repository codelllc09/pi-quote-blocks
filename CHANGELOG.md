# Changelog

## 0.2.0 (2026-10-31)

### Added

- `Alt+E` block manager. Slash commands cannot fire while composing
  (the draft no longer starts with `/`), so edit / remove / clear are
  also reachable from a shortcut: pick a block, then edit its text,
  remove it, re-insert its marker at the cursor, or clear all. The
  dialogs overlay the editor; the draft is never touched.
- Pick-view single-key accelerators: `e`/`r`/`i` act directly on the
  highlighted block (edit / remove / re-insert marker), skipping the
  action view; Enter still opens it, and letters are inert on the
  clear-all row so that path keeps its confirm safeguard.
- The block picker is an overlay window docked above the editor — the
  same place pi's native select appears — with the live preview pane
  floating above the list. The whole flow (pick → action → confirm)
  stays inside this one window; only the multi-line text editor opens
  after it closes, so no dialog nesting and no jump back to the bottom
  bar mid-flow. Fixed pane heights (cursor moves recolor one row and
  swap preview text in place), dim wrapped preview, `+N more`
  indicator, clear-all confirm defaults to "no". Border rows now
  align exactly with content rows (the fill formula was one column
  short). Falls back to
  `ctx.ui.select` where `ctx.ui.custom` is unavailable.
- `/quote [n]` — quote the nth-last assistant reply from session history as
  a block (public `sessionManager.getBranch()` API; default: the last reply).
  Keyboard-only quoting, no mouse selection needed.
- `/quotes edit Qn` — fix or trim a block's text in a multi-line editor;
  emptied text removes the block.
- `/quotes remove Qn` (aliases `rm`, `delete`) — drop one block and its
  marker.
- `/quotes preview` — see exactly what submit will send, without consuming
  the blocks.
- Clipboard fallback for `Alt+Q` when live selection is unavailable
  (unreviewed pi version, regular mode, renderer API change). Pi's
  fullscreen copy-on-select (default on) keeps the clipboard in sync, so
  this path needs no renderer internals. `PI_QUOTE_CLIPBOARD=0` disables it.
- Widget cards render in draft marker (anchor) order.

### Changed

- `/quote-selection` removed — it ran the exact Alt+Q handler under a name
  easily confused with `/quote`; the slash menu now shows two entries
  (`/quote`, `/quotes`) instead of three.
- Bare `/quotes` opens the `Alt+E` block manager instead of a plain
  notify list (non-TUI modes keep the list).

### Fixed

- `/quotes clear` collapsed every run of spaces in the whole draft (code
  indentation, aligned text). Markers are now removed whole with at most one
  adjacent space; unrelated spacing is never touched.
- Invalid `PI_QUOTE_FOLD_LINES` values (NaN) silently disabled auto-folding;
  they now fall back to the default of 8.

### Internal

- Marker insertion uses the public `ctx.ui.pasteToEditor()` instead of
  probing the editor's private cursor APIs (the `CursorEditor` probing chain
  is gone; old pi versions fall back to draft-end append).
- Test suite (vitest): pure-function tests plus a mocked-runtime extension
  test; strict `tsc --noEmit` typecheck; CI workflow runs both on push/PR;
  npm publishing now installs and runs the checks first.
- `files` field limits the npm tarball to the extension, docs, and license.
