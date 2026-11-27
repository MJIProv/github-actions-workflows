// Exercises the real request handler against in-memory fakes for R2 and the Images binding.
// The fakes only model the surface this Worker uses. See README for what they cannot prove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import worker from "../src/index.ts";
import type { Env } from "../src/index.ts";

const TOKEN = "t".repeat(40);
const BASE = "https://img.example";

function pngBytes(w = 4, h = 4): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

function makeEnv(overrides: Partial<Env> = {}) {
  const store = new Map<string, { body: Uint8Array; httpMetadata: any; customMetadata: Record<string, string> }>();
  const calls = { put: 0, transforms: [] as any[], outputs: [] as any[] };
  const objMeta = (k: string) => {
    const o = store.get(k)!;
    return {
      key: k,
      size: o.body.length,
      uploaded: new Date("2026-11-27T00:00:00Z"),
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      writeHttpMetadata(h: Headers) {
        if (o.httpMetadata?.contentType) h.set("content-type", o.httpMetadata.contentType);
      },
    };
  };
  const BUCKET = {
    async head(k: string) {
      return store.has(k) ? objMeta(k) : null;
    },
    async get(k: string) {
      return store.has(k) ? { ...objMeta(k), body: new Blob([store.get(k)!.body]).stream() } : null;
    },
    async put(k: string, v: Uint8Array, o: any) {
      calls.put++;
      store.set(k, { body: v, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
    },
    async delete(k: string) {
      store.delete(k);
    },
  };
  const IMAGES = {
    async info(stream: ReadableStream) {
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      if (buf.length > 24 && buf[0] === 0x89) {
        const dv = new DataView(buf.buffer, buf.byteOffset);
        return { format: "image/png", fileSize: buf.length, width: dv.getUint32(16), height: dv.getUint32(20) };
      }
      throw new Error("ERROR 9412: not decodable");
    },
    input(_s: ReadableStream) {
      const h: any = {
        transform(t: any) {
          calls.transforms.push(t);
          return h;
        },
        async output(o: any) {
          calls.outputs.push(o);
          return {
            response: ({ headers }: any = {}) =>
              new Response("TRANSFORMED", { headers: { ...headers, "content-type": o.format } }),
          };
        },
      };
      return h;
    },
  };
  const env = { BUCKET, IMAGES, UPLOAD_TOKEN: TOKEN, ...overrides } as unknown as Env;
  return { env, store, calls };
}

const auth = { authorization: `Bearer ${TOKEN}` };
const countingStream = (chunkSize: number, chunks: number) => {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= chunks) return c.close();
      sent++;
      c.enqueue(new Uint8Array(chunkSize).fill(1));
    },
  });
  return { stream, sent: () => sent };
};
const call = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, init), env);
const rawUpload = (env: Env, body: BodyInit, headers: Record<string, string> = {}) =>
  call(env, "/upload", { method: "POST", body, headers: { ...auth, "content-type": "image/png", ...headers } });

test("upload requires a valid bearer token", async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, "/upload", { method: "POST", body: pngBytes() })).status, 401);
  assert.equal(
    (await call(env, "/upload", { method: "POST", body: pngBytes(), headers: { authorization: "Bearer wrong" } })).status,
    401,
  );
});

test("upload fails closed when the secret is missing or too short", async () => {
  for (const UPLOAD_TOKEN of ["", "short"]) {
    const { env } = makeEnv({ UPLOAD_TOKEN });
    const r = await call(env, "/upload", { method: "POST", body: pngBytes(), headers: { authorization: `Bearer ${UPLOAD_TOKEN}` } });
    assert.equal(r.status, 503);
  }
});

test("upload stores a PNG content-addressed and reports dimensions", async () => {
  const { env, store, calls } = makeEnv();
  const bytes = pngBytes(7, 3);
  const r = await rawUpload(env, bytes, { "x-filename": "../dir/cat.png" });
  assert.equal(r.status, 201);
  const j: any = await r.json();
  assert.match(j.id, /^[a-f0-9]{64}$/);
  assert.deepEqual([j.kind, j.width, j.height, j.existed, j.bytes], ["png", 7, 3, false, bytes.length]);
  assert.equal(j.url, `${BASE}/i/${j.id}`);
  const stored = store.get(`orig/${j.id}`)!;
  assert.equal(stored.httpMetadata.contentType, "image/png");
  assert.equal(stored.customMetadata.name, "cat.png");
  assert.equal(calls.put, 1);
});

