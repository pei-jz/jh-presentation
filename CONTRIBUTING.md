# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Setup

```bash
npm install
npm run dev      # http://localhost:4000
npm test         # needs Chrome or Edge
```

## Guidelines

- The browser side (`engine/`, `components/`) has **no runtime dependencies** and is written as classic scripts so that
  decks work from `file://`. Keep it that way.
- Decks must stay **self-contained and offline**: no CDNs or web fonts.
- When you change the engine, components or themes, update `docs/authoring-guide.md` (it is what the AI reads),
  run `npm run upgrade` so `examples/sample.html` embeds the new engine, and make sure `npm test` passes —
  it audits the sample and every theme.
- Changes to the editable-element rule or the edit messages must bump `PROTOCOL` in `engine/deck-edit.js` and be
  documented in `docs/edit-protocol.md`.
- Add a test for every bug fix (`tests/*.test.mjs`, Node's built-in test runner).
- Code comments in this repository are mostly Japanese; match the file you are editing.
