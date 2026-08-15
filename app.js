'use strict';

const Homey = require('homey');
const { version } = require('./app.json');

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
   * An explicit app-settings override, then Homey.env.
   *
   * Homey.env comes from env.json, which the CLI reads and delivers to the
   * running app separately from the app archive — the archive never carries
   * it. Nothing is compiled into the source tree, so no secret ships inside a
   * published build.
   *
   * Settings win so a value can be corrected from the app's settings page
   * without editing source or reinstalling.
   */
  _config(key) {
    const fromSettings = this.homey.settings.get(key);
    if (fromSettings) return fromSettings;

    return (this.homey.env || {})[key];
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