test("uploading identical bytes twice dedupes and does not write again", async () => {
  const { env, calls } = makeEnv();
  const bytes = pngBytes();
  const a: any = await (await rawUpload(env, bytes)).json();
  const second = await rawUpload(env, bytes);
  const b: any = await second.json();
  assert.equal(second.status, 200);
  assert.equal(b.id, a.id);
  assert.equal(b.existed, true);
  assert.equal(calls.put, 1);
});

// Real clients send Content-Length for multipart; a bare Request(FormData) in a test does not.
async function multipartUpload(env: Env, fd: FormData) {
  const enc = new Response(fd);
  const ct = enc.headers.get("content-type")!;
  const buf = new Uint8Array(await enc.arrayBuffer());
  return call(env, "/upload", {
    method: "POST",
    body: buf,
    headers: { ...auth, "content-type": ct, "content-length": String(buf.length) },
  });
}

test("upload accepts multipart/form-data with a 'file' field", async () => {
  const { env } = makeEnv();
  const fd = new FormData();
  fd.set("file", new File([pngBytes()], "photo.png", { type: "image/png" }));
  const r = await multipartUpload(env, fd);
  assert.equal(r.status, 201);
  assert.equal(((await r.json()) as any).kind, "png");
  const missing = new FormData();
  missing.set("other", "x");
  assert.equal((await multipartUpload(env, missing)).status, 400);
});

