'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseNotification, deriveBedState } = require('../lib/bed-state');

test('parseNotification reads a bed-in event', () => {
  const event = parseNotification({ userid: '12345678', appli: '50', startdate: '1700000000' });

  assert.deepStrictEqual(event, {
    userId: '12345678',
    appli: 50,
    deviceId: null,
    inBed: true,
    date: 1700000000
  });
});

test('parseNotification reads a real bed event payload', () => {
  // Captured from an actual Withings notification: it uses `date`, not
  // startdate/enddate, and includes the mat's deviceid.
  const event = parseNotification({
    date: '1700003600',
    deviceid: 'aaaabbbbccccddddeeeeffff0000111122223333',
    appli: '50',
    userid: '12345678'
  });

  assert.deepStrictEqual(event, {
    userId: '12345678',
    appli: 50,
    deviceId: 'aaaabbbbccccddddeeeeffff0000111122223333',
    inBed: true,
    date: 1700003600
  });
});

test('parseNotification reads a bed-out event', () => {
  const event = parseNotification({ userid: 12345678, appli: 51, startdate: 1700000000 });

  assert.strictEqual(event.inBed, false);
  assert.strictEqual(event.appli, 51);
  assert.strictEqual(event.userId, '12345678');
});

test('parseNotification accepts a raw form-encoded body', () => {
  // Withings posts application/x-www-form-urlencoded; some webhook layers hand
  // it over unparsed.
  const event = parseNotification('userid=12345678&appli=50&startdate=1700000000');

  assert.deepStrictEqual(event, {
    userId: '12345678',
    appli: 50,
    deviceId: null,
    inBed: true,
    date: 1700000000
  });
});

test('parseNotification ignores non-bed categories', () => {
  // appli 1 is weight: it kept working while 50/51 died, and must not be
  // mistaken for a bed event.
  assert.strictEqual(parseNotification({ userid: '1', appli: '1' }), null);
  assert.strictEqual(parseNotification({ userid: '1', appli: '44' }), null);
});

test('parseNotification rejects malformed payloads', () => {
  assert.strictEqual(parseNotification(null), null);
  assert.strictEqual(parseNotification({}), null);
  assert.strictEqual(parseNotification({ appli: '50' }), null);
});

test('parseNotification tolerates a missing startdate', () => {
  assert.strictEqual(parseNotification({ userid: '1', appli: '50' }).date, null);
});

test('deriveBedState treats fresh sleep data as an occupied bed', () => {
  const now = 1700000000;
  const series = [{ startdate: now - 600, enddate: now - 30 }];

  assert.strictEqual(deriveBedState(series, now, 300), true);
});

test('deriveBedState treats stale sleep data as an empty bed', () => {
  const now = 1700000000;
  const series = [{ startdate: now - 8 * 3600, enddate: now - 3600 }];

  assert.strictEqual(deriveBedState(series, now, 300), false);
});

test('deriveBedState uses the newest entry, not the last one', () => {
  const now = 1700000000;
  const series = [
    { startdate: now - 120, enddate: now - 60 },
    { startdate: now - 7200, enddate: now - 6000 }
  ];

  assert.strictEqual(deriveBedState(series, now, 300), true);
});

test('deriveBedState handles empty and malformed input', () => {
  const now = 1700000000;

  assert.strictEqual(deriveBedState([], now), false);
  assert.strictEqual(deriveBedState(null, now), false);
  assert.strictEqual(deriveBedState([{ enddate: 'nonsense' }], now), false);
});

test('deriveBedState respects the boundary exactly', () => {
  const now = 1700000000;

  assert.strictEqual(deriveBedState([{ enddate: now - 300 }], now, 300), true);
  assert.strictEqual(deriveBedState([{ enddate: now - 301 }], now, 300), false);
});
