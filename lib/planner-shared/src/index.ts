/**
 * Shared planner-route limits.
 *
 * The PUT /api/me/planner-route endpoint enforces these caps server-side
 * (see `artifacts/api-server/src/routes/me.ts`). The client mirrors them
 * so the planner UI can refuse to grow the route past the cap and show
 * a friendly warning instead of letting the user pile on extra trails
 * that the server will silently reject with a 400.
 *
 * Keep this module dependency-free — both the React client and the
 * Express server import it directly.
 */

/**
 * Maximum number of distinct trails (de-duped by id) a single user's
 * persisted planner route may contain. The planner UI can't usefully
 * chain more than this and the cap keeps the planner_routes jsonb
 * payload bounded.
 */
export const PLANNER_MAX_TRAILS = 50;

/**
 * Maximum number of custom waypoints (fuel stops, campsites, etc.)
 * a planner route may carry, de-duped by waypoint id.
 */
export const PLANNER_MAX_WAYPOINTS = 50;

/**
 * Maximum length of `entryOrder` — the interleaved list of
 * `{kind:'trail'|'waypoint', id}` refs. Caps the combined trail +
 * waypoint count at the same upper bound the jsonb schema allows.
 */
export const PLANNER_MAX_ENTRIES = 100;
