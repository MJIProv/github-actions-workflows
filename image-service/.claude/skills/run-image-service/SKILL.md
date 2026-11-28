---
name: run-image-service
description: Build, run, test and drive image-service (Cloudflare Worker with R2 and the Images binding). Use when asked to start image-service, run its tests, smoke-test upload and transforms, check the bundle, or curl the running Worker locally.
---

image-service is a Cloudflare Worker: `POST /upload` stores originals in R2, `GET /i/:id` serves them or transforms them through the Images binding. It is driven with `curl` against `wrangler dev --local`, and the committed driver is `.claude/skills/run-image-service/smoke.sh`. It does not deploy anything.

All paths below are relative to `image-service/`.

## Prerequisites

Verified on Ubuntu with Node v22.23.4, npm 10.9.9 and wrangler 4.169.0 (pinned in `package.json`). The smoke script also uses `curl`, `openssl`, `lsof` and `file`, which were already installed. Node 22 matters: the tests run `.ts` files directly (type stripping) and import with `.ts` extensions.

## Setup

```bash
npm ci --no-audit --no-fund --loglevel=error
```

Takes about 6 seconds with a warm npm cache. `node_modules` is about 320 MB.

## Run (agent path)

One command starts the server, drives it, and stops it. Exit code 0 means every check passed:

```bash
.claude/skills/run-image-service/smoke.sh
```

It runs in about 3 seconds and prints 20 `PASS` lines then `ALL CHECKS PASSED`. What it does, in order: generates a real 640x480 PNG with node's zlib, starts `wrangler dev --local` in its own process group with a random `UPLOAD_TOKEN` passed via `--var` and its local R2 state in a temp dir (`--persist-to`), polls `/health`, then:

| check | expected |
|---|---|
| upload without token | 401 |
| upload PNG | 201, reports 640x480 |
| upload same bytes again | 200, `existed:true` |
| `GET /i/:id` | byte-identical to the upload |
| `?w=256&f=webp` | `image/webp`, 256x192 |
| `?v=thumb&f=jpeg` | `image/jpeg`, 160x160 |
| `?w=999` | 400 (width not on the ladder) |
| SVG upload | 415 |
| `/meta/:id` without / with token | 401 / 200 |
| `?f=webp` (format only) | `image/webp`, still 640x480 |
| `Range` header on the original | full 200, no `Content-Range` |
| `HEAD` on a transform | 200, empty body |
| weak ETag inside an `If-None-Match` list | 304 |
| `DELETE /i/:id`, then `GET` | 200, then 404 |

Port defaults to 8799: `PORT=8801 .claude/skills/run-image-service/smoke.sh`. Server log: `/tmp/image-service-dev.log`. Artifacts it leaves: `/tmp/image-service-test.png`, `/tmp/image-service-orig.png`, `/tmp/image-service-w256.webp`, `/tmp/image-service-thumb.jpg`. The temp state dir is deleted on exit. Your own `.dev.vars` and `.wrangler/` are never read, written or deleted (I tested that with sentinel files).

To poke the server by hand, use the start/stop helper, then curl it:

```bash
.claude/skills/run-image-service/serve.sh start      # prints {"ok":true}, token in /tmp/image-service.token
TOKEN=$(cat /tmp/image-service.token)
curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary x -H "authorization: Bearer $TOKEN" http://localhost:8799/upload   # -> 415 (not an image)
.claude/skills/run-image-service/serve.sh stop       # kills wrangler + workerd, removes its temp state
```

Do not start the server with a bare `setsid ... &` in your own shell: there `$!` is not the process-group leader, so a group kill misses it (I tried; it left `wrangler` and `workerd` running). `serve.sh` does it inside a script, where it works.

## Direct invocation (no server)

The handler is a plain `fetch(request, env)` export, so internals can be tested without wrangler. `npm test` does exactly that, against in-memory fakes of R2 and the Images binding:

```bash
npm test
```

Expected: `# tests 34`, `# pass 34`, `# fail 0` in about half a second. Use this path for changes to routing, auth, validation or parameter parsing (`src/lib.ts`, `src/index.ts`).

## Build and static checks

```bash
npm run typecheck        # tsc --noEmit, clean
npm run check:bundle     # wrangler deploy --dry-run: "Total Upload: 13.12 KiB / gzip: 4.51 KiB"
npm run check            # typecheck + tests + bundle, exits 0
```

`check:bundle` writes `dist/` (gitignored); it needs no Cloudflare login.

## Gotchas

- **Local Images is the low-fidelity simulator.** `wrangler dev --local` supports `width`, `height`, `rotate` and `format` only (Cloudflare docs). Resize, WebP and JPEG output passed here; `fit` modes beyond what the thumb check shows, `quality` and AVIF output are not proven by the smoke test. Use `wrangler dev --remote` (needs a Cloudflare login, untested here) or a staging deploy for those.
- **The upload token must be at least 32 characters.** `smoke.sh` and `serve.sh` pass one via `--var`. If you run `wrangler dev` yourself with a shorter or missing `UPLOAD_TOKEN` (from `.dev.vars` or `--var`), every write returns 503 by design (fails closed), not a bug.
- **Kill the whole process group, not the `npx` PID.** `wrangler dev` spawns node and `workerd` children. My first version of `smoke.sh` killed only the wrapper and left `wrangler` and `workerd` running after every run. The script now starts the server with `setsid` and kills `-$PID`.
- **`lsof -ti:PORT` returned nothing** in my check while a `workerd` process was still holding the port, so port-based killing did not work here. Use the process group.
- **Egress proxy.** This container routes HTTPS through a proxy and wrangler prints `Proxy environment variables detected`. The script unsets the proxy variables and sets `NO_PROXY=localhost,127.0.0.1` for its curls. I did not test whether curl to localhost fails without that.
- **Deleting an image does not purge cached transforms.** `DELETE` removes the R2 original only; edge-cached copies live until `CACHE_SECONDS` expires. Not exercised locally (there is no edge cache in dev).

## Troubleshooting

- **`wrangler` and `workerd` still running after a script run**: the cleanup killed only the `npx` wrapper (fixed in `smoke.sh`). If it happens after a manual start, find the PIDs with `ps -eo pid,stat,args | grep -E "[w]orkerd|[w]rangler dev"` and `kill` them. Defunct entries are zombies and need no action.
- **A `wrangler dev` PID shows in `ps` right after `smoke.sh` exits**: the group kill is asynchronous, so the process can still be listed for a moment. Re-check a second later: in my re-run it was gone, the temp state dir was removed, and only `<defunct>` workerd zombies remained.
- **`Proxy environment variables detected` warning from wrangler**: harmless in my runs.

## Not covered

Deploy (`wrangler deploy`), real R2, the real Images service, edge caching and billing. See `README.md` for the deploy steps, which need the account owner's approval.
