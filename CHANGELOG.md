# Changelog

## 0.2.0 (2026-10-31)

### Added

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
