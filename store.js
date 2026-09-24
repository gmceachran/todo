import { applyOps, describeOp, emptyDoc, normalizeDoc } from './core.js';

export class ConflictError extends Error {}

export class AuthError extends Error {}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function parseRepo(value) {
  const match = String(value || '').trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) throw new Error(`Repository should look like "owner/name", got "${value}"`);
  return { owner: match[1], repo: match[2] };
}

export class GitHubStore {
  constructor({ repo, token, path = 'tasks.json', branch = 'main', fetch: fetchImpl }) {
    const { owner, repo: name } = parseRepo(repo);
    this.repoUrl = `https://api.github.com/repos/${owner}/${name}`;
    this.url = `${this.repoUrl}/contents/${path}`;
    this.token = token;
    this.branch = branch;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  headers() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async fail(res) {
    const body = await res.json().catch(() => ({}));
    const message = body.message || res.statusText;
    if (res.status === 401 || res.status === 403) throw new AuthError(`GitHub refused access: ${message}`);
    throw new Error(`GitHub ${res.status}: ${message}`);
  }

  async check() {
    const res = await this.fetch(this.repoUrl, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) throw new AuthError('GitHub could not find that repo with this token');
    if (!res.ok) await this.fail(res);
    const repo = await res.json();
    if (repo.permissions && !repo.permissions.push) throw new AuthError('This token can read the repo but not write to it');
    return repo;
  }

  async load() {
    const res = await this.fetch(`${this.url}?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers(),
      cache: 'no-store',
    });
    if (res.status === 404) return { doc: emptyDoc(), sha: null };
    if (!res.ok) await this.fail(res);
    const body = await res.json();
    const doc = normalizeDoc(JSON.parse(decodeBase64(body.content)));
    return { doc, sha: body.sha };
  }

  async readText(path) {
    const url = `${this.repoUrl}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await this.fetch(`${url}?ref=${encodeURIComponent(this.branch)}`, {
      headers: { ...this.headers(), Accept: 'application/vnd.github.raw' },
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res);
    return res.text();
  }

  async save(doc, sha, message) {
    const body = {
      message,
      branch: this.branch,
      content: encodeBase64(`${JSON.stringify(doc, null, 2)}\n`),
    };
    if (sha) body.sha = sha;
    const res = await this.fetch(this.url, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) throw new ConflictError('tasks.json changed underneath us');
    if (!res.ok) await this.fail(res);
    return (await res.json()).content.sha;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function commitMessage(ops, doc, author = 'app') {
  const lines = ops.map((op) => describeOp(op, doc));
  const head = lines.length === 1 ? lines[0] : `${lines.length} changes`;
  return `${author}: ${head}${lines.length > 1 ? `\n\n${lines.join('\n')}` : ''}`;
}

export async function commitOps(store, ops, { ctx, author, base, attempts = 5 } = {}) {
  let current = base;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!current) current = await store.load();
    const doc = structuredClone(current.doc);
    const message = commitMessage(ops, current.doc, author);
    const results = applyOps(doc, ops, ctx);
    if (results.every((r) => r.skipped)) return { doc: current.doc, sha: current.sha, results };
    try {
      const sha = await store.save(doc, current.sha, message);
      return { doc, sha, results };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      current = null;
      await sleep(400 * (attempt + 1));
    }
  }
  throw new ConflictError('Gave up after repeated conflicts');
}
