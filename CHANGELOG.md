# Changelog

## 0.2.1 (2026-10-31)

### Fixed

- Fold default key moved `alt+f` → `alt+h`: pi binds `alt+f` to
  `tui.editor.cursorWordRight`, so the extension stole the editor's
  word-jump and pi printed a shortcut-conflict diagnostic on every
  start. `alt+h` is free across pi 1.4.0's standard and Windows default
  keymaps (snapshot test); `PI_QUOTE_KEY_FOLD=alt+f` restores the old
  binding if you prefer it.

## 0.2.0 (2026-10-31)

### Added

- Configurable shortcut keys: `PI_QUOTE_KEY_QUOTE` / `PI_QUOTE_KEY_FOLD` /
  `PI_QUOTE_KEY_MANAGE` (defaults `alt+q` / `alt+f` / `alt+e`, comma-
  separated lists bind several keys). pi 1.4.0 has no built-in
  rebinding for extension shortcuts, so the extension carries its own
  env-based layer — set per terminal when a default collides. The
  folded-card hint follows the configured fold key, and configured
  `alt+shift+<letter/digit>` keys warn at startup (dead in every
  encoding in pi-tui 1.4.0).

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

- `Alt+Shift+Q` (fold/expand) never fired: legacy encoding sends it as
  ESC + uppercase Q, which pi's key parser has no key id for. Verified
  against pi-tui 1.4.0's matcher, the kitty CSI-u forms do not work
  either — `\x1b[113:81;3u`/`\x1b[113;3u` normalize the shifted letter
  back to lowercase and match `alt+q` (so Alt+Shift+Q would trigger
  quote selection), and `\x1b[81;3u` matches nothing. The registration
  is removed; `Alt+F` is the only fold binding (extension shortcuts are
  matched before app keybindings, so it is safe). The folded-card hint
  now says `alt+f expand`.

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
