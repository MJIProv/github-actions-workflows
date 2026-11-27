#!/usr/bin/env bash
# Start or stop a local image-service dev server for manual curl work.
#   .claude/skills/run-image-service/serve.sh start   # writes /tmp/image-service.token, waits for /health
#   .claude/skills/run-image-service/serve.sh stop    # kills the whole wrangler/workerd process group
# Port: PORT (default 8799). Log: /tmp/image-service-dev.log
set -uo pipefail
cd "$(dirname "$0")/../../.."
PORT="${PORT:-8799}"
PIDFILE=/tmp/image-service.pid
STATE=/tmp/image-service-state
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
export NO_PROXY=localhost,127.0.0.1

case "${1:-}" in
  start)
    [ -f "$PIDFILE" ] && { echo "already started (pid file $PIDFILE); run stop first"; exit 1; }
    [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error
    openssl rand -hex 32 > /tmp/image-service.token          # must be >= 32 chars or writes return 503
    mkdir -p "$STATE"
    # --var / --persist-to: never writes .dev.vars or touches .wrangler/ (a developer's own files)
    setsid npx wrangler dev --local --port "$PORT" --var "UPLOAD_TOKEN:$(cat /tmp/image-service.token)" --persist-to "$STATE" > /tmp/image-service-dev.log 2>&1 &
    echo $! > "$PIDFILE"                                      # in a script, setsid does not fork: $! is the group leader
    for _ in $(seq 1 90); do curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
    if ! curl -sf "http://localhost:$PORT/health"; then
      echo "did not start; see /tmp/image-service-dev.log"
      kill -- -"$(cat "$PIDFILE")" 2>/dev/null; rm -rf "$PIDFILE" /tmp/image-service.token "$STATE"   # no stale state after a failed start
      exit 1
    fi
    echo; echo "up on http://localhost:$PORT   token in /tmp/image-service.token"
    ;;
  stop)
    [ -f "$PIDFILE" ] && kill -- -"$(cat "$PIDFILE")" 2>/dev/null
    rm -rf "$PIDFILE" /tmp/image-service.token "$STATE"
    echo stopped
    ;;
  *) echo "usage: $0 start|stop"; exit 2 ;;
esac
