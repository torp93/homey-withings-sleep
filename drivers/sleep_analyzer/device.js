'use strict';

const Homey = require('homey');
const { WithingsApi } = require('../../lib/withings-api');
const { parseNotification, deriveBedState } = require('../../lib/bed-state');

class SleepAnalyzerDevice extends Homey.Device {
  async onInit() {
    this.userId = this.getStore().userId || this.getData().id;

    this.api = new WithingsApi({
      clientId: this.homey.app.clientId,
      clientSecret: this.homey.app.clientSecret,
      redirectUri: this.homey.app.redirectUri,
      tokens: this.getStore(),
      onTokens: tokens => this._persistTokens(tokens)
    });

    await this._addMissingCapabilities();

    // Without a starting point the counters would sit empty until the next bed
    // event, which can be a whole day away. Anchor them to now instead; the
    // first real event replaces this with a true timestamp.
    if (!this.getStoreValue('stateSince')) {
      await this.setStoreValue('stateSince', Date.now()).catch(this.error);
      this.log('No previous state timestamp, anchoring duration counters to now.');
    }

    await this._setupWebhook();
    this._startTimers();
    await this._updateDurations();

    // Do not block onInit on the network; a failure here must not leave the
    // device permanently unavailable.
    this.renewSubscriptions().catch(err => this.error('Initial subscribe failed:', err));
  }

  /**
   * A device paired before these capabilities existed keeps its original set,
   * so add anything missing rather than making the user re-pair.
   */
  async _addMissingCapabilities() {
    const wanted = [
      'withings_in_bed',
      'withings_bedtime',
      'withings_wakeup_time',
      'withings_time_in_bed',
      'withings_time_out_of_bed',
      'withings_last_sleep_duration',
      'withings_subscription_ok'
    ];

    for (const capability of wanted) {
      if (this.hasCapability(capability)) continue;

      try {
        await this.addCapability(capability);
        this.log(`Added capability ${capability}`);
      } catch (err) {
        this.error(`Could not add capability ${capability}:`, err);
      }
    }
  }

  async _persistTokens(tokens) {
    try {
      for (const [key, value] of Object.entries(tokens)) {
        await this.setStoreValue(key, value);
      }
    } catch (err) {
      this.error('Could not persist tokens:', err);
    }
  }

  get webhookUrl() {
    return this._webhookUrl || null;
  }

  async _setupWebhook() {
    if (!this.homey.app.hasWebhookConfig) {
      this.log('No webhook configured, falling back to polling.');
      return;
    }

    const webhookId = this.homey.app.webhookId;
    const webhookSecret = this.homey.app.webhookSecret;

    try {
      const homeyId = await this.homey.cloud.getHomeyId();

      // Exactly the shape Homey's webhook dialog prints, trailing slash and
      // all: this string must also be registered verbatim at Withings.
      this._webhookUrl = `https://webhooks.athom.com/webhook/${webhookId}/?homey=${homeyId}`;

      this._webhook = await this.homey.cloud.createWebhook(webhookId, webhookSecret, {});
      this._webhook.on('message', args => this._onWebhookMessage(args));

      this.log(`Webhook ready: ${this._webhookUrl}`);
    } catch (err) {
      this.error('Webhook setup failed, polling only:', err);
      this._webhookUrl = null;
    }
  }

  _onWebhookMessage(args) {
    const { body, query, headers } = args || {};

    // Logged before any filtering: a dropped notification is otherwise
    // indistinguishable from one Withings never sent.
    this.log(`Webhook hit. body(${typeof body})=${JSON.stringify(body)} query=${JSON.stringify(query)} content-type=${headers && headers['content-type']}`);

    const event = parseNotification(body);
    if (!event) {
      this.error('Webhook payload not recognised as a bed event, ignored.');
      return;
    }

    // One webhook serves the whole Homey; ignore other Withings profiles.
    if (this.userId && event.userId !== String(this.userId)) {
      this.error(`Webhook for user ${event.userId} ignored; this device is user ${this.userId}.`);
      return;
    }

    this.log(`Webhook: appli ${event.appli} → ${event.inBed ? 'in bed' : 'out of bed'}`);

    // Withings stamps the event itself; delivery adds a few seconds, so prefer
    // their clock over ours for the displayed time.
    this._setBedState(event.inBed, event.date ? event.date * 1000 : Date.now());
  }

