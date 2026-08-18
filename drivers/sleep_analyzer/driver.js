'use strict';

const Homey = require('homey');
const { WithingsApi } = require('../../lib/withings-api');

class SleepAnalyzerDriver extends Homey.Driver {
  async onInit() {
    this.bedInTrigger = this.homey.flow.getDeviceTriggerCard('withings_bed_in');
    this.bedOutTrigger = this.homey.flow.getDeviceTriggerCard('withings_bed_out');
    this.subscriptionLostTrigger = this.homey.flow.getDeviceTriggerCard('withings_subscription_lost');
    this.summaryReadyTrigger = this.homey.flow.getDeviceTriggerCard('withings_summary_ready');
    this.reauthorizeTrigger = this.homey.flow.getDeviceTriggerCard('withings_reauthorize_needed');
  }

  /**
   * Sign in again without losing the device.
   *
   * A refresh token that Withings stops accepting, an account whose access was
   * revoked, or an authorization that simply aged out all leave a device that
   * is configured correctly but can no longer read anything. Removing and
   * re-adding it fixes that at the price of every Flow, Insights series and
   * setting attached to it. Repair replaces only the tokens.
   */
  async onRepair(session, device) {
    const { clientId, clientSecret, redirectUri } = this.homey.app;

    if (!clientId || !clientSecret) {
      await session.emit('error', this.homey.__('pair.missing_credentials'));
      return;
    }

    const authorizeUrl = WithingsApi.buildAuthorizeUrl({ clientId, redirectUri });
    this.log(`Repair started, OAuth redirect_uri: ${redirectUri}`);

    const callback = await this.homey.cloud.createOAuth2Callback(authorizeUrl);

    callback
      .on('url', url => session.emit('url', url))
      .on('code', async code => {
        try {
          this.log('Repair: authorization code received, exchanging it.');
          const api = new WithingsApi({ clientId, clientSecret, redirectUri });
          const tokens = await api.exchangeCode(code);
          this.log(`Repair: exchange succeeded for user ${String(tokens.userId).slice(-4)}.`);

          // Signing in as somebody else would leave the device listening for a
          // user it can no longer match, and its bed events would be filtered
          // out in silence. Refuse instead of half-working.
          const existing = String(device.getStoreValue('userId') || device.getData().id || '');

          if (existing && String(tokens.userId) !== existing) {
            this.error('Repair aborted: a different Withings account was authorized.');
            await session.emit('error', this.homey.__('repair.wrong_account')).catch(() => {});
            return;
          }

          await device.applyTokens(tokens);
        } catch (err) {
          // Status alone said "none" and told us nothing. The message carries
          // Withings' own wording, which is what identifies the cause.
          this.error(`Repair failed at ${err.step || 'token exchange'}: status ${err.status ?? 'none'}, ${err.message}`);
          await session.emit('error', this.homey.__('repair.failed')).catch(() => {});
          return;
        }

        // The tokens are in place from here on, so the repair has succeeded
        // whatever the view does next. Telling it can fail if the session has
        // already gone away, and reporting that as a failed repair would send
        // the user round again for nothing.
        try {
          await session.emit('authorized', null);
        } catch (err) {
          this.log(`Repair finished, but the view had already closed (${err.message}).`);
        }
      });

    session.setHandler('disconnect', async () => {
      await this.homey.cloud.unregisterWebhook?.(callback).catch?.(() => {});
    });
  }

  async onPair(session) {
    const { clientId, clientSecret } = this.homey.app;
    let tokens = null;

    if (!clientId || !clientSecret) {
      session.setHandler('list_devices', async () => {
        throw new Error(this.homey.__('pair.missing_credentials'));
      });
      return;
    }

    const redirectUri = this.homey.app.redirectUri;
    const authorizeUrl = WithingsApi.buildAuthorizeUrl({ clientId, redirectUri });

    // redirect_uri_mismatch is opaque from Withings' side, so log the exact
    // string being sent for comparison against the Partner Hub registration.
    this.log(`OAuth redirect_uri: ${redirectUri}`);
    this.log(`OAuth authorize URL: ${authorizeUrl}`);

    const callback = await this.homey.cloud.createOAuth2Callback(authorizeUrl);

    callback
      .on('url', url => session.emit('url', url))
      .on('code', async code => {
        try {
          const api = new WithingsApi({
            clientId,
            clientSecret,
            redirectUri
          });

          tokens = await api.exchangeCode(code);
          await session.emit('authorized', null);
        } catch (err) {
          this.error('Token exchange failed:', err);
          await session.emit('error', err.message);
        }
      });

    session.setHandler('list_devices', async () => {
      if (!tokens) throw new Error(this.homey.__('pair.not_authorized'));

      return [
        {
          name: 'Withings Sleep Analyzer',
          data: { id: tokens.userId },
          store: tokens
        }
      ];
    });
  }
}

module.exports = SleepAnalyzerDriver;
