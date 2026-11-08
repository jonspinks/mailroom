// Serves the page the way the app loads it: index.html, styles.css and
// app.js, under the same Content Security Policy Tauri applies. Tauri adds a
// hash for each inline script; this does the same.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));

function csp(html) {
  const policy = Object.assign({}, conf.app.security.csp);
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
  policy["script-src"] = [policy["script-src"], ...hashes].join(" ");
  return Object.entries(policy).map(([k, v]) => `${k} ${v}`).join("; ");
}

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript" };

export function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      if (!["index.html", "styles.css", "app.js", "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs", "vendor/pdfjs/jbig2_nowasm_fallback.js", "vendor/pdfjs/openjpeg_nowasm_fallback.js"].includes(name)) {
        res.writeHead(404);
        return res.end();
      }
      const body = fs.readFileSync(path.join(root, name), "utf8");
      const headers = { "Content-Type": types[path.extname(name)] + "; charset=utf-8" };
      if (name === "index.html") headers["Content-Security-Policy"] = csp(body);
      res.writeHead(200, headers);
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/index.html` }));
  });
}
