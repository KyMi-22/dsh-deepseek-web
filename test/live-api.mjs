// Live smoke test against chat.deepseek.com.
//
// Requires a real credential, so it is NOT part of the offline suite:
//
//   $env:DS_TOKEN = '<user token>'
//   node test/live-api.mjs
//
// It proves the three things that cannot be tested offline: the PoW solver
// agrees with the server, the paginated conversation list works, and a streamed
// completion arrives with reasoning and answer separated.

import { DeepSeekWebApi } from '../src/api.js';

const token = (process.env.DS_TOKEN ?? '').trim();
if (token === '') {
  console.error('set DS_TOKEN to a chat.deepseek.com user token first');
  process.exit(2);
}

const api = new DeepSeekWebApi({ token });

const me = await api.currentUser();
console.log('account:', me.id_profile?.name ?? me.id, '|', me.email ?? '');

const sessions = await api.listSessions({ pageSize: 100 });
console.log('conversations:', sessions.length);
for (const session of sessions.slice(0, 3)) {
  console.log(`  ${new Date(session.updatedAt * 1000).toISOString().slice(0, 16)}  ${session.title}`);
}

if (sessions.length > 0) {
  const history = await api.getHistory(sessions[0].id);
  console.log('history messages:', history?.messages.length ?? 0);
}

const created = await api.createSession();
console.log('new conversation:', created.id);

const started = Date.now();
let reasoning = '';
let answer = '';
for await (const event of api.streamCompletion({
  chatSessionId: created.id,
  prompt: '用一个词回答：天空通常是什么颜色？',
  thinking: true,
})) {
  if (event.kind === 'fragment') {
    if (event.fragmentType === 'THINK') reasoning += event.text;
    else answer += event.text;
  } else if (event.kind === 'status') {
    console.log('status:', event.status);
  }
}
console.log(`streamed in ${Date.now() - started}ms; reasoning ${reasoning.length} chars, answer ${answer.length} chars`);
console.log('answer:', answer.slice(0, 80));

if (answer.length === 0) {
  console.error('FAIL: no answer text was streamed');
  process.exit(1);
}
console.log('live-api.mjs: OK');
