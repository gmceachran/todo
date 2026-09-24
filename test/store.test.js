import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, GitHubStore } from '../store.js';

function stubStore(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return responses.shift();
  };
  return { store: new GitHubStore({ repo: 'me/journal', token: 't', fetch }), calls };
}

test('readText fetches a raw file with an encoded path', async () => {
  const { store, calls } = stubStore([new Response('# notes', { status: 200 })]);
  assert.equal(await store.readText('Work Journal.md'), '# notes');
  assert.equal(calls[0].url, 'https://api.github.com/repos/me/journal/contents/Work%20Journal.md?ref=main');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.raw');
});

test('readText returns null for a missing file and throws on refusal', async () => {
  const { store } = stubStore([
    new Response('{}', { status: 404 }),
    new Response(JSON.stringify({ message: 'nope' }), { status: 403 }),
  ]);
  assert.equal(await store.readText('Missing.md'), null);
  await assert.rejects(store.readText('Private.md'), AuthError);
});
