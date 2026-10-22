/**
 * Small HTTP helpers for the settings routes.
 *
 * Kept apart from the route table so the transport concerns (body limits, JSON
 * framing, cache headers) are stated once and are testable without a plugin host.
 *
 * @module src/http
 */

/** Request bodies are tiny JSON documents. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Send a JSON reply on the raw response.
 *
 * `no-store` matters: the status payload carries host paths and the credential's
 * last characters, which must not sit in a browser or proxy cache.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * Read and parse a small JSON body.
 *
 * The size cap is enforced while reading, not after: buffering an unbounded body
 * and checking its length afterwards would already have spent the memory.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  return parsed !== null && typeof parsed === 'object' ? parsed : {};
}
