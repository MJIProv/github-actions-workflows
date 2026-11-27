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
export const OUT_FORMATS = ["auto", "webp", "avif", "jpeg", "png"] as const;
export type OutFormat = (typeof OUT_FORMATS)[number];

export interface TransformSpec {
  /** Stable text for ETag / logging, e.g. "card.webp". */
  tag: string;
  width: number;
  height?: number;
  fit: "scale-down" | "cover";
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

  let base: { width: number; height?: number; fit: "scale-down" | "cover" };
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
    // Format change only: keep the pixel size, do not upscale.
    base = { width: WIDTH_LADDER[WIDTH_LADDER.length - 1], fit: "scale-down" };
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

export function negotiate(accept: string | null, source: ImageKind): string {
  const a = (accept ?? "").toLowerCase();
  if (a.includes("image/avif")) return MIME.avif;
  if (a.includes("image/webp")) return MIME.webp;
  // Browsers without webp/avif support: keep a universally supported type.
  return source === "png" || source === "gif" ? MIME.png : MIME.jpeg;
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
