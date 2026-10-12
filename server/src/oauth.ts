import crypto from 'crypto';
import express, { Request, Response, Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, now } from './db';
import { getApiToken, getSettings } from './settings';
import { h, str } from './util';

// OAuth 2.1 for Claude custom connectors (claude.ai, Desktop, mobile). Claude
// reaches /mcp from Anthropic's cloud through your reverse proxy, so it can't
// hold the LAN Bearer token; instead it registers itself (RFC 7591), sends you
// to /oauth/authorize — where you approve with the API token — and gets
// short-lived access tokens it refreshes on its own.
//
// Public URLs come from Settings → Public URL when set (needed when the proxy
// serves BudgetPro under a path, e.g. https://ha.example.com/budget, since the
// stripped prefix never reaches us); otherwise from the request (X-Forwarded-*
// and X-Forwarded-Prefix). Under a path the RFC 8414 location for the issuer
// sits at the domain root, which isn't ours, so the metadata is also served at
// <issuer>/.well-known/openid-configuration — the MCP spec's last fallback.
// Grants are tied to the API token: regenerating it signs every connector out.

const ACCESS_TTL = 60 * 60; // 1 h
const REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days, rotated on every use
const CODE_TTL = 10 * 60;
const MAX_CLIENTS = 50; // registration is unauthenticated; keep it bounded
const SCOPE = 'budgetpro';

// Claude's hosted apps use the first; loopback is for local MCP clients
// (Claude Desktop/Code doing their own OAuth). Nothing else may receive a code.
const ALLOWED_REDIRECTS = [/^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/, /^https:\/\/claude\.com\/api\/mcp\/auth_callback$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/];

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const epoch = () => Math.floor(Date.now() / 1000);
/** Which API token a grant was approved with (hashed) — see the header comment. */
const apiTokenTag = () => sha256('budgetpro-oauth:' + getApiToken()).slice(0, 16);

function firstHeader(v: string | string[] | undefined): string | undefined {
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim() || undefined;
}

/** https://ha.example.com/budget — as the client sees us through the proxy. */
export function publicBase(req: Request): string {
  const configured = getSettings().public_url;
  if (configured) return configured;
  const proto = firstHeader(req.headers['x-forwarded-proto']) ?? req.protocol;
  const host = firstHeader(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  const prefix = (firstHeader(req.headers['x-forwarded-prefix']) ?? '').replace(/\/+$/, '');
  return `${proto}://${host}${prefix.startsWith('/') ? prefix : ''}`;
}

/** Proxies that forward /budget/mcp as-is (prefix not stripped) still land
 *  on the right route: drop Public URL's path from the front of the request. */
export function stripPublicPrefix(req: Request, _res: Response, next: () => void) {
  const url = getSettings().public_url;
  const prefix = url ? new URL(url).pathname.replace(/\/+$/, '') : '';
  if (prefix && (req.url === prefix || req.url.startsWith(prefix + '/') || req.url.startsWith(prefix + '?'))) {
    req.url = req.url.slice(prefix.length) || '/';
  }
  next();
}

export function resourceMetadataUrl(req: Request): string {
  return `${publicBase(req)}/.well-known/oauth-protected-resource/mcp`;
}

// ---- Access-token check for /mcp ---------------------------------------------

/** True when the Bearer value is a live access token issued here. */
export function oauthTokenValid(bearer: string): boolean {
  const row = db
    .prepare('SELECT id, expires_at, api_token_tag FROM oauth_tokens WHERE access_hash = ?')
    .get(sha256(bearer)) as { id: string; expires_at: number; api_token_tag: string } | undefined;
  if (!row || row.expires_at < epoch() || row.api_token_tag !== apiTokenTag()) return false;
  db.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return true;
}

// ---- Approval-page brute-force guard -------------------------------------------

const failures: number[] = [];
function tooManyFailures(): boolean {
  const cutoff = Date.now() - 15 * 60_000;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= 10;
}

function tokenMatches(given: string): boolean {
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(getApiToken()));
  return crypto.timingSafeEqual(a, b);
}

// ---- Routes ----------------------------------------------------------------------

interface ClientRow {
  id: string;
  name: string | null;
  redirect_uris: string;
}

function getClient(id: unknown): ClientRow | undefined {
  return typeof id === 'string' ? (db.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?').get(id) as ClientRow | undefined) : undefined;
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

export const wellKnownRouter = Router();

const protectedResource = (req: Request, res: Response) => {
  const base = publicBase(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'BudgetPro',
  });
};
wellKnownRouter.get('/oauth-protected-resource', protectedResource);
wellKnownRouter.get('/oauth-protected-resource/mcp', protectedResource);

const authServer = (req: Request, res: Response) => {
  const base = publicBase(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  });
};
wellKnownRouter.get('/oauth-authorization-server', authServer);
wellKnownRouter.get('/oauth-authorization-server/*', authServer);
wellKnownRouter.get('/openid-configuration', authServer);

