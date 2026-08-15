Bed presence from the Withings Sleep Analyzer, built to survive the failure that silently breaks bed automation.

Withings' notification API uses a separate subscription per data category. An app that subscribes once at pairing time and never checks again will eventually stop receiving bed events: the subscriptions for getting into and out of bed lapse, while weight data keeps flowing and the login stays valid. Everything looks healthy, but the bed triggers never fire again, and nothing reports an error.

This app verifies both bed subscriptions on a timer and recreates any that have vanished. The subscription state is a capability of its own, so the failure is visible instead of silent, and a flow trigger fires if it ever happens.

WHAT YOU GET

- In bed / out of bed, updated in realtime
- Bedtime and the time you got up
- Time in bed and time out of bed, as live counters
- Last night in bed, one value per completed night
- Notification status, so you can see the connection is healthy

FLOW CARDS

- When someone gets into bed
- When someone gets out of bed
- When the Withings notification subscription is lost
- And someone is / isn't in bed
- Renew the Withings notification subscription

SETUP

You need a Withings account with a Sleep Analyzer, and a free developer application registered at the Withings Partner Hub to get a client ID and secret. Enter these in the app's settings.

Realtime events also need a Homey webhook, registered at tools.developer.homey.app. Without one the app falls back to polling and keeps working, but loses instant triggering.

Full setup instructions: https://github.com/torp93/homey-withings-sleep

This app is not made by or affiliated with Withings.
