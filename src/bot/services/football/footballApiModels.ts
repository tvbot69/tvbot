/**
 * Response shapes for the three football providers.
 *
 * These are declared locally rather than imported because two of the three are
 * third-party APIs with no bundled types, and the third is a Discord route whose
 * result type is not re-exported from the installed discord.js typings.
 *
 * Every field is optional. That is not caution for its own sake: all three
 * providers are consumed with a bare `fetch` and no retry, so a partial or
 * rate-limited body arrives as-is, and the callers already skip anything
 * missing rather than throwing.
 */

/**
 * ESPN's public scoreboard API.
 *
 * `GET site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard`.
 * Note `score` is a STRING there - it is parsed with parseInt, which is why the
 * field is typed string and not number. Getting that wrong would make the
 * `!== undefined` guard accept a non-numeric value and put NaN in an embed.
 */
export interface EspnScoreboardResponse {
  events?: Array<{
    id?: string;
    name?: string;
    date?: string;
    /**
     * `displayClock` is what makes a LIVE match show "67'" rather than a bare
     * "LIVE", and it lives on the status object alongside `type` - not on
     * `type` itself. Worth spelling out because the two are easy to conflate.
     */
    status?: {
      type?: { name?: string; state?: string; shortDetail?: string; detail?: string };
      displayClock?: string | number;
    };
    competitions?: Array<{
      id?: string;
      /**
       * `venue` carries the stadium name and city, used for the match detail
       * card. Undeclared at first and the compiler caught it, which is the
       * point of typing the read.
       */
      venue?: { fullName?: string; address?: { city?: string; country?: string } };
      status?: { type?: { name?: string; state?: string; shortDetail?: string; detail?: string } };
      competitors?: Array<{
        homeAway?: 'home' | 'away';
        score?: string;
        winner?: boolean;
        team?: {
          id?: string;
          name?: string;
          abbreviation?: string;
          displayName?: string;
          shortDisplayName?: string;
          logo?: string;
        };
      }>;
    }>;
  }>;
}

/**
 * API-Football (v3).
 *
 * `GET /v3/fixtures?date=YYYY-MM-DD`. Notably the response is wrapped in a
 * `response` array rather than being the array itself, which is why the call
 * site reads `data.response` - and why an error body with `{ errors: {...} }`
 * and no `response` yields an empty list instead of a throw.
 */
export interface ApiFootballFixturesResponse {
  response?: Array<{
    fixture?: {
      id?: number | string;
      date?: string;
      /** Kickoff as a Unix timestamp; alternate spelling of `date`. */
      timestamp?: number;
      venue?: { name?: string; city?: string };
      status?: { short?: string; long?: string; elapsed?: number | null };
    };
    teams?: {
      home?: { name?: string; logo?: string; winner?: boolean | null };
      away?: { name?: string; logo?: string; winner?: boolean | null };
    };
    /** Read unconditionally, so declared optional and handled with a fallback. */
    goals?: { home?: number | null; away?: number | null };
    league?: { id?: number; name?: string; logo?: string; country?: string };
  }>;
  errors?: Record<string, unknown>;
}

/**
 * `GET /applications/{id}/emojis` on the Discord API.
 *
 * Used to preload the football club badges, filtered to names starting `fb_`.
 * Named rather than reusing a discord.js type because that result interface is
 * not exported from the installed typings.
 */
export interface DiscordApplicationEmojisResponse {
  items?: Array<{
    id?: string;
    name?: string;
    animated?: boolean;
    require_colons?: boolean;
    managed?: boolean;
    available?: boolean;
  }>;
}
