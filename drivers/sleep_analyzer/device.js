'use strict';

const Homey = require('homey');
const { WithingsApi } = require('../../lib/withings-api');
const {
  parseNotification,
  deriveBedState,
  shouldAcceptEvent,
  rememberEvent,
  summariseLastNight
} = require('../../lib/bed-state');

/** Enough of an identifier to correlate log lines, too little to identify anyone. */
function tag(value) {
  if (!value) return '-';
  const s = String(value);
  return s.length <= 4 ? '…' : `…${s.slice(-4)}`;
}

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
    this._backfillLastNight().catch(err => this.error('Backfill failed:', err));
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
    const { body, headers } = args || {};

    // Shape only. The payload carries a Withings user id and device id, so it
    // is never logged verbatim.
    this.log(`Webhook hit, body is ${typeof body}, content-type ${(headers && headers['content-type']) || 'unset'}`);

    const event = parseNotification(body);
    if (!event) {
      // Field names only, never values: enough to tell an empty delivery from
      // a payload we are failing to read, without logging who or which mat.
      const shape = body && typeof body === 'object'
        ? `keys=[${Object.keys(body).join(' ') || 'none'}]`
        : `raw ${typeof body} length=${body ? String(body).length : 0}`;

      const extras = Object.keys(args || {}).join(' ');
      this.error(`Webhook payload not recognised as a bed event, ignored. ${shape} args=[${extras}]`);
      return;
    }

    // One webhook serves the whole Homey; ignore other Withings profiles.
    if (this.userId && event.userId !== String(this.userId)) {
      this.error(`Webhook for user ${tag(event.userId)} ignored, this device is ${tag(this.userId)}.`);
      return;
    }

    // Several Sleep Analyzers on one account each have their own device id.
    const boundDevice = this.getStoreValue('deviceId');
    if (boundDevice && event.deviceId && event.deviceId !== boundDevice) {
      this.error(`Webhook for mat ${tag(event.deviceId)} ignored, this device is ${tag(boundDevice)}.`);
      return;
    }

    // Pairing cannot learn the mat's id; the first event carrying one binds it,
    // so a second Sleep Analyzer added later cannot drive this device.
    if (!boundDevice && event.deviceId) {
      this.setStoreValue('deviceId', event.deviceId).catch(this.error);
      this.log(`Bound to mat ${tag(event.deviceId)}.`);
    }

    const verdict = shouldAcceptEvent(event, {
      seen: this.getStoreValue('seenEvents') || [],
      lastEventMs: this.getStoreValue('lastEventMs') || null
    });

    if (!verdict.accept) {
      // Not an error: Withings retrying is normal, and reordering happens.
      this.log(`Ignoring ${event.inBed ? 'bed in' : 'bed out'} event, ${verdict.reason}.`);
      return;
    }

    this.log(`Webhook: appli ${event.appli}, ${event.inBed ? 'in bed' : 'out of bed'}`);

    // Withings stamps the event itself; delivery adds a few seconds, so prefer
    // their clock over ours for the displayed time.
    const eventMs = event.date ? event.date * 1000 : Date.now();

    this._recordEvent(verdict.key, eventMs)
      .then(() => this._setBedState(event.inBed, eventMs))
      .catch(err => this.error('Could not handle bed event:', err));
  }

  /** Persisted so a restart cannot replay an event Withings retries afterwards. */
  async _recordEvent(key, eventMs) {
    const seen = rememberEvent(key, this.getStoreValue('seenEvents') || []);
    await this.setStoreValue('seenEvents', seen).catch(this.error);
    await this.setStoreValue('lastEventMs', eventMs).catch(this.error);
  }

  /** Calendar day in Homey's timezone, as Withings wants it: YYYY-MM-DD. */
  _ymd(epochMs) {
    return new Date(epochMs).toLocaleDateString('en-CA', {
      timeZone: this.homey.clock.getTimezone()
    });
  }

  /**
   * Fill bedtime, wake-up and last-night duration from Withings' own scoring.
   *
   * Without this the three capabilities stay blank until the device has lived
   * through a whole night, because they are otherwise only written when this
   * process observes the events itself. A freshly paired device therefore
   * looked broken even though nothing was wrong.
   *
   * Deliberately does not touch withings_in_bed and fires no Flows: this is
   * history being displayed, not a transition happening now.
   */
  async _backfillLastNight() {
    const now = Date.now();
    const from = this._ymd(now - 2 * 24 * 3600 * 1000);
    const to = this._ymd(now);

    const series = await this.api.getSleepSummary(from, to);
    const night = summariseLastNight(series);

    if (!night) {
      this.log('Backfill: Withings has no completed night to report yet.');
      return;
    }

    // Never overwrite a value this session already learned from a live event;
    // that one is newer than anything a summary can offer.
    if (!this.getCapabilityValue('withings_bedtime')) {
      await this.setCapabilityValue('withings_bedtime', this._formatClock(night.startMs)).catch(this.error);
    }

    if (!this.getCapabilityValue('withings_wakeup_time')) {
      await this.setCapabilityValue('withings_wakeup_time', this._formatClock(night.endMs)).catch(this.error);
    }

    if (!this.getCapabilityValue('withings_last_sleep_duration')) {
      await this.setCapabilityValue('withings_last_sleep_duration', night.minutes).catch(this.error);
    }

    this.log(`Backfill: last night was ${night.minutes} min, ${this._formatClock(night.startMs)} to ${this._formatClock(night.endMs)}.`);
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

  /**
   * @param {boolean} inBed
   * @param {number} eventMs When Withings says it happened.
   * @param {{silent?: boolean}} [options] `silent` updates state without firing
   *   Flows. Used for reconciliation after a restart or an outage: the state is
   *   real and must be corrected, but the transition already happened while
   *   Homey was not listening, and replaying it as a live event would run
   *   automations hours late, in the middle of the night.
   */
  async _setBedState(inBed, eventMs = Date.now(), { silent = false } = {}) {
    const previous = this.getCapabilityValue('withings_in_bed');
    await this.setCapabilityValue('withings_in_bed', inBed).catch(this.error);

    if (silent && previous !== inBed) {
      this.log(`State reconciled to ${inBed ? 'in bed' : 'out of bed'} without firing Flows.`);
      await this.setStoreValue('stateSince', eventMs).catch(this.error);
      await this._updateDurations();
      return;
    }

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

      // Count only. The profiles carry callback URLs with identifiers in them.
      for (const appli of WithingsApi.BED_APPLIS) {
        const profiles = await this.api.listSubscriptions(appli);
        this.log(`Withings reports ${profiles.length} subscription(s) for appli ${appli}.`);
      }

      await this.setCapabilityValue('withings_subscription_ok', true).catch(this.error);
      await this.unsetWarning().catch(() => {});
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
      this.error(`Subscription renewal failed (status ${err.status ?? 'none'}).`);
      await this.setCapabilityValue('withings_subscription_ok', false).catch(this.error);

      // A lost subscription is a degraded service, not a dead device: polling
      // still reports bed presence. Only an authorization that cannot be
      // repaired without the user makes the device genuinely unusable.
      const needsReauth = err.status === 401 || err.status === 403;

      if (needsReauth) {
        await this.setUnavailable(this.homey.__('error.reauthorize')).catch(this.error);
      } else {
        await this.setWarning(this.homey.__('error.subscription_degraded')).catch(() => {});
        await this.setAvailable().catch(this.error);
      }

      return false;
    }
  }

  async _poll() {
    const now = Math.floor(Date.now() / 1000);
    const window = Number(this.getSetting('bed_freshness_seconds')) || 300;

    try {
      const series = await this.api.getSleepSeries(now - window * 2, now);

      // The first poll after start is reconciliation, not a live observation:
      // whatever it finds happened before this process was listening. Later
      // polls are the live source for installations without a webhook.
      const silent = !this._reconciled;
      this._reconciled = true;

      const inBed = deriveBedState(series, now, window);

      // The one line that shows whether polling sees anything at all: without
      // it a silent webhook and an empty sleep series look identical.
      const verdict = inBed === null ? 'no data, state left as is' : `bed ${inBed ? 'occupied' : 'empty'}`;
      this.log(`Poll: ${series.length} series entr${series.length === 1 ? 'y' : 'ies'} in the last ${window * 2}s, ${verdict}.`);

      // Only a definite reading may move the state. An absent series says
      // nothing about the bed, and the webhook may know better.
      if (inBed !== null) {
        await this._setBedState(inBed, Date.now(), { silent });
      }
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

    // Polling runs alongside the webhook, not instead of it.
    //
    // A configured webhook is not the same as a delivering one: subscriptions
    // can be active at Withings while callbacks carry nothing, and then a
    // webhook-only device sits frozen with no way to notice. Both paths feed
    // the same state, and the transition guard means whichever arrives second
    // changes nothing, so the cost is API calls rather than duplicate Flows.
    const pollSeconds = Number(this.getSetting('poll_interval_seconds')) || 0;
    if (pollSeconds > 0) {
      this._pollTimer = this.homey.setInterval(() => this._poll(), pollSeconds * 1000);
      this.log(`Polling every ${pollSeconds}s${this.webhookUrl ? ' as a safety net behind the webhook' : ''}.`);
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some(key => key === 'poll_interval_seconds' || key === 'resubscribe_hours')) {
      this._startTimers();
    }

    // Homey's settings schema has no button type, so the renewal is a checkbox
    // that acts on save and clears itself. The reset has to happen after this
    // handler returns, or Homey overwrites it with the values being saved.
    if (changedKeys.includes('renew_now') && newSettings.renew_now === true) {
      this.homey.setTimeout(async () => {
        await this.setSettings({ renew_now: false }).catch(this.error);

        this.log('Manual subscription renewal requested from device settings.');
        const ok = await this.renewSubscriptions().catch(err => {
          this.error('Manual renewal failed:', err);
          return false;
        });

        this.log(ok ? 'Manual renewal succeeded.' : 'Manual renewal did not complete.');
      }, 1000);

      return this.homey.__('settings.renew_started');
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
