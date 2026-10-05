# Security

## How jh-presentation runs

jh-presentation is a local tool. It is designed so that nothing leaves your machine because of it.

- **No telemetry, no outbound requests.** The MCP server talks to your AI client over stdio only.
- **Local-only servers.** The preview server (`npm run dev`) and the save server started by `open_deck` bind to `127.0.0.1` on your machine. Saving requires a random token that only the page served by that server knows.
- **Files are written only inside the workspace** (`JH_PRESENTATION_HOME`, `--workspace`, or `~/jh-presentation`): decks, `brand/`, `themes/`, `prompts/` and `.history/`. Theme gallery files go to the OS temp folder.
- **Audits, screenshots and PDF export** use your installed Chrome/Edge in headless mode with **all non-local network requests blocked**; any blocked request is reported by `audit_deck`.
- `add_asset` reads only image and video files (png, jpg, gif, webp, svg, mp4, webm) from the path the AI passes, and embeds them into the deck.

## What you should know

- **Decks contain JavaScript written by your AI client**, and it runs in your browser when you open a deck. Open decks you or your AI created; treat decks from others like any other HTML file from the internet.
- The content you ask for is processed by **your AI client** (which may be a cloud service). jh-presentation does not change where your AI client sends data.
- The MCP server has no authentication and is meant to be started by a local AI client. Do not expose it as a network service.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/pei-jz/jh-presentation/security/advisories/new)
rather than opening a public issue. Include steps to reproduce and the version (`npm ls jh-presentation` or the
`generator` meta tag of a deck). You should get a response within a week.
