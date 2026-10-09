#!/usr/bin/env python3
"""Mock Qwen Token Plan endpoint for testing pi-qtools' enable_search injection guard.

Serves /v1/chat/completions (SSE) and records every request body to a JSONL log so a
test can assert whether the extension injected enable_search for a given model id.

Rejection rules (mirrors what the real plan does to models that lack the capability):
  - REJECT_ALWAYS ids never accept enable_search        (glm-5.2 / glm-5.3 behaviour)
  - REJECT_ONCE  ids reject it the FIRST time, then accept it (simulates a wrong
                     family guess, which is what the runtime self-heal must catch)
Everything else accepts enable_search.

Usage: mock_endpoint.py --port 8799 --log /tmp/qtools-mock.jsonl [--reject-always a,b]
       [--reject-once c] [--reset]                      # --reset clears the seen-state
"""
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"seen": set(), "lock": threading.Lock()}


def sse(self_model, text):
    def chunk(delta, finish=None):
        return "data: " + json.dumps({
            "id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": int(time.time()),
            "model": self_model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }) + "\n\n"

    return (
        chunk({"role": "assistant"})
        + chunk({"content": text})
        + chunk({}, "stop")
        + "data: [DONE]\n\n"
    )


class Handler(BaseHTTPRequestHandler):
    log_file = "/tmp/qtools-mock.jsonl"
    reject_always = set()
    reject_once = set()

    def log_message(self, *a):  # quiet
        pass

    def _record(self, body, rejected):
        with open(self.log_file, "a") as f:
            f.write(json.dumps({
                "ts": time.time(), "model": body.get("model"),
                "enable_search": body.get("enable_search"),
                "search_strategy": (body.get("search_options") or {}).get("search_strategy"),
                "rejected": rejected,
            }) + "\n")

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        model = body.get("model", "")
        injected = body.get("enable_search") is True

        rejected = False
        if injected:
            if model in self.reject_always:
                rejected = True
            elif model in self.reject_once:
                with STATE["lock"]:
                    if model not in STATE["seen"]:
                        STATE["seen"].add(model)
                        rejected = True

        self._record(body, rejected)

        if rejected:
            payload = json.dumps({"error": {
                "code": "invalid_parameter_error", "param": None, "type": "invalid_request_error",
                "message": "This model does not support enable_search."}}).encode()
            self.send_response(400)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        out = sse(model, "MOCK-OK " + model).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8799)
    p.add_argument("--log", default="/tmp/qtools-mock.jsonl")
    p.add_argument("--reject-always", default="glm-5.2,glm-5.3")
    p.add_argument("--reject-once", default="")
    p.add_argument("--reset", action="store_true")
    a = p.parse_args()
    Handler.log_file = a.log
    Handler.reject_always = {s for s in a.reject_always.split(",") if s}
    Handler.reject_once = {s for s in a.reject_once.split(",") if s}
    if a.reset and hasattr(__import__("os"), "remove") and __import__("os").path.exists(a.log):
        __import__("os").remove(a.log)
    print("mock on 127.0.0.1:%d reject_always=%s reject_once=%s" % (a.port, sorted(Handler.reject_always), sorted(Handler.reject_once)), flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
