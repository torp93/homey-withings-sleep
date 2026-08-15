'use strict';

const { WithingsApi } = require('./lib/withings-api');

/** Never echo a secret back to the settings page; say only whether one exists. */
function describe(value) {
  if (!value) return null;
  return `${String(value).slice(0, 6)}… (${String(value).length} tegn)`;
}

module.exports = {
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
        env: Boolean((homey.env || {}).WITHINGS_CLIENT_SECRET)
      },
      clientId: describe(clientId),
      homeyId: null,
      // The exact string this Homey subscribes with. Shown so nobody has to go
      // hunting for their Homey id in the developer tools.
      webhookUrl: null,
      withings: { ok: false, message: '' },
      webhook: { ok: false, message: '' }
    };

    // --- Withings -----------------------------------------------------------
    if (!clientId || !clientSecret) {
      result.withings.message = 'Client ID eller secret mangler.';
    } else {
      try {
        const api = new WithingsApi({ clientId, clientSecret });
        await api.verifyCredentials();
        result.withings.ok = true;
        result.withings.message = 'Withings godtok ID og secret.';
      } catch (err) {
        // Withings answers HTTP 200 and puts the failure in the body, so the
        // status here is theirs, not the transport's.
        result.withings.message = err.status
          ? `Withings avviste kallet (${err.status}): ${err.message}`
          : `Kunne ikke nå Withings: ${err.message}`;
      }
    }

    // --- Webhook ------------------------------------------------------------
    try {
      result.homeyId = await homey.cloud.getHomeyId();
    } catch {
      // Reported below; the Withings result above is still worth returning.
    }

    if (!webhookId || !webhookSecret) {
      result.webhook.message = 'Ikke satt opp, appen faller tilbake til polling.';
    } else {
      try {
        const homeyId = result.homeyId;
        if (!homeyId) throw new Error('fant ikke Homey-ID');

        // Must match drivers/sleep_analyzer/device.js exactly: this is the
        // string Withings is asked to deliver to.
        const url = `https://webhooks.athom.com/webhook/${webhookId}/?homey=${homeyId}`;
        result.webhookUrl = url;

        // Withings requires the callback to answer HEAD with a 2xx before it
        // will accept a subscription, so that is exactly what we check.
        const response = await fetch(url, { method: 'HEAD' });

        result.webhook.ok = response.ok;
        result.webhook.message = response.ok
          ? 'Athoms webhook svarer.'
          : `Webhook svarte HTTP ${response.status}.`;
      } catch (err) {
        result.webhook.message = `Kunne ikke nå webhooken: ${err.message}`;
      }
    }

    return result;
  }
};
