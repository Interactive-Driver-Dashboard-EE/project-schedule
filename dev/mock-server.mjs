// Local stand-in for the GitHub API, used to run the page without a real token.
//   node dev/mock-server.mjs [data.json] [port]
// Then open http://localhost:8765/?mock and connect with any token.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataPath = process.argv[2] || join(root, 'dev', 'fixture.json');
const port = Number(process.argv[3] || 8765);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let text = await readFile(dataPath, 'utf8');
let sha = hash(text);
const commits = [];
const issues = new Map();
const USER = 'alex-gh';
let bigFile = false;

function hash(value) {
  return createHash('sha1').update(value).digest('hex');
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => done(data ? JSON.parse(data) : {}));
  });
}

async function api(req, res, url) {
  if (url.pathname === '/__mock/state') return send(res, 200, { sha, commits, doc: JSON.parse(text) });
  // Makes the data file look larger than 1 MB, so GitHub would leave out its content.
  if (url.pathname === '/__mock/big' && req.method === 'POST') {
    bigFile = (await readBody(req)).on;
    return send(res, 200, { bigFile });
  }
  // Lets a test change the file behind the page, as the other partner would.
  if (url.pathname === '/__mock/external-edit' && req.method === 'POST') {
    const { doc } = await readBody(req);
    text = `${JSON.stringify(doc, null, 1)}\n`;
    sha = hash(text);
    commits.push({ message: 'Schedule: partner edit', branch: 'schedule-data', path: 'schedule.json', date: new Date().toISOString(), login: 'partner-gh' });
    return send(res, 200, { sha });
  }
  if (!req.headers.authorization) return send(res, 401, { message: 'Bad credentials' });
  if (req.headers.authorization === 'Bearer bad') return send(res, 401, { message: 'Bad credentials' });
  const raw = (req.headers.accept || '').includes('raw');
  if (url.pathname === '/__mock/user') return send(res, 200, { login: USER });
  if (url.pathname.endsWith('/commits')) {
    const path = url.searchParams.get('path');
    const list = commits.filter((c) => !path || c.path === path).reverse()
      .map((c) => ({ commit: { message: c.message, committer: { date: c.date } }, author: { login: c.login } }));
    return send(res, 200, list.slice(0, Number(url.searchParams.get('per_page')) || 30));
  }
  if (url.pathname.endsWith('/contents/schedule.json')) {
    if (req.method === 'GET') {
      if (raw) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(text); }
      if (bigFile) return send(res, 200, { sha, content: '', encoding: 'none', size: Buffer.byteLength(text) });
      return send(res, 200, { sha, content: Buffer.from(text).toString('base64') });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.sha !== sha) return send(res, 409, { message: 'sha mismatch' });
      text = Buffer.from(body.content, 'base64').toString('utf8');
      sha = hash(text);
      commits.push({ message: body.message, branch: body.branch, path: 'schedule.json', date: new Date().toISOString(), login: USER });
      return send(res, 200, { content: { sha } });
    }
  }
  if (url.pathname.endsWith('/issues')) {
    if (req.method === 'GET') return send(res, 200, [...issues.values()]);
    const body = await readBody(req);
    const number = issues.size + 100;
    const issue = { number, state: 'open', html_url: `https://example.test/issues/${number}`, title: body.title, body: body.body, assignees: body.assignees };
    issues.set(number, issue);
    return send(res, 201, issue);
  }
  return send(res, 404, { message: 'Not Found' });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/__mock')) return api(req, res, url);
  const rel = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
  try {
    const file = await readFile(join(root, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(file);
  } catch {
    res.writeHead(404);
    return res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/?mock`));
