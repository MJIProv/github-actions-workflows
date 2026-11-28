// Pure helpers. No Workers-only APIs here, so they run under plain Node for tests.

export type ImageKind = "jpeg" | "png" | "gif" | "webp" | "avif";

export const MIME: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

// SVG is deliberately NOT accepted: it can carry script and would be served from our origin.
// Detection is by magic bytes, never by the client's Content-Type or file name.
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    // ISO-BMFF: major brand at 8..12, compatible brands follow in the box.
    const boxSize = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
    const end = Math.min(b.length, boxSize > 8 ? boxSize : 32, 64);
    for (let i = 8; i + 4 <= end; i += 4) {
      const brand = ascii(i, i + 4);
      if (brand === "avif" || brand === "avis") return "avif";
    }
  }
  return null;
}

// ---- Transform parameters ---------------------------------------------------
// Every distinct (variant|width) x format is a separate billable "unique transformation".
// Free-form w/h/q would let anyone mint unlimited combinations, so inputs are quantised.

export const VARIANTS = {
  thumb: { width: 160, height: 160, fit: "cover" },
  card: { width: 480, fit: "scale-down" },
  hero: { width: 1280, fit: "scale-down" },
  full: { width: 2560, fit: "scale-down" },
} as const;
export type VariantName = keyof typeof VARIANTS;

export const WIDTH_LADDER = [64, 128, 256, 320, 480, 640, 800, 1024, 1280, 1600, 1920, 2560] as const;
export const OUT_FORMATS = ["auto", "webp", "avif", "jpeg", "png", "gif"] as const;
export type OutFormat = (typeof OUT_FORMATS)[number];

export interface TransformSpec {
  /** Stable text for ETag / logging, e.g. "card.webp". */
  tag: string;
  /** Absent for a format-only change: the pixel size is left alone. */
  width?: number;
  height?: number;
  fit?: "scale-down" | "cover";
  /** Concrete output MIME type after negotiation. */
  mime: string;
  quality: number;
  /** True when the output depends on the Accept header. */
  varyAccept: boolean;
}

export type ParseResult =
  | { ok: true; spec: TransformSpec | null }
  | { ok: false; error: string };

/** Returns spec=null when no transform was requested (serve the original bytes untouched). */
export function parseTransform(params: URLSearchParams, accept: string | null, source: ImageKind): ParseResult {
  const known = new Set(["v", "w", "f"]);
  for (const k of params.keys()) {
    if (!known.has(k)) return { ok: false, error: `unknown parameter "${k}"; allowed: v, w, f` };
  }
  const v = params.get("v");
  const w = params.get("w");
  const f = params.get("f");
  if (v !== null && w !== null) return { ok: false, error: "use either v or w, not both" };
  if (v === null && w === null && f === null) return { ok: true, spec: null };

  let base: { width?: number; height?: number; fit?: "scale-down" | "cover" };
  let name: string;
  if (v !== null) {
    if (!Object.hasOwn(VARIANTS, v)) {
      return { ok: false, error: `unknown variant; allowed: ${Object.keys(VARIANTS).join(", ")}` };
    }
    base = { ...VARIANTS[v as VariantName] };
    name = v;
  } else if (w !== null) {
    const n = Number(w);
    if (!Number.isInteger(n) || !(WIDTH_LADDER as readonly number[]).includes(n)) {
      return { ok: false, error: `w must be one of ${WIDTH_LADDER.join(", ")}` };
    }
    base = { width: n, fit: "scale-down" };
    name = `w${n}`;
  } else {
    // Format change only: no resize at all, so the output keeps the original pixel size.
    base = {};
    name = "orig";
  }

  const fmt = (f ?? "auto") as OutFormat;
  if (!OUT_FORMATS.includes(fmt)) return { ok: false, error: `f must be one of ${OUT_FORMATS.join(", ")}` };

  const mime = fmt === "auto" ? negotiate(accept, source) : `image/${fmt}`;
  return {
    ok: true,
    spec: {
      tag: `${name}.${fmt === "auto" ? mime.slice(6) : fmt}`,
      ...base,
      mime,
      quality: mime === "image/avif" ? 60 : 80,
      varyAccept: fmt === "auto",
    },
  };
}

/** Media types an Accept header names with q > 0. `q=0` means "not acceptable". Wildcards are ignored on purpose. */
export function acceptedTypes(accept: string | null): Set<string> {
  const ok = new Set<string>();
  for (const part of (accept ?? "").toLowerCase().split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    if (!type) continue;
    const qParam = params.map((p) => /^q=(\d*\.?\d+)$/.exec(p)).find(Boolean);
    const q = qParam ? Number(qParam[1]) : 1;
    if (q > 0) ok.add(type);
  }
  return ok;
}

/** The type used when the client accepts neither AVIF nor WebP. Never flattens alpha or animation into a JPEG. */
const legacyMime = (source: ImageKind) => (source === "jpeg" ? MIME.jpeg : source === "gif" ? MIME.gif : MIME.png);

export function negotiate(accept: string | null, source: ImageKind): string {
  const a = acceptedTypes(accept);
  // Animated sources: Images keeps animation for WebP and GIF output (anim defaults to true),
  // but AVIF/PNG/JPEG output is a still. Never pick a still format for a GIF on our own.
  if (source === "gif") return a.has("image/webp") ? MIME.webp : MIME.gif;
  if (a.has("image/avif")) return MIME.avif;
  if (a.has("image/webp")) return MIME.webp;
  return legacyMime(source);
}

/** Formats to try, in order, when the negotiated output fails. Only used for f=auto, never for an explicit f. */
export function fallbackMimes(mime: string, accept: string | null, source: ImageKind): string[] {
  const a = acceptedTypes(accept);
  const legacy = legacyMime(source);
  if (mime === MIME.avif) return [...(a.has("image/webp") ? [MIME.webp] : []), legacy];
  if (mime === MIME.webp) return [legacy];
  return [];
}

// ---- Auth and hashing -------------------------------------------------------

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings (compares fixed-length digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function bearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

export const ID_RE = /^[a-f0-9]{64}$/;

/** Strip path parts and control characters; keep it short. Stored only as metadata. */
export function safeName(name: string | null | undefined): string {
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
}

/** RFC 9110 If-None-Match: `*`, a comma-separated list, and weak (`W/`) tags all count. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const want = etag.replace(/^W\//, "");
  return header.split(",").some((raw) => {
    const t = raw.trim();
    return t === "*" || t.replace(/^W\//, "") === want;
  });
}

/**
 * Read a request body but stop as soon as `limit` bytes are exceeded, so an oversized chunked
 * upload is never fully buffered. Returns null when the limit is exceeded.
 */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
