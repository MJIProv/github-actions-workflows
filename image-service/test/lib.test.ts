import { test } from "node:test";
import assert from "node:assert/strict";
import { bearer, negotiate, parseTransform, safeEqual, safeName, sha256Hex, sniffImage } from "../src/lib.ts";

const bytes = (...n: number[]) => Uint8Array.from(n);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

test("sniffImage: accepts the five allowed formats by magic bytes", () => {
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1)), "jpeg");
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d)), "png");
  assert.equal(sniffImage(bytes(...ascii("GIF89a"), 1, 0, 1, 0, 0, 0)), "gif");
  assert.equal(sniffImage(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 "))), "webp");
  // AVIF: size(4) 'ftyp' major brand 'avif' + minor + compatible brands
  assert.equal(sniffImage(bytes(0, 0, 0, 0x1c, ...ascii("ftyp"), ...ascii("avif"), 0, 0, 0, 0, ...ascii("mif1"), ...ascii("avif"))), "avif");
  assert.equal(sniffImage(bytes(0, 0, 0, 0x1c, ...ascii("ftyp"), ...ascii("mif1"), 0, 0, 0, 0, ...ascii("avis"), ...ascii("miaf"))), "avif");
});

test("sniffImage: rejects SVG, HTML, HEIC, PDF, truncated and empty input", () => {
  const svg = bytes(...ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  assert.equal(sniffImage(svg), null);
  assert.equal(sniffImage(bytes(...ascii("<!doctype html><script>alert(1)</script>"))), null);
  assert.equal(sniffImage(bytes(0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii("heic"), 0, 0, 0, 0, ...ascii("mif1"))), null);
  assert.equal(sniffImage(bytes(...ascii("%PDF-1.7\n%âãÏÓ"))), null);
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff)), null);
  assert.equal(sniffImage(new Uint8Array()), null);
});

test("parseTransform: no params means serve the original", () => {
  assert.deepEqual(parseTransform(new URLSearchParams(), null, "png"), { ok: true, spec: null });
});

test("parseTransform: variants map to fixed sizes", () => {
  const r = parseTransform(new URLSearchParams("v=thumb&f=webp"), null, "jpeg");
  assert.ok(r.ok && r.spec);
  assert.deepEqual([r.spec.width, r.spec.height, r.spec.fit, r.spec.mime], [160, 160, "cover", "image/webp"]);
  assert.equal(r.spec.varyAccept, false);
  assert.equal(r.spec.tag, "thumb.webp");
});

test("parseTransform: widths are quantised to the ladder", () => {
  const ok = parseTransform(new URLSearchParams("w=800"), "image/webp", "jpeg");
  assert.ok(ok.ok && ok.spec && ok.spec.width === 800 && ok.spec.mime === "image/webp" && ok.spec.varyAccept);
  for (const bad of ["801", "0", "-5", "1e3", "abc", "99999", "800.5", ""]) {
    const r = parseTransform(new URLSearchParams({ w: bad }), null, "jpeg");
    assert.equal(r.ok, false, `w=${bad} must be rejected`);
  }
});

test("parseTransform: rejects unknown params, bad variant, bad format, v+w together", () => {
  assert.equal(parseTransform(new URLSearchParams("q=90&w=800"), null, "png").ok, false);
  assert.equal(parseTransform(new URLSearchParams("h=100"), null, "png").ok, false);
  assert.equal(parseTransform(new URLSearchParams("v=nope"), null, "png").ok, false);
  assert.equal(parseTransform(new URLSearchParams("v=__proto__"), null, "png").ok, false);
  assert.equal(parseTransform(new URLSearchParams("v=card&f=svg"), null, "png").ok, false);
  assert.equal(parseTransform(new URLSearchParams("v=card&w=800"), null, "png").ok, false);
});

test("parseTransform: format-only request keeps size and does not upscale", () => {
  const r = parseTransform(new URLSearchParams("f=avif"), null, "png");
  assert.ok(r.ok && r.spec);
  assert.equal(r.spec.fit, "scale-down");
  assert.equal(r.spec.mime, "image/avif");
  assert.equal(r.spec.quality, 60);
});

test("negotiate: avif beats webp beats legacy fallback", () => {
  assert.equal(negotiate("image/avif,image/webp,*/*", "png"), "image/avif");
  assert.equal(negotiate("image/webp,*/*", "jpeg"), "image/webp");
  assert.equal(negotiate("*/*", "jpeg"), "image/jpeg");
  assert.equal(negotiate(null, "png"), "image/png");
  assert.equal(negotiate("text/html", "gif"), "image/png");
});

test("sha256Hex matches the published test vector for 'abc'", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("safeEqual and bearer", async () => {
  assert.equal(await safeEqual("same-token", "same-token"), true);
  assert.equal(await safeEqual("same-token", "same-tokeN"), false);
  assert.equal(await safeEqual("short", "a-much-longer-token-value"), false);
  assert.equal(bearer("Bearer abc123"), "abc123");
  assert.equal(bearer("bearer abc123"), "abc123");
  assert.equal(bearer("Basic abc123"), null);
  assert.equal(bearer("Bearer"), null);
  assert.equal(bearer(null), null);
});

test("safeName strips paths and control characters", () => {
  assert.equal(safeName("C:\\Users\\me\\cat.png"), "cat.png");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("a\u0000b\nc.png"), "abc.png");
  assert.equal(safeName(null), "");
  assert.equal(safeName("x".repeat(500)).length, 120);
});
