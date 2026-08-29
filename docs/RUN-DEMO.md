# Running the live demo (one click)

**Start:** double-click `start-demo.command` at the repo root (macOS opens it
in Terminal; or run `bash start-demo.command`). It checks Node, installs
dependencies on first run, builds what's missing, loads `.env` if present
(optional — live rates run keyless), starts the yield API on
`127.0.0.1:8787`, serves the demo on `127.0.0.1:8788`, and opens your
browser. The **LIVE** chip next to the headline means the page is reading
the API. The page is served over http (not opened as a `file://`) because
Safari and Chrome both restrict `file://` pages from calling localhost.

**Stop:** double-click `stop-demo.command`. It SIGTERMs the two processes
via their PID files, then sweeps ports 8787/8788 for stragglers. Nothing
else on the machine is touched; logs stay in `.demo/` (gitignored, safe to
delete). Closing the Terminal window does NOT stop the servers — they run
detached on purpose so the window can be closed; use the stop script.

**Bands:** pool cards say “pending backfill” until the engine's on-chain
history has been backfilled once: `npm run backfill -- all` (resumable;
faster with `BLOCKSCOUT_PRO_API_KEY` in `.env`). Then Start again — the
realized-return bands render from real closed-position history.

**Fresh clone note:** if the `.command` files ever lose their execute bit
(some download paths strip it), `chmod +x *.command` once — or just run
them with `bash start-demo.command`, which needs no bit at all.

**Ports busy?** `YIELD_PORT=9787 bash start-demo.command` moves the API
(the page probes 8787 by default, so prefer freeing the port with the stop
script instead). If a start fails, the error names the log to read:
`.demo/setup.log`, `.demo/yield.log`, or `.demo/web.log`.
