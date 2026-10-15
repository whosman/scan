// Serves dist/app.html on your local network so a phone on the same Wi-Fi can open it in Safari.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

const port = 8080;
const file = new URL('./dist/app.html', import.meta.url);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(port, '0.0.0.0', () => {
  console.log('Scan is running. On your phone, open one of:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log('  http://' + a.address + ':' + port);
});
