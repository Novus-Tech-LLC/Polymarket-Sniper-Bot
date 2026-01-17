require('dotenv').config();

const express = require('express');
const { buildHmacSignature } = require('@polymarket/builder-signing-sdk');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.SIGNER_AUTH_TOKEN;

const readEnv = (key) => process.env[key] ?? process.env[key.toLowerCase()];

const BUILDER_CREDS = {
  key: readEnv('POLY_BUILDER_API_KEY'),
  secret: readEnv('POLY_BUILDER_API_SECRET'),
  passphrase: readEnv('POLY_BUILDER_API_PASSPHRASE'),
};

const validateAuth = (req, res) => {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  if (header === `Bearer ${AUTH_TOKEN}`) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/sign', (req, res) => {
  if (!validateAuth(req, res)) return;

  const { method, path, body, timestamp } = req.body || {};
  if (!BUILDER_CREDS.key || !BUILDER_CREDS.secret || !BUILDER_CREDS.passphrase) {
    res.status(500).json({ error: 'missing_builder_creds' });
    return;
  }
  if (!method || !path) {
    res.status(400).json({ error: 'missing_method_or_path' });
    return;
  }

  const ts = Number(timestamp) || Math.floor(Date.now() / 1000);
  const bodyPayload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const signature = buildHmacSignature(BUILDER_CREDS.secret, ts, method, path, bodyPayload);

  res.json({
    POLY_BUILDER_API_KEY: BUILDER_CREDS.key,
    POLY_BUILDER_PASSPHRASE: BUILDER_CREDS.passphrase,
    POLY_BUILDER_SIGNATURE: signature,
    POLY_BUILDER_TIMESTAMP: `${ts}`,
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[Signer] listening on :${PORT}`);
});
