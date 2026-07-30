// Tiny static server used only to preview eval-report.html in a browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', '..', 'eval-report.html');
const PORT = process.env.PORT || 4599;

http.createServer((req, res) => {
  fs.readFile(REPORT, (err, buf) => {
    if (err) { res.writeHead(404); res.end('report not found — run: node scripts/eval/run_eval.js'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`eval report preview on http://localhost:${PORT}`));
