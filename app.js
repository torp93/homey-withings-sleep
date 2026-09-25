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
      .map(([name, env]) => `${name}=[${CONFIG_KEYS.filter(k => WithingsSleepApp._envValue(env, k)).join(' ') || 'none'}]`)
      .join(' ');
    this.log(`Environment probe: ${seen}`);

    // The probe above says what the environment carries; this says what was
    // actually used. Settings override the environment, so a value typed into
    // the advanced section silently replaces the app's own, and a report that
    // only showed the environment could not tell the two apart.
    const used = CONFIG_KEYS.map(key => `${key}=${this.configSource(key) || 'missing'}`).join(' ');
    this.log(`Credential sources in use: ${used}`);

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

  /**
   * Read a key without asking for one that is not there.
   *
   * The SDK logs "Trying to access Homey.env.X but the environment variable
   * has not been set" on a plain property read, which fills the app log with
   * warnings about optional keys. Checking first keeps the log about real
   * problems.
   */
  static _envValue(env, key) {
    if (!env || !Object.prototype.hasOwnProperty.call(env, key)) return undefined;
    return env[key];
  }

  /** Which env accessor, if any, carries a given key. */
  envSource(key) {
    const found = Object.entries(this.envSources)
      .find(([, env]) => WithingsSleepApp._envValue(env, key));

    return found ? found[0] : null;
  }

  /** Where a key's value comes from, by the same precedence as _config. */
  configSource(key) {
    if (this.homey.settings.get(key)) return 'settings';
    return this.envSource(key);
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
      const value = WithingsSleepApp._envValue(env, key);
      if (value) return value;
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

  /**
   * One webhook for the whole app, shared by every Sleep device.
   *
   * Every device subscribes Withings with the same callback URL, so they all
   * need the same deliveries. Registering the webhook per device does not do
   * that: Homey keeps one registration per webhook id, and each new
   * createWebhook replaced the previous one. Only the most recently added mat
   * then received anything, and it discarded the other profiles' events. A
   * diagnostics report with two mats on two profiles showed exactly that,
   * flipping the moment the second mat was re-paired. So the app registers once
   * and hands every delivery to all devices; each device already keeps only
   * its own profile's and mat's events.
   */
  async subscribeWebhook(device) {
    if (!this.hasWebhookConfig) return false;

    this._webhookDevices = this._webhookDevices || new Set();
    this._webhookDevices.add(device);

    // Devices initialise in parallel; share the one registration in flight
    // instead of racing to create several.
    if (!this._webhookReady) {
      this._webhookReady = this.homey.cloud.createWebhook(this.webhookId, this.webhookSecret, {})
        .then(webhook => {
          webhook.on('message', args => this._dispatchWebhook(args));
          return webhook;
        })
        .catch(err => {
          // Let the next device try again rather than caching a failure.
          this._webhookReady = null;
          throw err;
        });
    }

    await this._webhookReady;
    return true;
  }

  /**
   * A deleted device stops listening. The webhook itself stays: the other
   * devices still rely on it, and an app with no devices simply receives
   * nothing it has to act on.
   */
  unsubscribeWebhook(device) {
    if (this._webhookDevices) this._webhookDevices.delete(device);
  }

  _dispatchWebhook(args) {
    for (const device of this._webhookDevices || []) {
      // One device failing on a delivery must not keep it from the others.
      Promise.resolve()
        .then(() => device._onWebhookMessage(args))
        .catch(err => this.error(`Webhook delivery to a device failed: ${err.message}`));
    }
  }

  async onUninit() {
    if (!this._webhookReady) return;
    const webhook = await this._webhookReady.catch(() => null);
    if (webhook) await this.homey.cloud.unregisterWebhook(webhook).catch(this.error);
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
