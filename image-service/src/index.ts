import {
  ID_RE,
  MIME,
  bearer,
  etagMatches,
  fallbackMimes,
  parseTransform,
  readLimited,
  safeEqual,
  safeName,
  sha256Hex,
  sniffImage,
} from "./lib.ts";

export interface Env {
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  /** Secret. `wrangler secret put UPLOAD_TOKEN`. Min 32 chars or the service refuses writes. */
  UPLOAD_TOKEN: string;
  MAX_UPLOAD_BYTES?: string;
  CACHE_SECONDS?: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // the Images binding accepts inputs up to 20 MB
const MAX_PIXELS = 50_000_000; // decompression-bomb guard
const MIN_TOKEN_LEN = 32;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const err = (status: number, message: string) => json({ error: message }, status);

async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  // Fail closed: a missing or weak secret must never turn into an open upload endpoint.
  if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < MIN_TOKEN_LEN) {
    return err(503, "service not configured");
  }
  const presented = bearer(request.headers.get("authorization"));
  if (!presented || !(await safeEqual(presented, env.UPLOAD_TOKEN))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="image-service"' },
    });
  }
  return null;
}

const maxBytes = (env: Env) => {
  const n = Number(env.MAX_UPLOAD_BYTES);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 20 * 1024 * 1024) : DEFAULT_MAX_BYTES;
};

const origKey = (id: string) => `orig/${id}`;

// ---- POST /upload -----------------------------------------------------------
async function upload(request: Request, env: Env): Promise<Response> {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const limit = maxBytes(env);
  const declaredRaw = request.headers.get("content-length");
  const declared = declaredRaw === null ? NaN : Number(declaredRaw);
  if (Number.isFinite(declared) && declared > limit + 4096) return err(413, `file exceeds ${limit} bytes`);

  let bytes: Uint8Array;
  let name = "";
  const ctype = request.headers.get("content-type") ?? "";
  try {
    if (ctype.toLowerCase().startsWith("multipart/form-data")) {
      // formData() buffers the whole body, so only accept it with a declared, bounded length.
      if (!Number.isFinite(declared)) return err(411, "multipart uploads need a Content-Length");
      const file = (await request.formData()).get("file");
      if (!file || typeof file === "string") return err(400, 'multipart field "file" is required');
      name = safeName((file as File).name);
      if ((file as File).size > limit) return err(413, `file exceeds ${limit} bytes`);
      bytes = new Uint8Array(await (file as File).arrayBuffer());
    } else {
      name = safeName(request.headers.get("x-filename"));
      // Stream with a counter: a chunked body over the limit is cancelled, never fully buffered.
      const read = await readLimited(request.body, limit);
      if (read === null) return err(413, `file exceeds ${limit} bytes`);
      bytes = read;
    }
  } catch {
    return err(400, "could not read request body");
  }
  if (bytes.length === 0) return err(400, "empty body");
  if (bytes.length > limit) return err(413, `file exceeds ${limit} bytes`);

  const kind = sniffImage(bytes);
  if (!kind) return err(415, "unsupported image type; allowed: jpeg, png, gif, webp, avif");

  // info() decodes the header, so a file with valid magic bytes but a broken body is rejected here.
  let width: number;
  let height: number;
  try {
    const info = (await env.IMAGES.info(new Blob([bytes]).stream())) as { width: number; height: number };
    width = info.width;
    height = info.height;
  } catch (e) {
    console.error("images.info failed", e instanceof Error ? e.message : String(e));
    return err(422, "file is not a decodable image");
  }
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) {
    return err(422, `image dimensions out of range (max ${MAX_PIXELS} pixels)`);
  }

  const id = await sha256Hex(bytes);
  const key = origKey(id);
  const existing = await env.BUCKET.head(key);
  if (!existing) {
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: MIME[kind], cacheControl: "private, max-age=0" },
      customMetadata: { kind, width: String(width), height: String(height), name, at: new Date().toISOString() },
    });
  }
  const origin = new URL(request.url).origin;
  return json(
    { id, url: `${origin}/i/${id}`, kind, contentType: MIME[kind], bytes: bytes.length, width, height, existed: !!existing },
    existing ? 200 : 201,
  );
}

