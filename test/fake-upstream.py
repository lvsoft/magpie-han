from http.server import BaseHTTPRequestHandler, HTTPServer
import json
OUT = "/home/lv/tmp/magpie-han/.upstream.json"

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        b = self.rfile.read(n)
        with open(OUT, "wb") as f:
            f.write(b)
        try:
            req = json.loads(b)
        except Exception:
            req = {}
        text = "這是模型的回覆：頭髮和乾燥的後面。"
        if req.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for i in range(0, len(text), 4):
                ev = {"id": "1", "object": "chat.completion.chunk", "created": 1,
                      "model": req.get("model", "m"),
                      "choices": [{"index": 0, "delta": {"content": text[i:i+4]}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            resp = {"id": "1", "object": "chat.completion", "created": 1,
                    "model": req.get("model", "m"),
                    "choices": [{"index": 0,
                                 "message": {"role": "assistant", "content": text},
                                 "finish_reason": "stop"}]}
            out = json.dumps(resp, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", 18080), H).serve_forever()
