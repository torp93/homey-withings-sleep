'use strict';

const { WithingsApi } = require('./lib/withings-api');

/** Never echo a secret back to the settings page; say only whether one exists. */
function describe(value, homey) {
  if (!value) return null;
  return `${String(value).slice(0, 6)}… (${homey.__('settings.check.chars', { n: String(value).length })})`;
}

/** Enough of an identifier to line up with the app log, too little to identify anyone. */
function tail(value) {
  const s = String(value || '');
  return s.length <= 4 ? '…' : `…${s.slice(-4)}`;
}

module.exports = {
  /**
   * What each paired Withings login can actually see: its devices, how many
   * nights Withings has scored for it, and its latest weighing if a scale is
   * among the devices.
   *
   * This is the startup probe with a button on it. It exists because a user
   * whose login had landed on a profile without the mat could only learn
   * that from a diagnostics report; now the settings page says so directly.
   * Nothing here needs the app's credentials: every call runs on the paired
   * device's own token, so it works for users of the built-in application
   * and of their own alike.
   */
  async getProfiles({ homey }) {
    const driver = homey.drivers.getDriver('sleep_analyzer');
    const profiles = [];

    for (const device of driver.getDevices()) {
      const entry = {
        name: device.getName(),
        user: tail(device.userId),
        devices: [],
        nights: null,
        weight: null,
        error: null
      };

      try {
        const list = await device.api.getDevices();
        // Withings still files every sleep mat under the name of the 2014
        // sensor it descends from, which no user recognises. Say what it is.
        entry.devices = list.map(d => ({
          type: String(d.type || '?'),
          model: /aura sensor v2/i.test(String(d.model)) ? 'Sleep / Sleep Analyzer' : String(d.model || '')
        }));

        const now = Date.now();
        const nights = await device.api.getSleepSummary(device._ymd(now - 30 * 24 * 3600 * 1000), device._ymd(now));
        entry.nights = Array.isArray(nights) ? nights.length : 0;

        if (list.some(d => /scale/i.test(String(d.type)))) {
          const latest = (await device.api.getMeasures({ types: [1] }))[0];
          if (latest && latest.values[1] !== undefined) {
            entry.weight = { kg: Math.round(latest.values[1] * 10) / 10, at: latest.date * 1000 };
          }
        }
      } catch (err) {
        entry.error = err.message;
      }

      profiles.push(entry);
    }

    return profiles;
  },

  /**
   * This Homey's id and the exact URL it subscribes with.
   *
   * Separate from testCredentials so it answers instantly and works before
   * anything is configured: finding your Homey id should not require a round
   * trip to Withings, or credentials that are not filled in yet.
   */
  async getIdentity({ homey }) {
    const homeyId = await homey.cloud.getHomeyId();
    const webhookId = homey.app.webhookId;

    return {
      homeyId,
      // Falls back to a placeholder so the shape is still readable before the
      // webhook id is known. Must match device.js, slash and all.
      webhookUrl: `https://webhooks.athom.com/webhook/${webhookId || '<WEBHOOK_ID>'}/?homey=${homeyId}`,
      webhookKnown: Boolean(webhookId)
    };
  },

  /**
   * Check the credentials the app would actually use right now.
   *
   * Values typed into the settings page win over everything else, so the page
   * sends them along unsaved: you can test a correction before committing it.
   * Anything left blank falls through to the app's normal resolution order
   * (an app-settings override, then Homey.env), which is also what tells us
   * which of the two sources is live.
   */
  async testCredentials({ homey, body = {} }) {
    const app = homey.app;

    const clientId = body.clientId || app.clientId;
    const clientSecret = body.clientSecret || app.clientSecret;
    const webhookId = body.webhookId || app.webhookId;
    const webhookSecret = body.webhookSecret || app.webhookSecret;

    const result = {
      source: {
        settings: Boolean(homey.settings.get('WITHINGS_CLIENT_SECRET')),
        // Which env accessor carried it, or null. Names only, never values.
        env: app.envSource('WITHINGS_CLIENT_SECRET')
      },
      // A plain yes or no for the ordinary user: are the app's own credentials
      // in place, so nothing is asked of them? Never the value itself.
      builtInConfigured: Boolean(
        app.envSource('WITHINGS_CLIENT_ID') && app.envSource('WITHINGS_CLIENT_SECRET')
      ),
      // Same probe across all four keys, so a partially delivered environment
      // is visible rather than looking like a total failure.
      envProbe: Object.fromEntries(
        Object.entries(app.envSources).map(([name, env]) => [
          name,
          ['WITHINGS_CLIENT_ID', 'WITHINGS_CLIENT_SECRET', 'WEBHOOK_ID', 'WEBHOOK_SECRET']
            .filter(k => env && Object.prototype.hasOwnProperty.call(env, k) && env[k])
        ])
      ),
      clientId: describe(clientId, homey),
      homeyId: null,
      // The exact string this Homey subscribes with. Shown so nobody has to go
      // hunting for their Homey id in the developer tools.
      webhookUrl: null,
      withings: { ok: false, message: '' },
      webhook: { ok: false, message: '' }
    };

    // --- Withings -----------------------------------------------------------
    if (!clientId || !clientSecret) {
      result.withings.message = homey.__('settings.check.missing_credentials');
    } else {
      try {
        const api = new WithingsApi({ clientId, clientSecret });
        await api.verifyCredentials();
        result.withings.ok = true;
        result.withings.message = homey.__('settings.check.withings_ok');
      } catch (err) {
        // Withings answers HTTP 200 and puts the failure in the body, so the
        // status here is theirs, not the transport's.
        result.withings.message = err.status
          ? homey.__('settings.check.withings_rejected', { status: err.status, message: err.message })
          : homey.__('settings.check.withings_unreachable', { message: err.message });
      }
    }

    // --- Webhook ------------------------------------------------------------
    try {
      result.homeyId = await homey.cloud.getHomeyId();
    } catch {
      // Reported below; the Withings result above is still worth returning.
    }

    if (!webhookId || !webhookSecret) {
      result.webhook.message = homey.__('settings.check.webhook_missing');
    } else {
      try {
        const homeyId = result.homeyId;
        if (!homeyId) throw new Error(homey.__('settings.check.no_homey_id'));

        // Must match drivers/sleep_analyzer/device.js exactly: this is the
        // string Withings is asked to deliver to.
        const url = `https://webhooks.athom.com/webhook/${webhookId}/?homey=${homeyId}`;
        result.webhookUrl = url;

        // Withings requires the callback to answer HEAD with a 2xx before it
        // will accept a subscription, so that is exactly what we check.
        const response = await fetch(url, { method: 'HEAD' });

        result.webhook.ok = response.ok;
        result.webhook.message = response.ok
          ? homey.__('settings.check.webhook_ok')
          : homey.__('settings.check.webhook_status', { status: response.status });
      } catch (err) {
        result.webhook.message = homey.__('settings.check.webhook_unreachable', { message: err.message });
      }
    }

    return result;
  }
};
