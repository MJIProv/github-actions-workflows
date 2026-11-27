#!/usr/bin/env bash
# End-to-end smoke test for image-service. Starts `wrangler dev --local` in the background,
# drives it with curl (upload, dedupe, original, transforms, error cases, delete), then stops it.
# Run from anywhere:  .claude/skills/run-image-service/smoke.sh      (exit 0 = all checks passed)
# Override the port:  PORT=8801 .claude/skills/run-image-service/smoke.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."          # -> image-service/ (the unit root)
PORT="${PORT:-8799}"
BASE="http://localhost:$PORT"
LOG=/tmp/image-service-dev.log
PNG=/tmp/image-service-test.png
fail=0

# localhost must not go through any egress proxy
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
export NO_PROXY=localhost,127.0.0.1

cleanup() {
  # wrangler spawns node + workerd children; npx does not forward signals, so kill the whole group
  [ -n "${WPID:-}" ] && kill -- -"$WPID" 2>/dev/null
  rm -f .dev.vars
  rm -rf .wrangler
}
trap cleanup EXIT

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1  (expected '$2', got '$3')"; fail=1; fi
}

[ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error

# A real 640x480 RGB PNG, generated with node's zlib (no image tools needed)
node --input-type=module -e "
import {crc32,deflateSync} from 'node:zlib'; import {writeFileSync} from 'node:fs';
const w=640,h=480;
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td));return Buffer.concat([l,td,c])};
const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
const rows=[];for(let y=0;y<h;y++){const r=Buffer.alloc(1+w*3);for(let x=0;x<w;x++){r[1+x*3]=x%256;r[2+x*3]=y%256;r[3+x*3]=(x+y)%256}rows.push(r)}
writeFileSync('$PNG',Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ih),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]));
"

TOKEN=$(openssl rand -hex 32)               # must be >= 32 chars or writes return 503
printf 'UPLOAD_TOKEN=%s\n' "$TOKEN" > .dev.vars

setsid npx wrangler dev --local --port "$PORT" > "$LOG" 2>&1 &
WPID=$!                                    # setsid makes this the process-group leader
for _ in $(seq 1 90); do
  curl -sf "$BASE/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$BASE/health" > /dev/null || { echo "server did not start; see $LOG"; tail -20 "$LOG"; exit 1; }
echo "server up on $BASE (log: $LOG)"

AUTH=(-H "authorization: Bearer $TOKEN")
check "upload without token -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @$PNG -H 'content-type: image/png' $BASE/upload)"

R=$(curl -s -w '\n%{http_code}' -X POST --data-binary @$PNG "${AUTH[@]}" -H 'content-type: image/png' -H 'x-filename: test.png' $BASE/upload)
check "upload -> 201" 201 "$(echo "$R" | tail -1)"
J=$(echo "$R" | head -1)
ID=$(echo "$J" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
check "upload reports 640x480" "640x480" "$(echo "$J" | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));j.width+'x'+j.height")"

R2=$(curl -s -w '\n%{http_code}' -X POST --data-binary @$PNG "${AUTH[@]}" $BASE/upload)
check "re-upload dedupes -> 200 existed:true" "200 true" "$(echo "$R2" | tail -1) $(echo "$R2" | head -1 | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).existed")"

curl -s -o /tmp/image-service-orig.png "$BASE/i/$ID"
cmp -s "$PNG" /tmp/image-service-orig.png && o=identical || o=different
check "original is byte-identical" identical "$o"

check "?w=256&f=webp -> image/webp" "200 image/webp" "$(curl -s -o /tmp/image-service-w256.webp -w '%{http_code} %{content_type}' "$BASE/i/$ID?w=256&f=webp")"
check "?v=thumb&f=jpeg -> image/jpeg" "200 image/jpeg" "$(curl -s -o /tmp/image-service-thumb.jpg -w '%{http_code} %{content_type}' "$BASE/i/$ID?v=thumb&f=jpeg")"
if command -v file >/dev/null; then
  check "256w WebP is 256x192" "256x192" "$(file /tmp/image-service-w256.webp | grep -oE '[0-9]+x[0-9]+' | head -1)"
  check "thumb is 160x160" "160x160" "$(file /tmp/image-service-thumb.jpg | grep -oE '[0-9]+x[0-9]+' | tail -1)"
fi
check "unquantised width -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID?w=999")"
check "SVG upload -> 415" 415 "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary '<svg xmlns="http://www.w3.org/2000/svg"/>' "${AUTH[@]}" -H 'content-type: image/svg+xml' $BASE/upload)"
check "meta without token -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' $BASE/meta/$ID)"
check "meta with token -> 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" $BASE/meta/$ID)"
check "delete -> 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${AUTH[@]}" $BASE/i/$ID)"
check "GET after delete -> 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' $BASE/i/$ID)"

[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
