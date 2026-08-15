'use strict';

const Homey = require('homey');
const { version } = require('./app.json');
const credentials = require('./lib/credentials');

const CONFIG_KEYS = [
  'WITHINGS_CLIENT_ID',
  'WITHINGS_CLIENT_SECRET',
  'WEBHOOK_ID',
  'WEBHOOK_SECRET'
];

class WithingsSleepApp extends Homey.App {
  async onInit() {
    this.registerFlowCards();

    const missing = CONFIG_KEYS.filter(key => !this._config(key));
    if (missing.length) {
      this.error(`Missing configuration: ${missing.join(', ')} — set these in the app settings.`);
    }

    this.log(`Withings Sleep v${version} initialized (webhook: ${this.hasWebhookConfig ? 'configured' : 'not configured, polling only'})`);
  }

  /**
   * Settings, then env.json, then the values compiled into lib/credentials.js.
   *
   * env.json is the documented mechanism but does not reach the app on Homey
   * Pro firmware 13.4.0 via `homey app run --remote`: the CLI reads the file
   * and passes it to runApp(), yet `this.homey.env` arrives empty. It stays in
   * the chain so the app keeps working if that is ever fixed.
   *
   * Settings win so a value can be corrected from the app's settings page
   * without editing source or reinstalling.
   */
  _config(key) {
    const fromSettings = this.homey.settings.get(key);
    if (fromSettings) return fromSettings;

    const fromEnv = (this.homey.env || {})[key];
    if (fromEnv) return fromEnv;

    return credentials[key];
  }

  get clientId() {
    return this._config('WITHINGS_CLIENT_ID');
  }

  get clientSecret() {
    return this._config('WITHINGS_CLIENT_SECRET');
  }

  get webhookId() {
    return this._config('WEBHOOK_ID');
  }

  get webhookSecret() {
    return this._config('WEBHOOK_SECRET');
  }

  get redirectUri() {
    return this._config('WITHINGS_REDIRECT_URI') || 'https://callback.athom.com/oauth2/callback';
  }

  get hasWebhookConfig() {
    return Boolean(this.webhookId && this.webhookSecret);
  }

  registerFlowCards() {
    this.homey.flow
      .getConditionCard('withings_is_in_bed')
      .registerRunListener(({ device }) =>
        Boolean(device.getCapabilityValue('withings_in_bed')));

    this.homey.flow
      .getActionCard('withings_resubscribe')
      .registerRunListener(({ device }) => device.renewSubscriptions());
  }
}

module.exports = WithingsSleepApp;
