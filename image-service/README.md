# image-service

Image upload and transformation on Cloudflare: **R2** stores the originals, the **Images binding** resizes and re-encodes on read, and the edge cache keeps the results.

Status: built and tested locally. **Not deployed.** Deploying creates billable resources in a Cloudflare account, so it needs the account owner's go-ahead (see "Deploy").

## API

| Method and path | Auth | What it does |
|---|---|---|
| `POST /upload` | Bearer token | Raw image body (optionally `X-Filename`) or `multipart/form-data` with a `file` field. Returns `{id, url, kind, contentType, bytes, width, height, existed}`. `201` new, `200` if identical bytes already exist. |
| `GET /i/:id` | none | Original bytes, untouched (no Images call, no transformation billing). A `Range` header is ignored and the full body is returned with 200. `HEAD` is answered from metadata and never runs a transformation. |
| `GET /i/:id?v=card` | none | Named variant: `thumb` 160x160 cover, `card` 480w, `hero` 1280w, `full` 2560w. |
| `GET /i/:id?w=800` | none | Width from the ladder `64 128 256 320 480 640 800 1024 1280 1600 1920 2560`. Never upscales. |
| `GET /i/:id?v=card&f=webp` | none | `f` is `auto` (default, from the `Accept` header: avif, then webp, then png/jpeg), `webp`, `avif`, `jpeg` or `png`. `f` alone changes the format only: no resize, the pixel size is unchanged. |
| `GET /meta/:id` | Bearer token | Stored metadata. |
| `DELETE /i/:id` | Bearer token | Removes the original. |
| `GET /health` | none | `{ok:true}` |

`:id` is the SHA-256 of the file bytes (64 hex characters). Same file, same id: uploads dedupe.

```sh
curl -X POST "$BASE/upload" -H "authorization: Bearer $TOKEN" \
     -H "content-type: image/png" --data-binary @photo.png
# <img srcset="$BASE/i/<id>?w=480 480w, $BASE/i/<id>?w=1024 1024w" ...>
```

## Design decisions (and the trade-off in each)

- **Quantised transforms, not free-form `w/h/q`.** Images billing counts each unique combination of source image and parameters. Open parameters let anyone request unlimited combinations on a public URL. Here the maximum is (4 variants + 12 widths) x 4 formats = 64 per image. Cost of this choice: no arbitrary sizes. Widen the ladder in `src/lib.ts` if you need to.
- **Content-addressed ids.** Free dedupe and safe immutable caching. Cost: anyone who holds the exact file can compute its URL, so ids are not secrets. For private images you would add signed URLs. That is not built.
- **Type by magic bytes, SVG refused.** The client's `Content-Type` and file name are ignored. SVG can carry script and would be served from your origin. `images.info()` also decodes the header, so a file with valid magic bytes but a broken body returns `422`. A 50-megapixel cap guards against decompression bombs.
- **Fail closed auth.** If `UPLOAD_TOKEN` is unset or shorter than 32 characters, writes return `503` and never open up. Token comparison is constant-time.
- **Caching.** `cache.enabled` is set in `wrangler.jsonc` as the Images docs recommend, and responses carry `Cache-Control: public, max-age=<CACHE_SECONDS>` (default one day) plus an `ETag` that supports `304` (exact, weak, list and `*` forms). `Vary: Accept` is set only for `f=auto`. Cloudflare's Workers Caching honors `Vary` and stores one variant per *verbatim* `Accept` value ([docs](https://developers.cloudflare.com/workers/cache/)), so many different browser `Accept` strings fragment the cache. If you put a different cache in front (for example Cache Rules on a custom domain), it must vary on `Accept` too, or it can serve one browser's AVIF to another. To avoid that entirely, have clients request an explicit `f`.
- **GIFs.** Images keeps animation for WebP and GIF output (`anim` defaults to true). For a GIF source, `f=auto` therefore picks WebP or GIF, never AVIF. An explicit `f=avif`, `png` or `jpeg` on an animated GIF produces a still image.
- **Upload limits.** Raw uploads are read through a counter and cancelled once they pass `MAX_UPLOAD_BYTES`, so an oversized chunked body is not fully buffered. Multipart uploads must send `Content-Length` (otherwise `411`), because the form parser buffers the whole body.
- **Delete is not instant at the edge.** `DELETE` removes the original, but already-cached transforms live until `max-age` expires unless you purge the cache.

## Verified in this repo (27 Nov 2026)

- `npm run typecheck`: clean (TypeScript 7.0.2).
- `npm test`: 34 of 34 pass. They run the real handler against in-memory fakes of R2 and the Images binding. A deliberate break of the auth check made one test fail, so the suite does catch it.
- `wrangler deploy --dry-run` (wrangler 4.169.0): bundles at 11.62 KiB (gzip 4.10 KiB); bindings `BUCKET`, `IMAGES` and both vars resolve; `cache.enabled` accepted.
- `wrangler dev --local` end to end with a real 640x480 PNG: upload `201`, re-upload `existed:true`, original byte-identical, `?w=256&f=webp` gave a valid 256x192 WebP, `?v=thumb` gave 160x160, bad width `400`, SVG `415`, no token `401`, delete then `404`.

## Not verified

- **High-fidelity Images behaviour.** Local mode is the low-fidelity simulator: it supports `width`, `height`, `rotate` and `format` only. So `fit` modes, `quality` and AVIF output are exercised only by the fakes here, not by the real service. Run `npx wrangler dev --remote` (needs an account) or a staging deploy and check `v=thumb` (cover crop) and `f=avif`.
- Edge cache hit behaviour, real R2 latency, and billing.
- AVIF output size: Cloudflare's Images limits page lists a 1,200 px maximum dimension for AVIF, so `hero` and `full` as AVIF may fall back to another format [limits page, for remote and hosted images; not tested for the binding].
- Whether your account has the Images transformations product enabled.
- Cloudflare's current price for transformations and R2. Check the Images pricing page before launch.

## Deploy (needs the account owner's approval)

Pick the account first. This repo has no `account_id` on purpose.

```sh
cd image-service && npm ci
npx wrangler login                                   # the intended account
npx wrangler r2 bucket create image-service-originals
openssl rand -hex 32 | npx wrangler secret put UPLOAD_TOKEN   # run after the first deploy
npx wrangler deploy
```

Then add a WAF rate-limiting rule on `/upload`, and optionally a custom domain. Rate limiting is not in the Worker.

## Development

```sh
npm ci
npm run check          # typecheck + tests + bundle dry run
printf 'UPLOAD_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars   # gitignored
npm run dev            # local R2, low-fidelity Images
```
