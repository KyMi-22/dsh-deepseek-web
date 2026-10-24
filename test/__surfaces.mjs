// Dump session 6730e931: all system/message events with their surfaceOp and order.
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = 'C:/Users/27508/.dsh/sessions/--C-Users-27508-.dsh-deepseek-web-conversations--/6730e931-da65-49e7-a31e-70c14eb1e013/session.v4.jsonl.zstd';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const buf = fs.readFileSync(file);
const starts = [];
for (let i = 0; i < buf.length - 3; i += 1) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
}
const events = [];
for (let k = 0; k < starts.length; k += 1) {
  let text;
  try {
    text = zlib.zstdDecompressSync(buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)).toString('utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* tail */
    }
  }
}
console.log('total events:', events.length);
for (const e of events) {
  if (e.type === 'system/message') {
    console.log(`seq ${String(e.seq).padStart(3)} system/message turn=${e.data?.turn} step=${e.data?.step} surfaceOp=${JSON.stringify(e.surfaceOp)} text=${JSON.stringify((e.data?.message?.content?.[0]?.text ?? '').slice(0, 60))}`);
  } else if (/^(turn|step)\/(start|end)$/.test(e.type)) {
    console.log(`seq ${String(e.seq).padStart(3)} ${e.type}`, JSON.stringify(e.data).slice(0, 90));
  }
}
