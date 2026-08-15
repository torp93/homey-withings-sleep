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
  if (!Array.isArray(series) || series.length === 0) return false;

  const latestEnd = series.reduce((max, entry) => {
    const end = Number(entry && entry.enddate);
    return Number.isFinite(end) && end > max ? end : max;
  }, 0);

  if (latestEnd === 0) return false;

  return nowSeconds - latestEnd <= freshnessSeconds;
}

module.exports = { parseNotification, deriveBedState };
