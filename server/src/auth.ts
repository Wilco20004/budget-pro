import crypto from 'crypto';
import { RequestHandler } from 'express';
import { oauthTokenValid, resourceMetadataUrl } from './oauth';
import { getApiToken } from './settings';

// Two ways in:
//  1. Home Assistant Ingress — the sidebar panel. HA has already
//     authenticated the user; the request arrives from the Supervisor's
//     ingress proxy at 172.30.32.2. No token needed.
//  2. The directly exposed port (LAN) — the REST API, the MCP endpoint for
//     AI clients, or the web UI opened by IP. This is financial data, so it
//     requires the API token from the Settings page as a Bearer token.
//  3. Claude custom connectors reaching /mcp through your reverse proxy,
//     with an OAuth access token (oauth.ts).
// Loopback is trusted too, for `npm run dev` and container health checks.
const INGRESS_PROXY = '172.30.32.2';

function remoteIp(raw: string | undefined): string {
  return (raw ?? '').replace(/^::ffff:/, '');
}

function tokenMatches(given: string): boolean {
  const expected = Buffer.from(getApiToken());
  const got = Buffer.from(given);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const ip = remoteIp(req.socket.remoteAddress);
  if (ip === INGRESS_PROXY) return next();
  // A reverse proxy on the same host connects from loopback — trust loopback
  // only when nothing forwarded the request, or the internet gets in free.
  if ((ip === '127.0.0.1' || ip === '::1') && !req.headers['x-forwarded-for']) return next();
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (bearer && tokenMatches(bearer)) return next();
  // 3. Claude custom connectors: an OAuth access token, for /mcp only.
  const isMcp = req.baseUrl === '/mcp';
  if (isMcp && bearer && oauthTokenValid(bearer)) return next();
  if (isMcp) res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl(req)}"`);
  res.status(401).json({ error: 'API token required (Settings → API & AI access in BudgetPro)' });
};
