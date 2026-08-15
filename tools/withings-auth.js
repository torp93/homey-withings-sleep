'use strict';

/**
 * One-off token bootstrap, for when Withings will not accept Homey's OAuth
 * callback URL as a registered redirect.
 *
 * Run this on your computer, not on Homey. It performs the same signed token
 * exchange the app does, then prints the refresh token to paste into env.json.
 * From then on the app refreshes itself and never needs the pairing browser
 * flow.
 *
 * Credentials are read from env.json, which is gitignored and is never packed
 * into the app archive. The client secret is used for signing but never
 * printed.
 *
 *   node tools/withings-auth.js url [redirectUri]
 *   node tools/withings-auth.js exchange <code> [redirectUri]
 *
 * Withings invalidates the authorization code after 30 seconds, so copy it out
 * of the browser address bar and run `exchange` straight away.
 */

const fs = require('fs');
const path = require('path');

const { WithingsApi } = require('../lib/withings-api');

const ENV_PATH = path.join(__dirname, '..', 'env.json');
const DEFAULT_REDIRECT = 'https://example.com/';

const [, , command, ...rest] = process.argv;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Read the developer's local env.json, the same file the CLI feeds to Homey.env. */
function loadEnv() {
  let raw;

  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    fail(`No env.json found at ${ENV_PATH}. Copy env.json.example and fill it in.`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return fail(`env.json is not valid JSON: ${err.message}`);
  }
}

function makeApi(redirectUri) {
  const env = loadEnv();

  if (!env.WITHINGS_CLIENT_ID || !env.WITHINGS_CLIENT_SECRET) {
    fail('WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET are not set in env.json');
  }

  return new WithingsApi({
    clientId: env.WITHINGS_CLIENT_ID,
    clientSecret: env.WITHINGS_CLIENT_SECRET,
    redirectUri
  });
}

async function main() {
  if (command === 'url') {
    const redirectUri = rest[0] || DEFAULT_REDIRECT;

    console.log('\nRegister this redirect URI in the Withings Partner Hub first:');
    console.log(`  ${redirectUri}`);
    console.log('\nThen open this URL in your browser and log in:\n');
    console.log(WithingsApi.buildAuthorizeUrl({
      clientId: loadEnv().WITHINGS_CLIENT_ID,
      redirectUri
    }));
    console.log('\nAfter approving you land on the redirect URI with ?code=... in');
    console.log('the address bar. Copy that code and run, within 30 seconds:\n');
    console.log(`  node tools/withings-auth.js exchange <code> ${redirectUri}\n`);
    return;
  }

  if (command === 'exchange') {
    const code = rest[0];
    const redirectUri = rest[1] || DEFAULT_REDIRECT;

    if (!code) fail('Usage: node tools/withings-auth.js exchange <code> [redirectUri]');

    const api = makeApi(redirectUri);
    const tokens = await api.exchangeCode(code);

    console.log('\nToken exchange succeeded.\n');
    console.log(`  user id       : ${tokens.userId}`);
    console.log(`  access token  : expires ${new Date(tokens.expiresAt).toISOString()}`);
    console.log('\nPaste these into env.json (gitignored, never packed):\n');
    console.log(`  "WITHINGS_USER_ID": "${tokens.userId}",`);
    console.log(`  "WITHINGS_REFRESH_TOKEN": "${tokens.refreshToken}"\n`);
    console.log('The refresh token above is a live credential: it is valid for');
    console.log('one year and grants access to this account. Keep it out of');
    console.log('shell history, screenshots and commits.\n');
    console.log('The app renews itself from it; pairing will no longer open a');
    console.log('browser.\n');
    return;
  }

  fail('Usage:\n  node tools/withings-auth.js url [redirectUri]\n  node tools/withings-auth.js exchange <code> [redirectUri]');
}

main().catch(err => fail(`Failed: ${err.message}`));
