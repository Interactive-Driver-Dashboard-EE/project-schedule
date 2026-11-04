import { DATA } from './config.js';

export class StoreError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class Store {
  constructor(token, base) {
    this.token = token;
    this.base = base;
    this.repoPath = `/repos/${DATA.owner}/${DATA.repo}`;
  }

  // `raw` asks for the file's text itself instead of JSON.
  async request(path, options = {}) {
    const { raw, ...init } = options;
    let res;
    try {
      res = await fetch(this.base + path, {
        ...init,
        cache: 'no-store',
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch {
      throw new StoreError('network', 'אין חיבור ל-GitHub. נסו שוב עוד רגע.');
    }
    if (res.ok && raw) return res.text();
    if (res.ok) return res.status === 204 ? null : res.json();
    if (res.status === 401) throw new StoreError('auth', 'הטוקן לא תקף או שפג תוקפו.', 401);
    if (res.status === 403) throw new StoreError('forbidden', 'לטוקן אין הרשאה מספיקה, או שהוא עוד מחכה לאישור הארגון.', 403);
    if (res.status === 404) throw new StoreError('notfound', 'לא נמצא. בדקו שהטוקן נוצר על הארגון והריפו הנכונים.', 404);
    if (res.status === 409 || res.status === 422) throw new StoreError('conflict', 'הקובץ השתנה בינתיים.', res.status);
    throw new StoreError('other', `GitHub החזיר שגיאה ${res.status}.`, res.status);
  }

  // GitHub leaves `content` empty for files over 1 MB, so a long work log
  // is read again as the raw file.
  async load() {
    const path = `${this.repoPath}/contents/${DATA.path}?ref=${DATA.branch}`;
    const data = await this.request(path);
    const text = data.content ? decode(data.content) : await this.request(path, { raw: true });
    return { text, sha: data.sha };
  }

  async whoAmI() {
    return (await this.request('/user')).login;
  }

  // When the data file was last saved, and by whom.
  async lastSave() {
    const list = await this.request(`${this.repoPath}/commits?sha=${DATA.branch}&path=${DATA.path}&per_page=1`);
    const c = list[0];
    return c ? { at: c.commit.committer?.date || c.commit.author?.date, login: c.author?.login || c.committer?.login || '' } : null;
  }

  async save(text, sha, message) {
    const data = await this.request(`${this.repoPath}/contents/${DATA.path}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: encode(text), sha, branch: DATA.branch }),
    });
    return data.content.sha;
  }

  async listIssues() {
    const list = await this.request(`${this.repoPath}/issues?state=all&per_page=100`);
    return new Map(list.filter((i) => !i.pull_request).map((i) => [i.number, { state: i.state, url: i.html_url, title: i.title }]));
  }

  async createIssue(title, body, assignees) {
    const issue = await this.request(`${this.repoPath}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body, assignees }),
    });
    return { number: issue.number, url: issue.html_url, state: issue.state, title: issue.title };
  }
}
