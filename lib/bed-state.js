'use strict';

const { WithingsApi } = require('./withings-api');

const { BED_IN, BED_OUT } = WithingsApi.APPLI;

/**
 * Withings posts notifications as form-encoded fields. Everything arrives as a
 * string, and only `appli` distinguishes getting in from getting out.
 *
 * @param {object} body Parsed request body.
 * @returns {?{userId: string, appli: number, inBed: boolean, date: ?number}}
 *   Null when the payload is not a bed event.
 */
function parseNotification(body) {
  if (!body) return null;

  // Withings posts application/x-www-form-urlencoded. Depending on how the
  // webhook layer handles that content type the body arrives either already
  // parsed or as a raw string — accept both rather than silently dropping the
  // event.
  const fields = typeof body === 'string'
    ? Object.fromEntries(new URLSearchParams(body))
    : body;

  const appli = Number(fields.appli);
  if (appli !== BED_IN && appli !== BED_OUT) return null;

  const userId = fields.userid === undefined ? null : String(fields.userid);
  if (!userId) return null;

  // Real bed events carry `date`; the documented sample payloads use
  // startdate/enddate. Accept whichever is present.
  const date = Number(fields.date ?? fields.startdate ?? fields.enddate);

  return {
    userId,
    appli,
    deviceId: fields.deviceid ? String(fields.deviceid) : null,
    inBed: appli === BED_IN,
    date: Number.isFinite(date) && date > 0 ? date : null
  };
}

/**
 * Polling fallback for when no cloud webhook is configured.
 *
 * The mat only produces sleep series while someone is on it, so a series entry
 * that is still being extended means the bed is occupied. Anything older than
 * `freshnessSeconds` is treated as an empty bed.
 *
 * @param {Array<{startdate: number, enddate: number}>} series
 * @param {number} nowSeconds Unix seconds.
 * @param {number} freshnessSeconds How recent an entry must be to count.
 * @returns {boolean}
 */
function deriveBedState(series, nowSeconds, freshnessSeconds = 300) {
  // No data is not the same as an empty bed. The mat only produces a series
  // while someone is on it, but it also produces nothing when Withings has not
  // scored anything yet, or when the account has gone quiet. Returning false
  // here would let a poll assert "out of bed" every minute and overwrite a
  // webhook that correctly said otherwise. Null means: leave the state alone.
  if (!Array.isArray(series) || series.length === 0) return null;

  const latestEnd = series.reduce((max, entry) => {
    const end = Number(entry && entry.enddate);
    return Number.isFinite(end) && end > max ? end : max;
  }, 0);

  if (latestEnd === 0) return null;

  return nowSeconds - latestEnd <= freshnessSeconds;
}

/**
 * A stable identity for one physical bed event.
 *
 * Withings retries a callback until it is acknowledged, so the same event can
 * arrive several times. Identity is derived from what the payload actually
 * carries rather than from arrival time, so a retry an hour later is still
 * recognised as the same event. Events without a timestamp cannot be told
 * apart this way and are deliberately given a null key: they fall back to the
 * state-transition guard instead of being deduped wrongly.
 */
function eventKey(event) {
  if (!event || !event.date) return null;
  return `${event.appli}:${event.userId}:${event.deviceId || '-'}:${event.date}`;
}

const MAX_SEEN_EVENTS = 20;

/**
 * Decide whether a bed event should be acted on.
 *
 * Two independent guards, because they catch different failures:
 *
 *   - `duplicate`: this exact event has been handled before. Withings retried.
 *   - `stale`: an older event arrived after a newer one. Network reordering.
 *     Letting it through would put a Bed in from 22:00 on top of a Bed out
 *     from 06:00 and report the bed as occupied all day.
 *
 * Equal timestamps are accepted: two events can legitimately share a second,
 * and the duplicate guard already covers a true repeat.
 *
 * @param {object} event Parsed notification.
 * @param {{seen: string[], lastEventMs: ?number}} state
 * @returns {{accept: boolean, reason: ?string, key: ?string}}
 */
