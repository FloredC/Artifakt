#!/usr/bin/env python3
"""
Local proxy server for Artefakt.
- Serves static files from this directory.
- /replicate/*  → forwards to api.replicate.com (artist style generation)
- /scaffold     → calls fal.ai, then runs Variant C contour reduction (OpenCV)
                  and returns the processed PNG directly to the browser.
"""
import http.server, urllib.request, urllib.error, json, os, io
import numpy as np
import cv2

REPLICATE_API_KEY = 'r8_07imA81wsUqdYtaw5XowkS9VjytYtZJ1ksjmc'
FAL_API_KEY       = '77e88931-c234-44b4-b4d0-3181195a2730:13035cfa73c8fce02b49cbc6aa2d43e5'
PORT = 8080


def variant_c(img_bytes):
    """Exact Variant C pipeline from Experiment 006b: 50% reduction by area."""
    arr     = np.frombuffer(img_bytes, dtype=np.uint8)
    img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    gray    = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    h, w    = gray.shape
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    edges   = cv2.Canny(blurred, threshold1=20, threshold2=60)
    kernel  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    edges   = cv2.dilate(edges, kernel, iterations=1)
    edges   = cv2.erode(edges,  kernel, iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contours_sorted = sorted(contours, key=cv2.contourArea, reverse=True)
    n_keep  = max(1, int(len(contours_sorted) * 0.50))
    canvas  = np.full((h, w), 255, dtype=np.uint8)
    cv2.drawContours(canvas, contours_sorted[:n_keep], -1, 0, 1)
    _, png_buf = cv2.imencode('.png', canvas)
    return png_buf.tobytes()


def fal_generate(prompt):
    """Call fal-ai/flux/schnell and return raw image bytes."""
    payload = json.dumps({
        'prompt': prompt,
        'num_inference_steps': 2,
        'image_size': 'portrait_4_3',
        'num_images': 1
    }).encode()
    req = urllib.request.Request(
        'https://fal.run/fal-ai/flux/schnell',
        data=payload,
        headers={
            'Authorization': f'Key {FAL_API_KEY}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    img_url = data['images'][0]['url']
    with urllib.request.urlopen(img_url, timeout=30) as resp:
        return resp.read()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        # ── /scaffold — fal.ai + Variant C contour reduction ──────────────
        if self.path == '/scaffold':
            length = int(self.headers.get('Content-Length', 0))
            body   = json.loads(self.rfile.read(length))
            prompt = body.get('prompt', '')
            print(f'[scaffold] prompt length={len(prompt)}', flush=True)
            try:
                img_bytes = fal_generate(prompt)
                png_bytes = variant_c(img_bytes)
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(png_bytes)))
                self.end_headers()
                self.wfile.write(png_bytes)
                print(f'[scaffold] done — {len(png_bytes)} bytes', flush=True)
            except Exception as e:
                print(f'[scaffold] ERROR: {e}', flush=True)
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
            return

        # ── /replicate/* — artist style generation ────────────────────────
        if self.path.startswith('/replicate'):
            target_path = self.path[len('/replicate'):]
            url    = f'https://api.replicate.com{target_path}'
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            req    = urllib.request.Request(url, data=body, method='POST')
            req.add_header('Authorization', f'Token {REPLICATE_API_KEY}')
            req.add_header('Content-Type', 'application/json')
            try:
                with urllib.request.urlopen(req) as resp:
                    data = resp.read()
                    self.send_response(resp.status)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(data)
            except urllib.error.HTTPError as e:
                data = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith('/replicate'):
            target_path = self.path[len('/replicate'):]
            url = f'https://api.replicate.com{target_path}'
            req = urllib.request.Request(url)
            req.add_header('Authorization', f'Token {REPLICATE_API_KEY}')
            try:
                with urllib.request.urlopen(req) as resp:
                    data = resp.read()
                    self.send_response(resp.status)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(data)
            except urllib.error.HTTPError as e:
                data = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
            return
        super().do_GET()

    def log_message(self, format, *args):
        first = str(args[0]) if args else ''
        if '/replicate' in first or '/scaffold' in first:
            super().log_message(format, *args)


os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f'Artefakt proxy running at http://localhost:{PORT}')
http.server.HTTPServer.allow_reuse_address = True
http.server.HTTPServer(('', PORT), Handler).serve_forever()
