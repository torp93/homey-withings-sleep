'use strict';

const crypto = require('crypto');

const ACCOUNT_URL = 'https://account.withings.com';
const API_URL = 'https://wbsapi.withings.net';

// Notification categories (appli) used by this app.
const APPLI_SLEEP = 44;
const APPLI_BED_IN = 50;
const APPLI_BED_OUT = 51;

const BED_APPLIS = [APPLI_BED_IN, APPLI_BED_OUT];

// Bed events (appli 50/51) require user.sleepevents. The v2/sleep series used
// by the polling fallback needs user.activity — without it that call returns
// 403 Insufficient_scope while the webhook path keeps working fine.
const SCOPES = ['user.info', 'user.metrics', 'user.activity', 'user.sleepevents'];

/**
 * Withings signs a subset of the request parameters, sorted by parameter name
 * and joined with commas, using the client secret as an HMAC-SHA256 key.
 */
function buildSignature(params, clientSecret) {
  const payload = Object.keys(params)
    .sort()
    .map(key => params[key])
    .join(',');

  return crypto.createHmac('sha256', clientSecret).update(payload).digest('hex');
}

/**
 * Withings echoes callback URLs back in `notify list` without guaranteeing the
 * exact spelling we sent: a trailing slash or reordered query parameters are
 * enough to make a naive string compare miss. Missing an existing subscription
 * means resubscribing forever; matching a foreign one means never repairing.
 */
