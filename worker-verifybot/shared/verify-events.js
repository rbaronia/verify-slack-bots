/**
 * IBM Verify SaaS Events API client.
 *
 * Docs: https://docs.verify.ibm.com/verify/docs/pulling-event-data
 *
 * Key facts from the official docs:
 *
 * ENDPOINT
 *   GET https://baronia.verify.ibm.com/v1.0/events
 *
 * REQUIRED API CLIENT ENTITLEMENTS
 *   - Manage reports
 *   - Read reports
 *
 * PARAMETERS
 *   from          epoch ms — start of time window
 *   to            epoch ms — end of time window (optional, defaults to now)
 *   size          max events per page (default 10000, hard max 10000)
 *   event_type    quoted+escaped filter e.g. \"authentication\",\"management\"
 *   all_events    "yes" | "no" (default "no" = only management/sso/authentication)
 *   range_type    "time" (default) | "indexed_at"
 *   after_id      pagination — event ID of last item in previous page
 *   after_time    pagination — epoch ms of last item in previous page
 *   filter_key    attribute path to filter on (e.g. "data.username")
 *   filter_value  escaped quoted value (e.g. \"dfox@example.com\")
 *
 * RESPONSE SHAPE
 *   {
 *     "response": {
 *       "events": {
 *         "search_after": {
 *           "total_events": 54,
 *           "max_size_limit": "false",   // "true" means 10k limit hit — paginate
 *           "time": "1559156150862",     // epoch ms of last event
 *           "id": "def9ea72-..."         // id of last event
 *         },
 *         "events": [ { ...event... }, ... ]
 *       }
 *     }
 *   }
 *
 * PAGINATION
 *   If max_size_limit == "true", pass after_time + after_id from search_after
 *   into the next request (keep from/to the same).
 *
 * EVENT TYPES (all_events=yes adds these on top of management/sso/authentication)
 *   management, authentication, sso, service, fulfillment,
 *   adaptive_risk, cert_campaign, access_request, account_sync, token, privacy_consent
 */

const BASE_URL = 'https://baronia.verify.ibm.com/v1.0/events';

// Event types to fetch — these cover all security-relevant categories.
// Wrap each in escaped quotes as the API requires: \"type1\",\"type2\"
const EVENT_TYPES = '"management","authentication","sso","adaptive_risk","access_request","token"';

/**
 * Convert an ISO 8601 string or Date to epoch milliseconds (string).
 * The Events API requires epoch ms for from/to/after_time.
 */
function toEpochMs(isoOrDate) {
  return String(new Date(isoOrDate).getTime());
}

/**
 * Fetch all events from IBM Verify SaaS between fromTime and now.
 * Handles pagination automatically via search_after.
 *
 * @param {string} fromTime  ISO 8601 or epoch ms string — fetch events AFTER this time
 * @param {string} bearerToken
 * @returns {Promise<Array>} flat array of raw event objects
 */
export async function fetchEventsSince(fromTime, bearerToken) {
  const fromMs = toEpochMs(fromTime);
  const toMs   = toEpochMs(new Date());
  const events = [];

  // Pagination cursors — null on first request
  let afterId   = null;
  let afterTime = null;

  while (true) {
    const url = new URL(BASE_URL);
    url.searchParams.set('from',        fromMs);
    url.searchParams.set('to',          toMs);
    url.searchParams.set('size',        '10000');
    url.searchParams.set('event_type',  EVENT_TYPES);
    url.searchParams.set('all_events',  'no');      // management+authentication+sso
    url.searchParams.set('range_type',  'indexed_at'); // more reliable than "time"

    // Pagination: only set after first page
    if (afterId && afterTime) {
      url.searchParams.set('after_id',   afterId);
      url.searchParams.set('after_time', afterTime);
    }

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
      },
    });

    if (resp.status === 204) break; // no content
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`IBM Verify Events API ${resp.status}: ${body.slice(0, 300)}`);
    }

    const json = await resp.json();

    // Unwrap the documented double-nested shape:
    // json.response.events.events[]  +  json.response.events.search_after
    const outer      = json?.response?.events ?? {};
    const page       = Array.isArray(outer.events) ? outer.events : [];
    const searchAfter = outer.search_after ?? null;

    events.push(...page);

    // Stop if no more pages
    if (!searchAfter || searchAfter.max_size_limit !== 'true') break;

    // Advance cursors for next page
    afterTime = searchAfter.time;
    afterId   = searchAfter.id;

    // Safety: stop if we somehow get stuck with no cursor advancement
    if (!afterTime || !afterId) break;
  }

  return events;
}
