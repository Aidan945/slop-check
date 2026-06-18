#!/usr/bin/env node
/**
 * serve-report — serve a generated slop report at a local URL.
 *
 * Dependency-free (Node 18+). Serves exactly one file; no directory listing,
 * no other paths. Picks the first free port starting at 7331.
 *
 * Usage: node serve-report.mjs <path-to-slop-report.html> [--port 7331]
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv: string[] = process.argv.slice(2);
const file: string = resolve(argv.find((a) => !a.startsWith('--')) ?? 'slop-report.html');
const portFlag: number = argv.indexOf('--port');
const port: number = portFlag !== -1 ? Number(argv[portFlag + 1]) : 7331;

if (!existsSync(file)) {
  console.error(`serve-report: file not found: ${file}`);
  process.exit(1);
}

function start(p: number, attemptsLeft: number): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    // Re-read on each request so a regenerated report shows up on refresh
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) start(p + 1, attemptsLeft - 1);
    else { console.error(`serve-report: ${err.message}`); process.exit(1); }
  });
  server.listen(p, '127.0.0.1', () => {
    console.log(`Slop report live at: http://localhost:${p}`);
    console.log('(Ctrl+C to stop — the report is also a plain file you can open directly.)');
  });
}

start(port, 20);
