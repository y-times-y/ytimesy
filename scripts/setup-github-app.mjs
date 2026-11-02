import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const envPath = resolve(root, '.env');
const keyPath = resolve(root, '.secrets/github-app.pem');
if (!existsSync(envPath)) throw new Error('Create .env from .env.example first.');
if (existsSync(keyPath) || /^GITHUB_APP_ID=.+$/m.test(readFileSync(envPath, 'utf8'))) {
  throw new Error('GitHub App credentials already exist; refusing to replace them.');
}

const state = randomBytes(32).toString('hex');
const origin = 'http://127.0.0.1:4319';
const organization = 'y-times-y';
const manifest = {
  name: 'ytimesy',
  description: 'Run your coding agents on the repositories you select.',
  url: 'https://ytimesy.com',
  redirect_url: `${origin}/callback`,
  hook_attributes: { url: 'https://ytimesy.com/api/github/webhook', active: false },
  public: true,
  // checks: read lets PR repair re-read the failing check run/suite it was woken for
  // (src/server/adapters/github/pr-repair-evidence.ts). issues: read is what GitHub
  // requires to deliver issue_comment (@<app slug> on a pull request); actions: read
  // lets a CI wake-up include the failed job's log tail
  // (src/server/adapters/github/pull-request-wake-github.ts).
  default_permissions: { contents: 'write', pull_requests: 'write', checks: 'read', issues: 'read', actions: 'read', metadata: 'read' },
  default_events: [],
  request_oauth_on_install: false,
};
let exchangeStarted = false;
let completed = false;
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function reply(response, status, content) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ytimesy GitHub setup</title><style>body{background:#101010;color:#eee;font:16px/1.6 system-ui;max-width:600px;margin:80px auto;padding:24px}button,a{font:inherit}button{padding:12px 20px;cursor:pointer}a{color:#eee}</style>${content}</html>`);
}

function saveCredentials(app) {
  const values = {
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_SLUG: app.slug,
    GITHUB_APP_CLIENT_ID: app.client_id,
    GITHUB_APP_CLIENT_SECRET: app.client_secret,
    GITHUB_WEBHOOK_SECRET: app.webhook_secret,
    GITHUB_PRIVATE_KEY_PATH: '.secrets/github-app.pem',
  };
  let env = readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error('Unexpected credential format.');
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    env = pattern.test(env) ? env.replace(pattern, () => line) : `${env.trimEnd()}\n${line}\n`;
  }
  mkdirSync(resolve(root, '.secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, app.pem, { mode: 0o600, flag: 'wx' });
  writeFileSync(`${envPath}.setup-tmp`, env, { mode: 0o600 });
  renameSync(`${envPath}.setup-tmp`, envPath);
}

const server = createServer(async (request, response) => {
  if (request.headers.host !== '127.0.0.1:4319' || request.method !== 'GET') {
    reply(response, 403, '<p>Request rejected.</p>');
    return;
  }
  const url = new URL(request.url, origin);
  if (url.pathname === `/${state}` && !exchangeStarted) {
    reply(response, 200, `<h1>Connect ytimesy to GitHub</h1><p>Create the app under <strong>${organization}</strong>. It will request repository contents and pull-request write access. Webhooks stay disabled until the receiver is deployed.</p><p>After creating the app, install it on <strong>only ytimesy</strong>.</p><form method="post" action="https://github.com/organizations/${organization}/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Create GitHub App</button></form>`);
    return;
  }
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || exchangeStarted) {
    reply(response, 404, '<p>Setup link is invalid or already used.</p>');
    return;
  }
  const code = url.searchParams.get('code');
  if (!code || !/^[a-zA-Z0-9]+$/.test(code)) {
    reply(response, 400, '<p>GitHub did not provide a valid registration code.</p>');
    return;
  }
  exchangeStarted = true;
  try {
    const result = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ytimesy-setup' },
      signal: AbortSignal.timeout(30000),
    });
    if (!result.ok) throw new Error(`GitHub conversion returned HTTP ${result.status}.`);
    const app = await result.json();
    if (!Number.isInteger(app.id) || app.owner?.login?.toLowerCase() !== organization || ![app.slug, app.client_id, app.client_secret, app.webhook_secret, app.pem].every(v => typeof v === 'string' && v.length > 0) || !/^[a-zA-Z0-9-]+$/.test(app.slug)) {
      throw new Error('GitHub returned an unexpected app configuration.');
    }
    // Keep recovery material private if an interrupted local write needs repair.
    const receiptPath = resolve(root, '.secrets/github-app-registration.json');
    writeFileSync(receiptPath, JSON.stringify(app), { flag: 'wx', mode: 0o600 });
    saveCredentials(app);
    completed = true;
    console.log(`GitHub App created and credentials saved. App ID: ${app.id}; slug: ${app.slug}.`);
    reply(response, 200, `<h1>App created</h1><p>Credentials are saved locally. Now install the app on <strong>only y-times-y/ytimesy</strong>.</p><p><a href="https://github.com/apps/${app.slug}/installations/new">Choose repository and install</a></p>`);
    setTimeout(() => server.close(), 1000);
  } catch {
    console.error('App setup did not finish. Check the app registration in GitHub before trying again; credentials were not printed.');
    reply(response, 500, '<p>Setup did not finish. Check GitHub app settings before retrying. Any saved credentials remain in the ignored .secrets directory.</p>');
    server.close();
  }
});
server.on('close', () => { clearTimeout(expiry); if (!completed) process.exitCode = 1; });
const expiry = setTimeout(() => server.close(), 60 * 60 * 1000);
server.listen(4319, '127.0.0.1', () => console.log(`Open ${origin}/${state}`));
