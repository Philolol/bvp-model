import http from 'http';
import path from 'path';
import fs from 'fs';
import url from 'url';

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const ROOT = process.cwd();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers={}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

function serveFile(res, filepath) {
  fs.readFile(filepath, (err, buf) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filepath).toLowerCase();
    const type = types[ext] || 'application/octet-stream';
    send(res, 200, buf, { 'Content-Type': type });
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '/');
  let pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname === '/') pathname = '/web/index.html';

  // Prevent path traversal
  const safePath = path.normalize(path.join(ROOT, pathname));
  if (!safePath.startsWith(ROOT)) {
    send(res, 400, 'Bad path');
    return;
  }

  fs.stat(safePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      // If directory, try index.html
      const idx = path.join(safePath, 'index.html');
      return fs.stat(idx, (e2, st2) => {
        if (!e2 && st2.isFile()) return serveFile(res, idx);
        send(res, 403, 'Forbidden');
      });
    }
    if (!err && stat.isFile()) return serveFile(res, safePath);
    send(res, 404, 'Not found');
  });
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}/web/`);
});

