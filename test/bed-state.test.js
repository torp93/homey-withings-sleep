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

test('parseNotification reads a full bed event payload', () => {
  // Representative synthetic Withings notification: this shape uses `date`,
  // not startdate/enddate, and includes the mat's deviceid.
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

  assert.strictEqual(deriveBedState([], now), null, "empty means unknown, not empty bed");
  assert.strictEqual(deriveBedState(null, now), null);
  assert.strictEqual(deriveBedState([{ enddate: 'nonsense' }], now), null);
});

test('deriveBedState respects the boundary exactly', () => {
  const now = 1700000000;

  assert.strictEqual(deriveBedState([{ enddate: now - 300 }], now, 300), true);
  assert.strictEqual(deriveBedState([{ enddate: now - 301 }], now, 300), false);
});

// --- Event identity, duplicates and ordering --------------------------------

const { eventKey, shouldAcceptEvent, rememberEvent, MAX_SEEN_EVENTS } =
  require('../lib/bed-state');

const bedIn = { userId: '12345678', appli: 50, deviceId: 'mat-a', inBed: true, date: 1700000000 };
const bedOut = { userId: '12345678', appli: 51, deviceId: 'mat-a', inBed: false, date: 1700003600 };

test('eventKey distinguishes bed in from bed out at the same instant', () => {
  const a = eventKey({ ...bedIn });
  const b = eventKey({ ...bedIn, appli: 51 });

  assert.notStrictEqual(a, b);
  assert.strictEqual(eventKey({ ...bedIn }), a, 'same event yields the same key');
});

test('eventKey is null without a timestamp, so such events are never deduped', () => {
  assert.strictEqual(eventKey({ ...bedIn, date: null }), null);
});

test('a fresh event is accepted', () => {
  const v = shouldAcceptEvent(bedIn, { seen: [], lastEventMs: null });
  assert.strictEqual(v.accept, true);
});

test('a retried callback is rejected as a duplicate', () => {
  const seen = rememberEvent(eventKey(bedIn), []);
  const v = shouldAcceptEvent(bedIn, { seen, lastEventMs: bedIn.date * 1000 });

  assert.strictEqual(v.accept, false);
  assert.strictEqual(v.reason, 'duplicate');
});

test('an older bed in arriving after a newer bed out is rejected as stale', () => {
  // The failure this guards: a delayed 22:00 bed in landing after the 06:00
  // bed out would otherwise report the bed occupied for the rest of the day.
  const seen = rememberEvent(eventKey(bedOut), []);
  const v = shouldAcceptEvent(bedIn, { seen, lastEventMs: bedOut.date * 1000 });

  assert.strictEqual(v.accept, false);
  assert.strictEqual(v.reason, 'stale');
});

test('a newer event after an older one is accepted', () => {
  const seen = rememberEvent(eventKey(bedIn), []);
  const v = shouldAcceptEvent(bedOut, { seen, lastEventMs: bedIn.date * 1000 });

  assert.strictEqual(v.accept, true);
});

test('two events sharing a timestamp are both accepted', () => {
  const other = { ...bedOut, date: bedIn.date };
  const seen = rememberEvent(eventKey(bedIn), []);

  assert.strictEqual(shouldAcceptEvent(other, { seen, lastEventMs: bedIn.date * 1000 }).accept, true);
});

test('an event without a timestamp is accepted rather than deduped wrongly', () => {
  const undated = { ...bedIn, date: null };
  const seen = rememberEvent(eventKey(bedIn), []);

  assert.strictEqual(shouldAcceptEvent(undated, { seen, lastEventMs: Date.now() }).accept, true);
});

test('events from a second mat produce different keys', () => {
  assert.notStrictEqual(eventKey(bedIn), eventKey({ ...bedIn, deviceId: 'mat-b' }));
});

test('the dedupe list stays bounded and keeps the newest keys', () => {
  let seen = [];
  for (let i = 0; i < MAX_SEEN_EVENTS + 5; i += 1) {
    seen = rememberEvent(`key-${i}`, seen);
  }

  assert.strictEqual(seen.length, MAX_SEEN_EVENTS);
  assert.ok(seen.includes(`key-${MAX_SEEN_EVENTS + 4}`), 'newest kept');
  assert.ok(!seen.includes('key-0'), 'oldest dropped');
});

test('re-remembering a key moves it to the end without duplicating it', () => {
  const seen = rememberEvent('a', rememberEvent('b', rememberEvent('a', [])));

  assert.deepStrictEqual(seen, ['b', 'a']);
});

// --- Last night's summary ---------------------------------------------------

const { summariseLastNight } = require('../lib/bed-state');

test('summariseLastNight picks the newest night and converts to minutes', () => {
  const night = summariseLastNight([
    { startdate: 1700000000, enddate: 1700010000 },
    { startdate: 1700100000, enddate: 1700127000 }
  ]);

  assert.strictEqual(night.startMs, 1700100000 * 1000);
  assert.strictEqual(night.endMs, 1700127000 * 1000);
  assert.strictEqual(night.minutes, 450, '7h30m');
});

test('summariseLastNight goes by end time, not by position in the array', () => {
  // Withings usually returns oldest first, but a nap can land out of order.
  const night = summariseLastNight([
    { startdate: 1700100000, enddate: 1700127000 },
    { startdate: 1700000000, enddate: 1700010000 }
  ]);

  assert.strictEqual(night.endMs, 1700127000 * 1000);
});

test('summariseLastNight returns null rather than inventing a zero', () => {
  // A caller that gets null leaves the capabilities blank, which is honest.
  assert.strictEqual(summariseLastNight([]), null);
  assert.strictEqual(summariseLastNight(null), null);
  assert.strictEqual(summariseLastNight([{ startdate: 1700000000 }]), null, 'no enddate');
  assert.strictEqual(summariseLastNight([{ startdate: 5, enddate: 5 }]), null, 'zero length');
  assert.strictEqual(summariseLastNight([{ startdate: 10, enddate: 5 }]), null, 'ends before it starts');
});

test('summariseLastNight handles a night crossing midnight', () => {
  // 22:30 to 06:30 the next day, eight hours.
  const start = Date.UTC(2026, 0, 1, 22, 30) / 1000;
  const end = Date.UTC(2026, 0, 2, 6, 30) / 1000;

  assert.strictEqual(summariseLastNight([{ startdate: start, enddate: end }]).minutes, 480);
});

test('summariseLastNight skips unusable entries but keeps good ones', () => {
  const night = summariseLastNight([
    { startdate: 1700100000, enddate: 1700103600 },
    { startdate: 1700200000, enddate: null }
  ]);

  assert.strictEqual(night.minutes, 60);
});

test('deriveBedState says unknown, not empty, when there is no data', () => {
  const now = 1700000000;

  // The distinction that matters: a poll returning null must leave the state
  // untouched, so it cannot overwrite a webhook that said someone is in bed.
  assert.strictEqual(deriveBedState([], now, 300), null);
  assert.strictEqual(deriveBedState([{ enddate: null }], now, 300), null);

  // A real reading still answers plainly.
  assert.strictEqual(deriveBedState([{ enddate: now - 60 }], now, 300), true);
  assert.strictEqual(deriveBedState([{ enddate: now - 9999 }], now, 300), false);
});
