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

    // Names only: which accessor carries each key, never the value itself.
    const seen = Object.entries(this.envSources)
      .map(([name, env]) => `${name}=[${CONFIG_KEYS.filter(k => env && env[k]).join(' ') || 'tom'}]`)
      .join(' ');
    this.log(`Environment probe: ${seen}`);

    const missing = CONFIG_KEYS.filter(key => !this._config(key));
    if (missing.length) {
      this.error(`Missing configuration: ${missing.join(', ')}: set these in the app settings.`);
    }

    this.log(`Withings Sleep v${version} initialized (webhook: ${this.hasWebhookConfig ? 'configured' : 'not configured, polling only'})`);
  }

  /**
   * Every place the environment from env.json could plausibly surface.
   *
   * The CLI logs these values as "Homey.env" and uploads them with the build,
   * but on Homey Pro 13.4.0 `this.homey.env` reads empty in both a devkit
   * install and a store install. Rather than guess which accessor is the
   * documented one, read both: the app works whichever is populated,
   * and envSource() reports the winner so the ambiguity is observable instead
   * of theoretical.
   */
  get envSources() {
    return {
      'this.homey.env': this.homey.env || {},
      'Homey.env': Homey.env || {}
    };
  }

  /** Which env accessor, if any, carries a given key. */
  envSource(key) {
    const found = Object.entries(this.envSources).find(([, env]) => env && env[key]);
    return found ? found[0] : null;
  }

  /**
   * An explicit app-settings override, then the environment.
   *
   * The environment comes from env.json, which the CLI delivers separately
   * from the app archive; the archive never carries it. Nothing is compiled
   * into the source tree, so no secret ships inside a published build.
   *
   * Settings win so a value can be corrected from the app's settings page
   * without editing source or reinstalling.
   */
  _config(key) {
    const fromSettings = this.homey.settings.get(key);
    if (fromSettings) return fromSettings;

    for (const env of Object.values(this.envSources)) {
      if (env && env[key]) return env[key];
    }

    return undefined;
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

  /**
   * The trailing slash is deliberate: this is the form Homey's OAuth callback
   * actually uses, and Withings compares registered URLs byte for byte. The
   * unslashed variant fails with an opaque redirect_uri_mismatch. Overridable
   * only for the case where a future Athom change drops the slash.
   */
  get redirectUri() {
    return this._config('WITHINGS_REDIRECT_URI') || 'https://callback.athom.com/oauth2/callback/';
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
      .getConditionCard('withings_in_bed_longer_than')
      .registerRunListener(({ device, minutes }) => {
        // Only meaningful while the bed is occupied: the counter reads zero
        // otherwise, and "out of bed for two hours" is a different question.
        if (device.getCapabilityValue('withings_in_bed') !== true) return false;
        return Number(device.getCapabilityValue('withings_time_in_bed')) > Number(minutes);
      });

    this.homey.flow
      .getActionCard('withings_resubscribe')
      .registerRunListener(({ device }) => device.renewSubscriptions());
  }
}

module.exports = WithingsSleepApp;
