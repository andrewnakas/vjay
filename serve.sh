#!/usr/bin/env bash
# VJay dev server. localhost is a secure context, so getUserMedia /
# getDisplayMedia / WebMIDI all work without TLS.
#
# Serves everything no-store. Chrome caches ES modules aggressively, and a
# half-cached module graph - a new main.js against a stale setlist.js - fails in
# ways that look like application bugs. Not worth debugging twice.
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "VJay  ->  http://localhost:$PORT"
echo "        ->  http://localhost:$PORT/?test=1   (synthetic audio, no mic needed)"
exec python3 - "$PORT" <<'PY'
import sys, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def send_header(self, key, value):
        # Drop the validators outright; with these absent Chrome cannot serve a
        # module from its memory cache without asking.
        if key.lower() in ('last-modified', 'etag'):
            return
        super().send_header(key, value)

class Server(ThreadingHTTPServer):
    # One stalled keep-alive connection used to block the whole server: the
    # plain HTTPServer handles one at a time, so a browser tab that went away
    # without closing cleanly left the app unreachable while the process still
    # looked healthy and still held the port. Threads, and daemon threads so
    # Ctrl-C actually exits.
    daemon_threads = True
    allow_reuse_address = True

port = int(sys.argv[1])
Server(('127.0.0.1', port), Handler).serve_forever()
PY
