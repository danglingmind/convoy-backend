import { FastifyInstance } from 'fastify';

/**
 * Public (unauthenticated) routes that make ride invite links real, tappable
 * web links instead of a `convotrack://` custom scheme:
 *
 *   - /.well-known/apple-app-site-association  → iOS Universal Link verification
 *   - /.well-known/assetlinks.json             → Android App Link verification
 *   - /convotrack/join/:code                   → fallback landing page shown only
 *     when the app is NOT installed (a verified install opens the app directly
 *     and this HTML never renders).
 *
 * Identifiers that depend on signing config are read from env so they can be
 * set per-environment without a code change. Until they're filled in, domain
 * verification will not succeed (the link is still tappable + lands on the page).
 */

// iOS: "<AppleTeamID>.<bundleID>". Bundle id is danglingmind.convotrack.
const APPLE_APP_ID_PREFIX = process.env.APPLE_APP_ID_PREFIX ?? 'TEAMID'; // e.g. "AB12CD34EF"
const IOS_APP_ID = `${APPLE_APP_ID_PREFIX}.danglingmind.convotrack`;

// Android: release + upload signing cert SHA-256 fingerprints (colon-separated
// hex), comma-separated for multiple certs. Get via:
//   keytool -list -v -keystore <release.keystore> -alias <alias>
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE ?? 'com.danglingmind.convotrack';
const ANDROID_SHA256_FINGERPRINTS = (process.env.ANDROID_SHA256_FINGERPRINTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Store fallbacks for users without the app installed.
const APP_STORE_URL = process.env.APP_STORE_URL ?? 'https://apps.apple.com/app/convotrack';
const PLAY_STORE_URL =
  process.env.PLAY_STORE_URL ??
  `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

// The join path must match the App Link / Universal Link path patterns above.
const JOIN_PATH_PREFIX = '/convotrack/join';

function sanitizeCode(raw: string): string {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function landingPage(code: string): string {
  const scheme = `convotrack://join/${code}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Join a ConvoTrack ride</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #131313; color: #e6e6e6; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 380px; text-align: center;
    background: #1d1d1d; border: 1px solid #353535; border-radius: 20px; padding: 32px 24px;
  }
  .label { font-size: 12px; letter-spacing: 2px; font-weight: 700; color: #caf300; margin: 0 0 4px; }
  h1 { font-size: 22px; margin: 0 0 20px; color: #fff; }
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 34px; font-weight: 700;
    letter-spacing: 8px; color: #caf300; background: #171e00; border: 1px solid #caf300;
    border-radius: 12px; padding: 14px 8px; margin: 0 0 24px;
  }
  a.btn {
    display: block; text-decoration: none; font-weight: 700; font-size: 16px;
    border-radius: 12px; padding: 14px; margin-bottom: 12px;
  }
  a.primary { background: #caf300; color: #171e00; }
  a.store { background: #262626; color: #e6e6e6; border: 1px solid #353535; }
  .hint { font-size: 13px; color: #9a9a9a; margin-top: 16px; line-height: 1.4; }
</style>
</head>
<body>
  <div class="card">
    <p class="label">CONVOTRACK</p>
    <h1>You're invited to a ride</h1>
    ${code ? `<div class="code">${code}</div>` : ''}
    <a class="btn primary" href="${scheme}">OPEN IN CONVOTRACK</a>
    <a class="btn store" href="${APP_STORE_URL}">Get it on the App Store</a>
    <a class="btn store" href="${PLAY_STORE_URL}">Get it on Google Play</a>
    <p class="hint">Have the app? Tap “Open in ConvoTrack”. New here? Install the app, then
    enter code <b>${code || '——————'}</b> to join.</p>
  </div>
</body>
</html>`;
}

export async function deeplinkRoutes(fastify: FastifyInstance): Promise<void> {
  // iOS Universal Links — must be served as JSON with no redirect and no extension.
  fastify.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    reply.type('application/json').send({
      applinks: {
        details: [
          {
            appIDs: [IOS_APP_ID],
            components: [
              { '/': `${JOIN_PATH_PREFIX}/*`, comment: 'Ride invite links' },
            ],
          },
        ],
      },
    });
  });

  // Android App Links.
  fastify.get('/.well-known/assetlinks.json', async (_req, reply) => {
    reply.type('application/json').send([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: ANDROID_SHA256_FINGERPRINTS,
        },
      },
    ]);
  });

  // Fallback landing page (only reached when the app isn't installed/verified).
  fastify.get('/convotrack/join/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    reply.type('text/html').send(landingPage(sanitizeCode(code)));
  });
}