function normalizeCallbackUrl(value) {
  if (!value) return '';

  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const query = params.map(([key, val]) => `${key}=${val}`).join('&');

    return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ''}`;
  } catch {
    return String(value).trim().replace(/\/+$/, '');
  }
}

class WithingsError extends Error {
  constructor(status, message) {
    super(`Withings API error ${status}: ${message}`);
    this.status = status;
  }
}

class WithingsApi {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {string} options.redirectUri
   * @param {object} [options.tokens] { accessToken, refreshToken, expiresAt, userId }
   * @param {function} [options.onTokens] Called whenever tokens change, so the
   *   caller can persist them. Receives the new token object.
   * @param {function} [options.fetchImpl] Injectable for tests.
   */
  constructor({ clientId, clientSecret, redirectUri, tokens = {}, onTokens, fetchImpl } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.tokens = { ...tokens };
    this.onTokens = onTokens;
    this.fetch = fetchImpl || globalThis.fetch;
    this._refreshing = null;
  }

  static get APPLI() {
    return {
      SLEEP: APPLI_SLEEP,
      BED_IN: APPLI_BED_IN,
      BED_OUT: APPLI_BED_OUT
    };
  }

  static get BED_APPLIS() {
    return [...BED_APPLIS];
  }

  /**
   * `state` is optional on purpose: Homey's createOAuth2Callback appends its
   * own state to correlate the redirect, so callers inside a pair session
   * should leave it out.
   */
  static buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES.join(','),
      redirect_uri: redirectUri
    });

    if (state) query.set('state', state);

    return `${ACCOUNT_URL}/oauth2_user/authorize2?${query.toString()}`;
  }

  /** POST form-encoded and unwrap Withings' {status, body} envelope. */
  async _post(path, params) {
    const response = await this.fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });

    if (!response.ok) {
      throw new WithingsError(response.status, `HTTP ${response.status}`);
    }

    const json = await response.json();

    // Withings always returns HTTP 200 and signals failure in the body.
    if (json.status !== 0) {
      throw new WithingsError(json.status, json.error || 'unknown error');
    }

    return json.body || {};
  }

  /**
   * The token endpoint requires a fresh nonce, itself signed with the client
   * secret. Both calls are signed; nothing here uses the access token.
   */
  async _getNonce() {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
      action: 'getnonce',
      client_id: this.clientId,
      timestamp
    };

    const body = await this._post('/v2/signature', {
      ...params,
      signature: buildSignature(params, this.clientSecret)
    });

    return body.nonce;
  }

  async _requestToken(grantParams) {
    const nonce = await this._getNonce();
    const signed = {
      action: 'requesttoken',
      client_id: this.clientId,
      nonce
    };

    const body = await this._post('/v2/oauth2', {
      ...signed,
      ...grantParams,
      client_secret: this.clientSecret,
      signature: buildSignature(signed, this.clientSecret)
    });

    return this._storeTokens(body);
  }

  _storeTokens(body) {
    this.tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      // Expire a minute early so a request never races the deadline.
      expiresAt: Date.now() + ((Number(body.expires_in) || 0) - 60) * 1000,
      userId: String(body.userid ?? this.tokens.userId ?? '')
    };

    if (this.onTokens) this.onTokens(this.tokens);
    return this.tokens;
  }

  /**
   * Prove that the client ID and secret are a valid pair, without needing a
   * user to be authorized. Asking for a nonce is the cheapest call Withings
   * offers that actually verifies the HMAC signature: a wrong secret fails
   * here exactly as it would during a token refresh.
   */
  async verifyCredentials() {
    const nonce = await this._getNonce();
    if (!nonce) throw new WithingsError(0, 'no nonce returned');
    return true;
  }

  async exchangeCode(code) {
    return this._requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri
    });
  }

  async refresh() {
    // Collapse concurrent refreshes; a burst of calls must not spend the
    // refresh token more than once.
    if (!this._refreshing) {
      this._refreshing = this._requestToken({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken
      }).finally(() => {
        this._refreshing = null;
      });
    }

    return this._refreshing;
  }

  async _accessToken() {
    if (!this.tokens.accessToken) throw new Error('Not authorized');
    if (Date.now() >= (this.tokens.expiresAt || 0)) await this.refresh();
    return this.tokens.accessToken;
  }

  /** Authenticated call, retrying once after a forced refresh on 401. */
  async _authed(path, params, { retry = true } = {}) {
    const accessToken = await this._accessToken();

    const response = await this.fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${accessToken}`
      },
      body: new URLSearchParams(params).toString()
    });

    const json = await response.json();

    if (json.status === 401 && retry) {
      await this.refresh();
      return this._authed(path, params, { retry: false });
    }

    if (json.status !== 0) {
      throw new WithingsError(json.status, json.error || 'unknown error');
    }

    return json.body || {};
  }

  /**
   * Subscriptions are per-category and independent: losing appli 50/51 while
   * appli 1 keeps working is exactly the failure this app exists to avoid.
   */
  async subscribe(callbackUrl, appli, comment = 'Homey') {
    return this._authed('/notify', {
      action: 'subscribe',
      callbackurl: callbackUrl,
      appli,
      comment
    });
  }

  async listSubscriptions(appli) {
    const body = await this._authed('/notify', {
      action: 'list',
      ...(appli === undefined ? {} : { appli })
    });

    return body.profiles || [];
  }

  async revoke(callbackUrl, appli) {
    return this._authed('/notify', {
      action: 'revoke',
      callbackurl: callbackUrl,
      appli
    });
  }

  /**
   * Ensure every category in `applis` is subscribed for this callback URL.
   * Returns the categories that were (re)created.
   */
  async ensureSubscriptions(callbackUrl, applis = BED_APPLIS) {
    const created = [];
    const wanted = normalizeCallbackUrl(callbackUrl);

    for (const appli of applis) {
      const existing = await this.listSubscriptions(appli);
      const active = existing.some(
        profile => normalizeCallbackUrl(profile.callbackurl) === wanted);

      if (!active) {
        await this.subscribe(callbackUrl, appli);
        created.push(appli);
      }
    }

    return created;
  }

  /**
   * Completed sleep sessions, one per night, as Withings has scored them.
   *
   * Different endpoint and different date format from getSleepSeries: this one
   * takes calendar days, not epochs, and only returns a night once Withings
   * has finished processing it. That is why it can fill in last night at
   * startup when the raw series is already empty.
   *
   * @param {string} startYmd YYYY-MM-DD
   * @param {string} endYmd YYYY-MM-DD
   */
  async getSleepSummary(startYmd, endYmd) {
    const body = await this._authed('/v2/sleep', {
      action: 'getsummary',
      startdateymd: startYmd,
      enddateymd: endYmd
    });

    return body.series || [];
  }

  async getSleepSeries(startDate, endDate) {
    const body = await this._authed('/v2/sleep', {
      action: 'get',
      startdate: startDate,
      enddate: endDate,
      data_fields: 'hr,rr'
    });

    return body.series || [];
  }
}

module.exports = {
  WithingsApi,
  WithingsError,
  buildSignature,
  normalizeCallbackUrl,
  SCOPES
};
