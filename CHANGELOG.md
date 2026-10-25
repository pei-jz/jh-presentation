# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/)
(while below 1.0, minor versions may contain breaking changes).

Decks record the engine version that built them (`<meta name="generator">`). Writing to a deck keeps its embedded
engine; run `upgrade_deck` / `npm run upgrade` to move a deck to the current engine. The edit protocol version is
documented in `docs/edit-protocol.md`; hosts and save servers refuse edits from decks with a different version.

## [0.9.0]

### Added
- **Map documents**: a theme picker in the header switches between all built-in themes embedded in the document
  (the choice is remembered; `?theme=<name>` also works). The document's own theme stays the default.
- **Map documents**: the ☰ button collapses the table of contents (remembered), and branches open and close with
  a triangle. With more than 40 nodes, deeper branches start closed; the current level's branch opens automatically.
- `Deck.audit()` reports body text running into the slide margin or the page number (`overflow` with
  `area: "margin"`, page-number overlaps) and slide titles that wrap to two lines (`wrap`, exempt with `allow-wrap`).
  MCP `audit_deck` reports them too.
- Examples: `examples/sample-map-large.html` (a 135-part travel booking system across 34 levels) and
  `examples/sample-er-1000.html` (1,000 tables and 1,291 foreign keys).

### Changed
- Entering a level of a hierarchy map zooms much less (1.35× instead of 2.2×, 380 ms) and cross-fades the inner
  diagram; with `prefers-reduced-motion` the camera does not move.
- Automatic layout reorders nodes within each column to reduce crossing arrows (only when it actually reduces
  them), wraps very long columns (6+ boxes that make the diagram taller than wide) into staggered columns, and
  does the same for crowded boundary boxes. Small diagrams keep their layout.
- Arrow labels in hierarchy maps are placed where they do not overlap boxes, counts or other labels; labels with
  no free spot are hidden and shown on hover or highlight. Count badges move along the arrow to avoid overlaps.
- The npm package no longer includes `examples/` (494.7 kB → 180.7 kB).

### Fixed
- Printing a map document from the normal view (print button or Ctrl+P) printed only the visible screen. It now
  prints one page per level, like `?print`, without opening a new tab.
- Map documents' overlap check now also covers arrow count badges.
- When `.fill` itself is a column grid, a diagram row grew with its content and spilled into the bottom margin.

## [0.8.0]

### Added
- **Hierarchy maps** in `.diagram`: nest boxes to any depth and click into them. Each level is redrawn at full size,
  with a breadcrumb (Esc / Backspace go up). Arrows are written once between the finest parts and roll up into
  counted arrows at higher levels; parts connected to the outside appear as dashed boundary boxes.
- **Data flows** (`flows`): named paths across levels. Highlight a whole flow, or step through it with ▶ / ◀ (the
  view moves into the level of each segment); steps can use `flow` + `upto`. Reverse segments animate backwards.
- **Map documents** (`maps/`, `npm run new -- <name> --kind map`): a single-file HTML document without slides, with a
  table of contents, search, data filter, detail panel listing connections, shareable URLs (`#/<level>/<node>`), and
  one printed page per level. `npm run pdf` / `upgrade` and the preview server handle maps.
- **ER diagrams inside maps**: tables (`kind: "table"`) inside a DB box, column-level `relations` with cardinality
  marks, highlighted join columns, and CRUD lists from `type: "write"` / `"read"` arrows.
- **State machines** (`kind: "state"`): initial / final states, nested states, transitions shown as
  `event [guard] / action`, and `"simulate": true` to click through transitions.
- Pan, zoom (wheel, pinch, buttons) and a minimap for maps (`"pan": true` on slides).
- MCP: `create_map`, `read_map` (`outline` for a table of contents, `node` for one box), `write_map` (`node` +
  `part` to replace one box). `list_decks`, `audit_deck`, `screenshot_deck` (`levels`, `select`), `open_deck`
  (`level`), `export_deck`, history and `upgrade_deck` work with maps. `--maps-dir` / `JH_PRESENTATION_MAPS_DIR`.
