// Where the schedule data lives. This repository holds code only; the data stays
// in the private project repository, on its own branch so saves don't touch main.
export const DATA = {
  owner: 'Interactive-Driver-Dashboard-EE',
  repo: 'Interactive-Driver-Dashboard-Display',
  branch: 'schedule-data',
  path: 'schedule.json',
};

const TOKEN_FORM = new URL('https://github.com/settings/personal-access-tokens/new');
TOKEN_FORM.search = new URLSearchParams({
  name: 'project-schedule',
  description: 'Project schedule page: read and save schedule data, link Issues',
  target_name: DATA.owner,
  expires_in: '366',
  contents: 'write',
  issues: 'write',
}).toString();
export const TOKEN_URL = TOKEN_FORM.toString();

// The API address can be overridden only on a local machine, so a crafted link
// to the public page can never send someone's token to another server.
export function apiBase() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (local && new URLSearchParams(location.search).has('mock')) return '/__mock';
  return 'https://api.github.com';
}
