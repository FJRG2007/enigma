# @enigmax/dashboard

The browser UI for [enigma](https://github.com/FJRG2007/enigma)'s local savings
dashboard: a single static page (`assets/index.html`) plus a vendored charting library
(`assets/lib/chart.min.js`).

You do not install this directly. enigma-cli fetches it **on demand** the first time you
open the dashboard (`enigma dashboard`) or enable it (`enigma config dashboard on`), into
a managed directory under `~/.enigma/dashboard`, and keeps it up to date on
`enigma update`. enigma's loopback HTTP server serves these files and provides the
`/api/stats` and `/api/settings` endpoints the page talks to.

Keeping the UI out of the base `enigma-cli` package means users who never open the
dashboard never download it (the chart library alone is ~196 KB).

The page is served only on `127.0.0.1` (never network-facing) and the settings write
endpoint is origin-guarded by enigma. The chart library retains its upstream Apache-2.0
license header as required; its attribution logo is suppressed in enigma's own CSS.

## License

Apache-2.0
