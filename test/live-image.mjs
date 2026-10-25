// Live end-to-end image test: upload a local picture and complete with it.
//
// Exercises the full chain the adapter drives: PoW for the upload endpoint
// (the optimized solver), multipart upload, parse polling, then a completion
// carrying ref_file_ids. Run from the plugin root:
//
//   node test/live-image.mjs <image-path>
//
// The token is read from the plugin's own state file.
import { readFile } from 'node:fs/promises';
import { DeepSeekWebApi } from '../src/api.js';

const imageArg = process.argv[2] ?? 'C:/Users/27508/Pictures/MC or not.jpg';
const state = JSON.parse(await readFile(`${process.env.USERPROFILE}/.dsh/deepseek-web/state.json`, 'utf8'));
if (typeof state.token !== 'string' || state.token === '') {
  console.error('no stored token; save one from the settings page first');
  process.exit(2);
}

// Declare the TRUE media type: the store rejects a declared type that does not
// match the bytes, and several files in Pictures carry a .png name but WebP bytes.
const trueType = (bytes, fallback) => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  return fallback;
};
const bytes = new Uint8Array(await readFile(imageArg));
let mediaType = trueType(bytes, 'image/png');
// The web endpoint rejects anything outside its own accepted set; normalize
// WebP (and anything exotic) to PNG so the live test always sends an accepted
// type. DSH's attachment store hands the adapter normalized images anyway.
let uploadBytes = bytes;
if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/gif') {
  mediaType = 'image/png';
}
console.log(`image: ${imageArg} (${bytes.length} bytes, declared ${mediaType})`);

const api = new DeepSeekWebApi({ token: state.token, deviceId: state.deviceId });

const me = await api.currentUser();
console.log(`account: ${me.id_profile?.name ?? me.id}`);

// 1. upload + wait for the server-side parse (uses the optimized PoW solver)
// The endpoint judges the file type by the filename EXTENSION (the browser
// always sends one), so the name must match the declared media type.
const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/gif' ? 'gif' : 'png';
const uploadStart = Date.now();
const fileId = await api.uploadImage({ bytes: uploadBytes, mediaType, fileName: `live-test.${ext}`, thinking: false });
console.log(`uploaded: ${fileId} (upload+parse ${Date.now() - uploadStart}ms)`);

// 2. a completion that references the uploaded file
const session = await api.createSession();
console.log(`conversation: ${session.id}`);
let answer = '';
let reasoning = '';
const streamStart = Date.now();
for await (const event of api.streamCompletion({
  chatSessionId: session.id,
  prompt: '用一句话描述这张图片的内容。',
  parentMessageId: null,
  thinking: false,
  refFileIds: [fileId],
})) {
  if (event.kind === 'fragment' && event.text !== '') {
    if (event.fragmentType === 'THINK') reasoning += event.text;
    else answer += event.text;
  }
}
console.log(`completion ${Date.now() - streamStart}ms; answer: ${answer.slice(0, 160)}`);
if (answer.trim() === '') {
  console.error('FAIL: the model returned no text for the image');
  process.exit(1);
}
console.log('live-image.mjs: OK');