  /** Local wall-clock time, in Homey's own timezone. */
  _formatClock(epochMs) {
    return new Date(epochMs).toLocaleTimeString('nb-NO', {
      timeZone: this.homey.clock.getTimezone(),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  async _setBedState(inBed, eventMs = Date.now()) {
    const previous = this.getCapabilityValue('withings_in_bed');
    await this.setCapabilityValue('withings_in_bed', inBed).catch(this.error);

    if (previous === inBed) {
      // Same state, but the clock still moved.
      await this._updateDurations();
      return;
    }

    // Anchor everything to Withings' own event time, not to when the webhook
    // happened to arrive. Delivery lag is small but real, and a replayed or
    // delayed notification would otherwise compute a nonsense duration.
    const since = this.getStoreValue('stateSince') || eventMs;
    const clock = this._formatClock(eventMs);

    if (inBed) {
      await this.setCapabilityValue('withings_bedtime', clock).catch(this.error);
      this.log(`Bedtime: ${clock}`);
    } else {
      await this.setCapabilityValue('withings_wakeup_time', clock).catch(this.error);
      this.log(`Got up: ${clock}`);
    }

    // Leaving the bed completes a session worth keeping: one value per night
    // makes a readable Insights series, unlike the sawtooth of a live counter.
    if (previous === true && inBed === false) {
      const minutes = Math.max(0, Math.round((eventMs - since) / 60000));
      await this.setCapabilityValue('withings_last_sleep_duration', minutes).catch(this.error);
      this.log(`Completed bed session: ${minutes} min`);
    }

    await this.setStoreValue('stateSince', eventMs).catch(this.error);
    await this._updateDurations();

    const trigger = inBed ? this.driver.bedInTrigger : this.driver.bedOutTrigger;
    trigger.trigger(this).catch(err => this.error('Trigger failed:', err));
  }

  /**
   * Only one of the two counters runs at a time; the other sits at zero. That
   * keeps each Insights graph about a single thing instead of interleaving two
   * unrelated stretches of time.
   */
  async _updateDurations() {
    const since = this.getStoreValue('stateSince');
    if (!since) return;

    const inBed = this.getCapabilityValue('withings_in_bed') === true;
    const minutes = Math.max(0, Math.floor((Date.now() - since) / 60000));

    await this.setCapabilityValue('withings_time_in_bed', inBed ? minutes : 0).catch(this.error);
    await this.setCapabilityValue('withings_time_out_of_bed', inBed ? 0 : minutes).catch(this.error);
  }

  /**
   * Verifies the bed-in and bed-out subscriptions still exist at Withings and
   * recreates any that vanished. This is the whole point of the app: the
   * official integration subscribes once at pair time and never checks again.
   */
  async renewSubscriptions() {
    if (!this.webhookUrl) {
      await this.setCapabilityValue('withings_subscription_ok', false).catch(this.error);
      return false;
    }

    try {
      const created = await this.api.ensureSubscriptions(this.webhookUrl);
      const wasOk = this.getCapabilityValue('withings_subscription_ok');

      // What Withings believes it will call, in its own words.
      for (const appli of WithingsApi.BED_APPLIS) {
        const profiles = await this.api.listSubscriptions(appli);
        this.log(`Withings subscriptions for appli ${appli}: ${JSON.stringify(profiles)}`);
      }

      await this.setCapabilityValue('withings_subscription_ok', true).catch(this.error);
      await this.setAvailable().catch(this.error);

      if (created.length > 0) {
        this.log(`Recreated subscriptions for appli: ${created.join(', ')}`);

        // Only alert if we had previously confirmed a healthy subscription;
        // creating them for the first time is not a fault.
        if (wasOk === true) {
          this.driver.subscriptionLostTrigger.trigger(this).catch(this.error);
        }
      }

      return true;
    } catch (err) {
      this.error('Subscription renewal failed:', err);
      await this.setCapabilityValue('withings_subscription_ok', false).catch(this.error);
      await this.setUnavailable(`Withings: ${err.message}`).catch(this.error);
      return false;
    }
  }

  async _poll() {
    const now = Math.floor(Date.now() / 1000);
    const window = Number(this.getSetting('bed_freshness_seconds')) || 300;

    try {
      const series = await this.api.getSleepSeries(now - window * 2, now);
      await this._setBedState(deriveBedState(series, now, window));
      await this.setAvailable().catch(this.error);
    } catch (err) {
      // A token issued before user.activity was requested cannot read the
      // sleep series. Retrying every interval would only repeat the error, so
      // stop polling and say what would fix it.
      if (err.status === 403) {
        this.log('Polling disabled: the token lacks user.activity. Re-pair the device to enable the polling fallback.');
        if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
        this._pollTimer = null;
        return;
      }

      this.error('Poll failed:', err);
    }
  }

  _startTimers() {
    this._stopTimers();

    // Polling exists only for installations without a webhook. When the
    // webhook is live it is the authoritative source, and polling would add
    // API calls and latency for nothing.
    const pollSeconds = Number(this.getSetting('poll_interval_seconds')) || 0;
    if (pollSeconds > 0 && !this.webhookUrl) {
      this._pollTimer = this.homey.setInterval(() => this._poll(), pollSeconds * 1000);
    }

    const renewHours = Number(this.getSetting('resubscribe_hours')) || 6;
    this._renewTimer = this.homey.setInterval(
      () => this.renewSubscriptions().catch(err => this.error(err)),
      renewHours * 3600 * 1000
    );

    // The counters advance on their own between webhooks.
    this._durationTimer = this.homey.setInterval(
      () => this._updateDurations().catch(err => this.error(err)),
      60 * 1000
    );
  }

  _stopTimers() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    if (this._renewTimer) this.homey.clearInterval(this._renewTimer);
    if (this._durationTimer) this.homey.clearInterval(this._durationTimer);
    this._pollTimer = null;
    this._renewTimer = null;
    this._durationTimer = null;
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some(key => key === 'poll_interval_seconds' || key === 'resubscribe_hours')) {
      this._startTimers();
    }
  }

  async onUninit() {
    this._stopTimers();
  }

  async onDeleted() {
    this._stopTimers();

    if (this._webhook) {
      await this.homey.cloud.unregisterWebhook(this._webhook).catch(this.error);
    }

    // Leave Withings tidy so a re-pair starts from a clean slate.
    if (this.webhookUrl) {
      for (const appli of WithingsApi.BED_APPLIS) {
        await this.api.revoke(this.webhookUrl, appli).catch(err =>
          this.error(`Revoke appli ${appli} failed:`, err));
      }
    }
  }
}

module.exports = SleepAnalyzerDevice;