- `Deck.audit()` reports diagram data errors as `data` (missing ids, broken flows, unknown columns, unreachable
  or dead-end states); maps also report `density` and text overlaps on every level.

### Fixed
- Interrupted camera moves no longer leave `Deck.settled` waiting until its timeout, and screenshots wait for the
  full zoom-in animation.

## [0.7.0]

### Added
- `write_deck` and `replace_slide` audit the deck after saving and return the result as `audit` (one line when
  nothing is found), so models that skip `audit_deck` or cannot see screenshots still get the layout problems.
- `create_deck` returns the authoring guide when `get_guide` has not been read in the session.
- The authoring guide has verified examples (flow with labelled arrows, comparison, numbers, code with notes) and a
  list of layouts that break (hand-made boxes and arrows, fixed heights, inline styles).
- `docs/usage.md`: how to ask for a deck in each AI client.

### Changed
- Server instructions and tool descriptions name presentations, slides and 発表資料, so clients that choose tools
  by the request's words find them. `export_deck` is described as "only when the user asks for a PDF".

## [0.6.0]

### Changed
- Decks are saved in the AI client's current workspace (`decks/`, reported through MCP roots) when there is one, or in
  the folder a tool is given with `dir`; the workspace setting is the fallback and keeps the brand, themes and
  templates shared by every project. `--decks-dir` / `--no-roots` adjust this.
- Saving (Ctrl+S or the Save button) ends edit mode once the deck is saved.
- The presenter view can drive the presentation: arrow keys, a click on the current or next slide,
  and Previous / Next buttons.

### Added
- Inside a host editor: F5 asks the host to present, Ctrl+Z / Ctrl+Y outside a box go to the host's undo
  history, Esc ends presenting and S asks the host for its presenter display. Hosts can move the deck with
  `next` / `prev`, and load a display-only copy with `window.__JH_DECK_MODE__ = 'embed'` (moved by `goto`). F5 / Ctrl+R never reload the host page from inside the frame.

## [0.5.2]

### Changed
- Package metadata update. No changes to the engine, components or tools.

## [0.5.1]

### Added
- Before/after slider (`.compare`) and terminal replay (`.terminal`) components.
- Decks include the MIT notice for the embedded engine, components and themes.

## [0.5.0]

### Added
- Diagram components with a shared base (auto layout, zoom camera, detail panel, caption, engine steps, static print):
  flow diagrams and zoom maps (`.diagram`), ER diagrams (`.er-diagram`), sequence diagrams (`.seq-diagram`),
  charts (`.chart`), 3D layer stacks (`.stack3d`).

### Fixed
- Audits now cover every slide (inactive slides were skipped). SVG text size is judged at its rendered scale.

## [0.4.1]

### Added
- `open_deck` can open a fullscreen app window; per-deck presentation mode enters fullscreen on the first action.

## [0.4.0]

### Changed
- Edit rule v2: editable units are decided by structure (text plus inline elements), so custom parts become editable.
  Edit protocol bumped to 2.

### Added
- Double-click a box to edit it; Save and exit buttons in the edit bar.

## [0.3.2]

### Added
- Ctrl+S always saves through the deck (never the browser's "Save page as"); direct save to the file when served by
  the local server; `repair_deck` / `npm run repair` for decks saved by the browser.

## [0.3.1]

### Fixed
- Safe slide replacement with a position-preserving parser, structure validation, atomic saves, revisions and history.
- Stricter audits (overlap, contrast, images, warnings, external requests), consistent step state on direct entry,
  render readiness instead of fixed delays, local-only preview server.

### Changed
- Writes keep the embedded engine; upgrades are explicit.

## [0.3.0]

### Added
- In-place text editing (E key) and a postMessage edit protocol for host applications.

## [0.2.0]

### Changed
- Decks are single self-contained HTML files.

### Added
- Brand band (name and logo), embedded images, custom themes, motion levels in templates.

## [0.1.0]

### Added
- Slide engine, components, themes, MCP server, theme gallery and request templates.