// ---- GET /i/:id -------------------------------------------------------------
async function serve(request: Request, env: Env, id: string): Promise<Response> {
  const head = await env.BUCKET.head(origKey(id));
  if (!head) return err(404, "not found");
  const kind = (head.customMetadata?.kind ?? "") as keyof typeof MIME;
  // hasOwn, not `in`: `in` would accept "constructor", "toString" and other prototype names.
  if (!Object.hasOwn(MIME, kind)) return err(500, "stored object has no known type");

  const parsed = parseTransform(new URL(request.url).searchParams, request.headers.get("accept"), kind);
  if (!parsed.ok) return err(400, parsed.error);
  const spec = parsed.spec;

  // Unset or non-numeric -> one day. A real 0 is honoured and clamped up to the 60 s minimum.
  const rawTtl = env.CACHE_SECONDS === undefined || env.CACHE_SECONDS.trim() === "" ? NaN : Number(env.CACHE_SECONDS);
  const ttl = Math.max(60, Math.min(Number.isFinite(rawTtl) ? Math.trunc(rawTtl) : 86400, 31536000));
  const common: Record<string, string> = {
    "cache-control": `public, max-age=${ttl}`,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    "content-disposition": "inline",
  };
  const etag = `"${id.slice(0, 32)}-${spec ? spec.tag : "orig"}"`;
  common.etag = etag;
  // Workers Caching honors Vary (one cached variant per verbatim Accept value, per Cloudflare docs).
  // Keep any other cache in front of this Worker configured to vary on Accept too.
  if (spec?.varyAccept) common.vary = "Accept";

  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: common });
  }

  // HEAD: answer from metadata only. Never run a (billable) transformation for a body nobody reads.
  if (request.method === "HEAD") {
    const headers = new Headers(common);
    headers.set("content-type", spec ? spec.mime : (head.httpMetadata?.contentType ?? MIME[kind]));
    if (!spec) headers.set("content-length", String(head.size));
    return new Response(null, { status: 200, headers });
  }

  // Untransformed: stream the stored bytes. No Images call, so no transformation billing.
  if (!spec) {
    // Range is deliberately not supported: images are small (<= MAX_UPLOAD_BYTES) and a Range header
    // is ignored with a full 200, which RFC 9110 allows. No half-implemented 206.
    const obj = await env.BUCKET.get(origKey(id));
    if (!obj) return err(404, "not found");
    const headers = new Headers(common);
    obj.writeHttpMetadata(headers);
    headers.set("cache-control", common["cache-control"]);
    headers.set("etag", etag);
    return new Response(obj.body, { status: 200, headers });
  }

  // f=auto may fall back (AVIF -> WebP -> PNG/JPEG) if the negotiated format fails, for example if AVIF is
  // refused for a large output. An explicit f never falls back: the caller asked for exactly that format.
  const attempts = [
    { mime: spec.mime, quality: spec.quality },
    ...(spec.varyAccept ? fallbackMimes(spec.mime, request.headers.get("accept"), kind).map((mime) => ({ mime, quality: 80 })) : []),
  ];
  const baseName = spec.tag.split(".")[0];
  for (const [i, attempt] of attempts.entries()) {
    const obj = await env.BUCKET.get(origKey(id));
    if (!obj) return err(404, "not found");
    try {
      let transformed = env.IMAGES.input(obj.body);
      // A format-only request has no width/height: skip transform() so the pixel size is untouched.
      if (spec.width !== undefined || spec.height !== undefined) {
        transformed = transformed.transform({
          ...(spec.width !== undefined ? { width: spec.width } : {}),
          ...(spec.height !== undefined ? { height: spec.height } : {}),
          ...(spec.fit ? { fit: spec.fit } : {}),
        });
      }
      const out = await transformed.output({ format: attempt.mime as ImageOutputOptions["format"], quality: attempt.quality });
      // The ETag names the format actually served, so a fallback never shares a tag with the format it replaced.
      const headers = i === 0 ? common : { ...common, etag: `"${id.slice(0, 32)}-${baseName}.${attempt.mime.slice(6)}"` };
      return out.response({ headers });
    } catch (e) {
      console.error("transform failed", spec.tag, attempt.mime, e instanceof Error ? e.message : String(e));
    }
  }
  return err(502, "transformation failed");
}

// ---- GET /meta/:id, DELETE /i/:id -------------------------------------------
async function meta(request: Request, env: Env, id: string): Promise<Response> {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const head = await env.BUCKET.head(origKey(id));
  if (!head) return err(404, "not found");
  return json({
    id,
    bytes: head.size,
    contentType: head.httpMetadata?.contentType,
    uploaded: head.uploaded.toISOString(),
    ...head.customMetadata,
  });
}

async function remove(request: Request, env: Env, id: string): Promise<Response> {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const head = await env.BUCKET.head(origKey(id));
  if (!head) return err(404, "not found");
  await env.BUCKET.delete(origKey(id));
  // Transformed copies may remain in edge caches until max-age expires or you purge them.
  return json({ deleted: id });
}

// ---- Router -----------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/health") return json({ ok: true });
      if (path === "/upload") {
        return request.method === "POST" ? await upload(request, env) : err(405, "use POST");
      }
      const m = /^\/(i|meta)\/([^/]+)$/.exec(path);
      if (m) {
        const [, kind, id] = m;
        if (!ID_RE.test(id)) return err(404, "not found");
        if (kind === "i" && (request.method === "GET" || request.method === "HEAD")) return await serve(request, env, id);
        if (kind === "i" && request.method === "DELETE") return await remove(request, env, id);
        if (kind === "meta" && request.method === "GET") return await meta(request, env, id);
        return err(405, "method not allowed");
      }
      return err(404, "not found");
    } catch (e) {
      console.error("unhandled", e instanceof Error ? e.message : String(e));
      return err(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