test("upload rejects SVG, HTML, empty, oversize and undecodable bodies", async () => {
  const { env } = makeEnv({ MAX_UPLOAD_BYTES: "2048" });
  assert.equal((await rawUpload(env, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', { "content-type": "image/svg+xml" })).status, 415);
  assert.equal((await rawUpload(env, "<html><body>hi</body></html>", { "content-type": "image/png" })).status, 415);
  assert.equal((await rawUpload(env, new Uint8Array())).status, 400);
  assert.equal((await rawUpload(env, new Uint8Array(5000))).status, 413);
  // Valid magic bytes, garbage body: the decoder step must catch it.
  const fake = new Uint8Array(64);
  fake.set([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal((await rawUpload(env, fake, { "content-type": "image/jpeg" })).status, 422);
});

test("GET original streams stored bytes with safe headers and supports If-None-Match", async () => {
  const { env, calls } = makeEnv();
  const bytes = pngBytes();
  const { id }: any = await (await rawUpload(env, bytes)).json();
  const r = await call(env, `/i/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("cache-control")!, /public, max-age=\d+/);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
  assert.equal(calls.transforms.length, 0, "no Images call for originals");
  const etag = r.headers.get("etag")!;
  assert.equal((await call(env, `/i/${id}`, { headers: { "if-none-match": etag } })).status, 304);
});

test("GET with a variant transforms via the Images binding and negotiates format", async () => {
  const { env, calls } = makeEnv();
  const { id }: any = await (await rawUpload(env, pngBytes())).json();
  const r = await call(env, `/i/${id}?v=card`, { headers: { accept: "image/avif,image/webp,*/*" } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "TRANSFORMED");
  assert.equal(r.headers.get("vary"), "Accept");
  assert.deepEqual(calls.transforms[0], { width: 480, fit: "scale-down" });
  assert.deepEqual(calls.outputs[0], { format: "image/avif", quality: 60 });
  const explicit = await call(env, `/i/${id}?v=thumb&f=jpeg`);
  assert.equal(explicit.headers.get("vary"), null);
  assert.deepEqual(calls.transforms[1], { width: 160, height: 160, fit: "cover" });
  assert.deepEqual(calls.outputs[1], { format: "image/jpeg", quality: 80 });
});

test("GET rejects bad transform params before touching Images", async () => {
  const { env, calls } = makeEnv();
  const { id }: any = await (await rawUpload(env, pngBytes())).json();
  for (const q of ["w=801", "v=bogus", "h=99", "f=svg", "v=card&w=800"]) {
    assert.equal((await call(env, `/i/${id}?${q}`)).status, 400, q);
  }
  assert.equal(calls.transforms.length, 0);
});

test("GET unknown or malformed ids return 404", async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, `/i/${"a".repeat(64)}`)).status, 404);
  assert.equal((await call(env, "/i/../../etc/passwd")).status, 404);
  assert.equal((await call(env, "/i/short")).status, 404);
  assert.equal((await call(env, "/i/" + "A".repeat(64))).status, 404);
});

test("transformation failure becomes a generic 502, not a stack trace", async () => {
  const { env } = makeEnv();
  const { id }: any = await (await rawUpload(env, pngBytes())).json();
  (env.IMAGES as any).input = () => {
    throw new Error("secret internals");
  };
  const r = await call(env, `/i/${id}?v=hero`);
  assert.equal(r.status, 502);
  assert.equal(((await r.json()) as any).error, "transformation failed");
});

test("meta and delete require auth; delete removes the object", async () => {
  const { env, store } = makeEnv();
  const { id }: any = await (await rawUpload(env, pngBytes(9, 9))).json();
  assert.equal((await call(env, `/meta/${id}`)).status, 401);
  const m: any = await (await call(env, `/meta/${id}`, { headers: auth })).json();
  assert.deepEqual([m.id, m.width, m.height, m.kind], [id, "9", "9", "png"]);
  assert.equal((await call(env, `/i/${id}`, { method: "DELETE" })).status, 401);
  assert.equal(store.size, 1);
  assert.equal((await call(env, `/i/${id}`, { method: "DELETE", headers: auth })).status, 200);
  assert.equal(store.size, 0);
  assert.equal((await call(env, `/i/${id}`)).status, 404);
});

test("health, wrong methods and unknown routes", async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, "/health")).status, 200);
  assert.equal((await call(env, "/upload")).status, 405);
  assert.equal((await call(env, `/i/${"a".repeat(64)}`, { method: "POST" })).status, 405);
  assert.equal((await call(env, "/nope")).status, 404);
});

test("Range on an original is ignored with a full 200 (no broken 206)", async () => {
  const { env } = makeEnv();
  const bytes = pngBytes();
  const { id }: any = await (await rawUpload(env, bytes)).json();
  for (const range of ["bytes=0-9", "bytes=abc", "bytes=999999-"]) {
    const r = await call(env, `/i/${id}`, { headers: { range } });
    assert.equal(r.status, 200, range);
    assert.equal(r.headers.get("content-range"), null);
    assert.equal((await r.arrayBuffer()).byteLength, bytes.length);
  }
});

test("HEAD never runs a transformation or reads the object body", async () => {
  const { env, calls } = makeEnv();
  const bytes = pngBytes();
  const { id }: any = await (await rawUpload(env, bytes)).json();
  const orig = await call(env, `/i/${id}`, { method: "HEAD" });
  assert.equal(orig.status, 200);
  assert.equal(orig.headers.get("content-type"), "image/png");
  assert.equal(orig.headers.get("content-length"), String(bytes.length));
  assert.equal((await orig.arrayBuffer()).byteLength, 0);
  const t = await call(env, `/i/${id}?v=hero&f=webp`, { method: "HEAD" });
  assert.equal(t.status, 200);
  assert.equal(t.headers.get("content-type"), "image/webp");
  assert.equal(calls.transforms.length, 0);
  assert.equal(calls.outputs.length, 0);
});

test("If-None-Match: weak tag, list and * all produce 304", async () => {
  const { env } = makeEnv();
  const { id }: any = await (await rawUpload(env, pngBytes())).json();
  const etag = (await call(env, `/i/${id}`)).headers.get("etag")!;
  for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
    assert.equal((await call(env, `/i/${id}`, { headers: { "if-none-match": inm } })).status, 304, inm);
  }
  assert.equal((await call(env, `/i/${id}`, { headers: { "if-none-match": '"nope"' } })).status, 200);
});

test("format-only request does not resize: no transform() call, output format applied", async () => {
  const { env, calls } = makeEnv();
  const { id }: any = await (await rawUpload(env, pngBytes())).json();
  const r = await call(env, `/i/${id}?f=webp`);
  assert.equal(r.status, 200);
  assert.equal(calls.transforms.length, 0, "no width or height was applied");
  assert.deepEqual(calls.outputs[0], { format: "image/webp", quality: 80 });
});

test("a chunked upload over the limit is rejected after reading only a little of it", async () => {
  const { env } = makeEnv({ MAX_UPLOAD_BYTES: "1000" });
  const c = countingStream(500, 400); // would be 200 kB if fully read
  const r = await call(env, "/upload", {
    method: "POST",
    body: c.stream,
    headers: { ...auth, "content-type": "image/png" },
    // @ts-expect-error Node's fetch needs duplex for a streaming body
    duplex: "half",
  });
  assert.equal(r.status, 413);
  assert.ok(c.sent() < 50, `read ${c.sent()} of 400 chunks`);
});

test("multipart without a Content-Length is refused (it would be fully buffered)", async () => {
  const { env } = makeEnv();
  const boundary = "----b";
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\nxx\r\n--${boundary}--\r\n`));
      c.close();
    },
  });
  const r = await call(env, "/upload", {
    method: "POST",
    body,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    // @ts-expect-error Node's fetch needs duplex for a streaming body
    duplex: "half",
  });
  assert.equal(r.status, 411);
});
