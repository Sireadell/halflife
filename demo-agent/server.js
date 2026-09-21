/**
 * Halflife's own demo agent.
 *
 * A small, genuinely simple assistant, built to be judged honestly rather than
 * to look impressive. It answers what it knows, refuses what it doesn't, and
 * rejects malformed input cleanly instead of crashing or guessing. This is the
 * agent Halflife's own paid demo certifies — Halflife owns and controls it, so
 * it can complete StressProof's one-time consent proof for it directly, and a
 * visitor trying the live demo needs no cooperation from anyone else.
 */
import { createServer } from 'node:http';

const CONSENT_CODE = process.env.STRESSPROOF_CONSENT_CODE ?? '';
const MAX_BODY_BYTES = 8192;

const KNOWN_ANSWERS = [
  { pattern: /2\s*\+\s*2|2 plus 2/i, reply: '4' },
  { pattern: /capital of france/i, reply: 'Paris' },
  { pattern: /how many days.*week|days in a week/i, reply: '7' },
];

function answer(message) {
  const match = KNOWN_ANSWERS.find((entry) => entry.pattern.test(message));
  if (match) return { reply: match.reply, confidence: 'answered' };
  return { reply: "I don't know that one. I only answer a small set of things I'm sure of.", confidence: 'refused' };
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/.well-known/stressproof.txt') {
    res.setHeader('content-type', 'text/plain');
    res.statusCode = 200;
    res.end(CONSENT_CODE);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let received = 0;
  const chunks = [];
  let rejected = false;

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY_BYTES && !rejected) {
      rejected = true;
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'payload too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected) return;

    res.setHeader('content-type', 'application/json');

    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'body is not valid JSON' }));
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'body must be a JSON object' }));
      return;
    }

    if (typeof parsed.message !== 'string' || parsed.message.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'message field is required and must be a non-empty string' }));
      return;
    }

    if (parsed.message.length > 2000) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'message is too long' }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify(answer(parsed.message)));
  });

  req.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'malformed request' }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Halflife demo agent listening on :${PORT}`));