export const oauthRouter = Router();
oauthRouter.use(express.urlencoded({ extended: false }));

// RFC 7591 dynamic client registration — public clients only (PKCE).
oauthRouter.post('/register', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!uris.length) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required');
  const bad = uris.find((u) => !ALLOWED_REDIRECTS.some((re) => re.test(u)));
  if (bad) return oauthError(res, 400, 'invalid_redirect_uri', `Redirect URI not allowed: ${bad}`);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
  if (count >= MAX_CLIENTS) {
    // Forget registrations that never got approved before refusing.
    db.prepare('DELETE FROM oauth_clients WHERE id NOT IN (SELECT DISTINCT client_id FROM oauth_tokens)').run();
    const left = (db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
    if (left >= MAX_CLIENTS) return oauthError(res, 400, 'invalid_client_metadata', 'Too many registered clients');
  }
  const id = uuid();
  const name = (str(body.client_name) ?? 'MCP client').slice(0, 100);
  db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), now());
  res.status(201).json({
    client_id: id,
    client_id_issued_at: epoch(),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  scope: string;
  resource: string;
}

/** Validates an authorize request; returns the params or sends the error. */
function authorizeParams(req: Request, res: Response, src: Record<string, unknown>): { client: ClientRow; p: AuthParams } | null {
  const client = getClient(src.client_id);
  const redirect = str(src.redirect_uri);
  // Bad client or redirect: never redirect back (that's the open-redirect hole).
  if (!client) {
    res.status(400).type('html').send(page('Unknown app', '<p>This app isn’t registered with BudgetPro. Remove the connector in Claude and add it again.</p>'));
    return null;
  }
  const uris = JSON.parse(client.redirect_uris) as string[];
  if (!redirect || !uris.includes(redirect)) {
    res.status(400).type('html').send(page('Bad request', '<p>The redirect address doesn’t match this app’s registration.</p>'));
    return null;
  }
  const back = (error: string, description: string) => {
    const u = new URL(redirect);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (str(src.state)) u.searchParams.set('state', String(src.state));
    res.redirect(u.toString());
    return null;
  };
  if (src.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
  if (!str(src.code_challenge) || src.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
  const resource = str(src.resource) ?? `${publicBase(req)}/mcp`;
  if (resource.replace(/\/$/, '') !== `${publicBase(req)}/mcp`) return back('invalid_target', 'Unknown resource');
  return {
    client,
    p: {
      client_id: client.id,
      redirect_uri: redirect,
      state: str(src.state) ?? '',
      code_challenge: String(src.code_challenge),
      scope: SCOPE,
      resource,
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · BudgetPro</title><meta name="referrer" content="no-referrer">
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#5d6675;--accent:#2a78d6;--danger:#c0392b;--border:#d9dee6}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--text:#e6e9ee;--muted:#9aa3b0;--accent:#5b9cf0;--danger:#e0675a;--border:#323844}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:420px;width:100%}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.9rem}
input{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;margin:4px 0 12px}
.row{display:flex;flex-direction:row-reverse;gap:8px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--border);font:inherit;cursor:pointer;background:var(--card);color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:var(--danger)}code{word-break:break-all}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function approvalPage(client: ClientRow, p: AuthParams, error?: string): string {
  const hidden = Object.entries(p)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  const host = new URL(p.redirect_uri).host;
  return page(
    'Connect to BudgetPro',
    `<h1>Connect ${esc(client.name ?? 'this app')} to BudgetPro?</h1>
<p>It will be able to read your budget, transactions and slips, and categorise transactions and log slips — the same as the MCP tools.</p>
<p class="muted">Sends you back to <code>${esc(host)}</code>.</p>
<form method="post" action="authorize">${hidden}
<label for="t">API token <span class="muted">(BudgetPro → Settings → API &amp; AI access)</span></label>
<input id="t" name="api_token" type="password" autocomplete="off" required autofocus>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<div class="row"><button class="primary" name="decision" value="approve">Approve</button><button name="decision" value="deny" formnovalidate>Cancel</button></div>
</form>`
  );
}

oauthRouter.get('/authorize', (req, res) => {
  const v = authorizeParams(req, res, req.query as Record<string, unknown>);
  if (!v) return;
  res.set('Cache-Control', 'no-store').set('X-Frame-Options', 'DENY').type('html').send(approvalPage(v.client, v.p));
});

oauthRouter.post('/authorize', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const v = authorizeParams(req, res, { ...body, response_type: 'code', code_challenge_method: 'S256' });
  if (!v) return;
  const { client, p } = v;
  const u = new URL(p.redirect_uri);
  if (p.state) u.searchParams.set('state', p.state);
  if (body.decision !== 'approve') {
    u.searchParams.set('error', 'access_denied');
    return res.redirect(u.toString());
  }
  res.set('Cache-Control', 'no-store').set('X-Frame-Options', 'DENY');
  if (tooManyFailures()) return res.status(429).type('html').send(approvalPage(client, p, 'Too many wrong tokens — try again in 15 minutes.'));
  if (!tokenMatches(String(body.api_token ?? '').trim())) {
    failures.push(Date.now());
    return res.status(401).type('html').send(approvalPage(client, p, 'That isn’t the API token.'));
  }
  const code = randomToken();
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sha256(code), client.id, p.redirect_uri, p.code_challenge, p.scope, p.resource, epoch() + CODE_TTL);
  u.searchParams.set('code', code);
  res.redirect(u.toString());
});

function issueTokens(res: Response, clientId: string, scope: string, resource: string, replaceId?: string) {
  const access = randomToken();
  const refresh = randomToken();
  const t = epoch();
  db.transaction(() => {
    if (replaceId) db.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(replaceId);
    db.prepare(
      `INSERT INTO oauth_tokens (id, client_id, access_hash, refresh_hash, scope, resource, api_token_tag, expires_at, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), clientId, sha256(access), sha256(refresh), scope, resource, apiTokenTag(), t + ACCESS_TTL, t + REFRESH_TTL, now());
  })();
  res.set('Cache-Control', 'no-store').json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope,
  });
}

oauthRouter.post('/token', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const client = getClient(b.client_id);
  if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client');

  if (b.grant_type === 'authorization_code') {
    const codeHash = sha256(String(b.code ?? ''));
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as
      | { client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires_at: number }
      | undefined;
    // Single use, whatever happens next.
    db.prepare('DELETE FROM oauth_codes WHERE code_hash = ? OR expires_at < ?').run(codeHash, epoch());
    if (!row || row.expires_at < epoch() || row.client_id !== client.id) return oauthError(res, 400, 'invalid_grant', 'Code is invalid or expired');
    if (str(b.redirect_uri) && b.redirect_uri !== row.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    const verifier = String(b.code_verifier ?? '');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || challenge !== row.code_challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    return issueTokens(res, client.id, row.scope, row.resource);
  }

  if (b.grant_type === 'refresh_token') {
    const row = db
      .prepare('SELECT id, client_id, scope, resource, api_token_tag, refresh_expires_at FROM oauth_tokens WHERE refresh_hash = ?')
      .get(sha256(String(b.refresh_token ?? ''))) as
      | { id: string; client_id: string; scope: string; resource: string; api_token_tag: string; refresh_expires_at: number }
      | undefined;
    if (!row || row.client_id !== client.id || row.refresh_expires_at < epoch() || row.api_token_tag !== apiTokenTag()) {
      if (row) db.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(row.id);
      return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
    }
    return issueTokens(res, client.id, row.scope, row.resource, row.id);
  }

  oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
});

// RFC 7009: always 200, whether or not the token existed.
oauthRouter.post('/revoke', (req, res) => {
  const tok = sha256(String((req.body ?? {}).token ?? ''));
  db.prepare('DELETE FROM oauth_tokens WHERE access_hash = ? OR refresh_hash = ?').run(tok, tok);
  res.status(200).end();
});

// ---- Settings: connected apps (behind requireAuth under /api) ---------------------

export const connectedAppsRouter = Router();

connectedAppsRouter.get(
  '/',
  h((_req, res) => {
    const tag = apiTokenTag();
    res.json(
      db
        .prepare(
          `SELECT c.id, c.name, c.created_at, MAX(t.created_at) AS last_signed_in, MAX(t.last_used_at) AS last_used_at
           FROM oauth_clients c JOIN oauth_tokens t ON t.client_id = c.id
           WHERE t.api_token_tag = ? AND t.refresh_expires_at > ?
           GROUP BY c.id ORDER BY last_signed_in DESC`
        )
        .all(tag, epoch())
    );
  })
);

connectedAppsRouter.delete(
  '/:id',
  h((req, res) => {
    db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').run(String(req.params.id));
    db.prepare('DELETE FROM oauth_clients WHERE id = ?').run(String(req.params.id));
    res.json({ ok: true });
  })
);