function shouldAcceptEvent(event, { seen = [], lastEventMs = null } = {}) {
  const key = eventKey(event);

  if (key && seen.includes(key)) {
    return { accept: false, reason: 'duplicate', key };
  }

  const eventMs = event && event.date ? event.date * 1000 : null;
  if (eventMs !== null && lastEventMs !== null && eventMs < lastEventMs) {
    return { accept: false, reason: 'stale', key };
  }

  return { accept: true, reason: null, key };
}

/** Append a key to the bounded dedupe list, newest last. */
function rememberEvent(key, seen = []) {
  if (!key) return seen.slice(-MAX_SEEN_EVENTS);
  return [...seen.filter(k => k !== key), key].slice(-MAX_SEEN_EVENTS);
}

/**
 * The handful of numbers this app displays from a scored night.
 *
 * Every field is optional: Withings omits what the mat did not measure, and a
 * missing value must stay missing rather than becoming zero, which would read
 * as a measured resting pulse of nothing. Snoring arrives in seconds and is
 * converted here so the rest of the app deals only in minutes.
 *
 * @param {?object} data The `data` object of a summary entry.
 */
function readMetrics(data) {
  const num = value => {
    // Guarded before Number(), which turns null and '' into 0 and would
    // present a measurement that was never taken as a reading of zero.
    if (value === null || value === undefined || value === '') return null;

    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const d = data || {};
  const snoringSeconds = num(d.snoring);

  return {
    sleepScore: num(d.sleep_score),
    heartRate: num(d.hr_average),
    breathingRate: num(d.rr_average),
    snoringMinutes: snoringSeconds === null ? null : Math.round(snoringSeconds / 60)
  };
}

/**
 * Pick the most recent completed night out of a getsummary response.
 *
 * Withings returns one entry per night, oldest first, but a request spanning
 * two calendar days can also return a nap, and an entry whose scoring is not
 * finished can be missing enddate. Choose by latest enddate rather than by
 * position, and reject anything that is not a usable interval: a caller that
 * gets null leaves the capabilities untouched, which is the honest outcome
 * when there is nothing to show.
 *
 * @param {Array<{startdate: number, enddate: number}>} series
 * @returns {?{startMs: number, endMs: number, minutes: number}}
 */
function summariseLastNight(series) {
  if (!Array.isArray(series) || series.length === 0) return null;

  const usable = series.filter(entry => {
    const start = Number(entry && entry.startdate);
    const end = Number(entry && entry.enddate);
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  });

  if (usable.length === 0) return null;

  const latest = usable.reduce((best, entry) =>
    Number(entry.enddate) > Number(best.enddate) ? entry : best);

  const startMs = Number(latest.startdate) * 1000;
  const endMs = Number(latest.enddate) * 1000;

  return {
    startMs,
    endMs,
    minutes: Math.round((endMs - startMs) / 60000),
    metrics: readMetrics(latest.data)
  };
}

/**
 * Minutes as something a person reads at a glance: "7 h 7 min".
 *
 * Homey does not translate capability values, so the caller passes the unit
 * words it looked up for this Homey's language. Below an hour the hour part is
 * dropped entirely, and a whole number of hours drops the minutes, because
 * "2 h 0 min" reads worse than "2 h".
 *
 * @param {?number} minutes
 * @param {{hour?: string, minute?: string}} [units] Defaults are the neutral
 *   abbreviations, so a caller without a translator still gets sane output.
 * @returns {?string} Null when there is nothing to show, so the caller can
 *   leave the capability blank rather than displaying a fake zero.
 */
function formatDuration(minutes, { hour = 'h', minute = 'min' } = {}) {
  // Checked before Number(), which turns null and '' into 0 and would report
  // "0 min" for a value that was never measured.
  if (minutes === null || minutes === undefined || minutes === '') return null;

  const total = Number(minutes);
  if (!Number.isFinite(total) || total < 0) return null;

  const hours = Math.floor(total / 60);
  const rest = Math.round(total % 60);

  if (hours === 0) return `${rest} ${minute}`;
  if (rest === 0) return `${hours} ${hour}`;
  return `${hours} ${hour} ${rest} ${minute}`;
}

module.exports = {
  parseNotification,
  deriveBedState,
  summariseLastNight,
  readMetrics,
  formatDuration,
  eventKey,
  shouldAcceptEvent,
  rememberEvent,
  MAX_SEEN_EVENTS
};
