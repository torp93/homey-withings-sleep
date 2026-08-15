'use strict';

const Homey = require('homey');
const { WithingsApi } = require('../../lib/withings-api');

class SleepAnalyzerDriver extends Homey.Driver {
  async onInit() {
    this.bedInTrigger = this.homey.flow.getDeviceTriggerCard('withings_bed_in');
    this.bedOutTrigger = this.homey.flow.getDeviceTriggerCard('withings_bed_out');
    this.subscriptionLostTrigger = this.homey.flow.getDeviceTriggerCard('withings_subscription_lost');
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
