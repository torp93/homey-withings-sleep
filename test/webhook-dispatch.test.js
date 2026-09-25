'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The homey module only exists on a Homey. The app class needs nothing from
// it for these tests but a base class to extend.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { App: class {} };
  return originalLoad.call(this, request, ...rest);
};
const WithingsSleepApp = require('../app');
Module._load = originalLoad;

// A fake Homey cloud with the one behaviour that caused the bug: a webhook id
// has a single registration, and creating it again replaces the previous one.
function fakeCloud() {
  const cloud = { created: 0, unregistered: 0, current: null, fail: false };
  cloud.createWebhook = async () => {
    if (cloud.fail) throw new Error('cloud unavailable');
    cloud.created += 1;
    const listeners = [];
    const webhook = { on: (event, fn) => listeners.push(fn), listeners };
    cloud.current = webhook;
    return webhook;
  };
  cloud.unregisterWebhook = async webhook => {
    cloud.unregistered += 1;
    if (cloud.current === webhook) cloud.current = null;
  };
  // A delivery reaches only the registration Homey currently holds.
  cloud.deliver = args => {
    if (cloud.current) cloud.current.listeners.forEach(fn => fn(args));
  };
  return cloud;
}

function makeApp(cloud) {
  const app = new WithingsSleepApp();
  app.homey = { cloud };
  app._config = key => ({ WEBHOOK_ID: 'id', WEBHOOK_SECRET: 'secret' })[key];
  app.log = () => {};
  app.errors = [];
  app.error = message => app.errors.push(message);
  return app;
}

function fakeDevice(name) {
  return { name, got: [], _onWebhookMessage(args) { this.got.push(args); } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('every mat receives every delivery, not just the newest', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);
  const first = fakeDevice('first');
  const second = fakeDevice('second');

  await app.subscribeWebhook(first);
  await app.subscribeWebhook(second);
  cloud.deliver({ body: { userid: '1' } });
  await tick();

  assert.equal(first.got.length, 1);
  assert.equal(second.got.length, 1);
});

test('devices starting together share one registration', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);

  await Promise.all([fakeDevice('a'), fakeDevice('b'), fakeDevice('c')].map(d => app.subscribeWebhook(d)));

  assert.equal(cloud.created, 1);
});

test('deleting one mat leaves the others listening', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);
  const kept = fakeDevice('kept');
  const removed = fakeDevice('removed');

  await app.subscribeWebhook(kept);
  await app.subscribeWebhook(removed);
  app.unsubscribeWebhook(removed);
  cloud.deliver({ body: { userid: '1' } });
  await tick();

  assert.equal(cloud.unregistered, 0);
  assert.equal(kept.got.length, 1);
  assert.equal(removed.got.length, 0);
});

test('a device that throws does not starve the others', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);
  const broken = { _onWebhookMessage() { throw new Error('boom'); } };
  const healthy = fakeDevice('healthy');

  await app.subscribeWebhook(broken);
  await app.subscribeWebhook(healthy);
  cloud.deliver({ body: {} });
  await tick();

  assert.equal(healthy.got.length, 1);
  assert.equal(app.errors.length, 1);
});

test('a failed registration is retried by the next device', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);

  cloud.fail = true;
  await assert.rejects(app.subscribeWebhook(fakeDevice('a')));
  cloud.fail = false;
  await app.subscribeWebhook(fakeDevice('b'));

  assert.equal(cloud.created, 1);
});

test('without webhook config nothing is registered', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);
  app._config = () => undefined;

  assert.equal(await app.subscribeWebhook(fakeDevice('a')), false);
  assert.equal(cloud.created, 0);
});

test('the app unregisters the webhook only when it stops', async () => {
  const cloud = fakeCloud();
  const app = makeApp(cloud);

  await app.subscribeWebhook(fakeDevice('a'));
  await app.onUninit();

  assert.equal(cloud.unregistered, 1);
});
