# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Squad is a vanilla JS PWA for managing multi-team sports rosters, events, and RSVPs. No build step, no framework — plain ES modules loaded directly in the browser, backed by Firebase Realtime Database and Firebase Auth (Google Sign-In).

## Running locally

There is no build process. Serve the files with any static HTTP server:

```bash
python3 -m http.server 8080
# or
npx serve .
```

The service worker won't activate over `file://` — always go through a server. The PWA install prompt and service worker registration require HTTPS on production; `localhost` is treated as secure.

Before running, populate `firebase-config.js` with real Firebase credentials (ships with `REPLACE_ME` placeholders; the app refuses to boot without them). Also enable Google Sign-In in Firebase console under Authentication → Sign-in method.

### Debug script

`debug.mjs` uses Playwright to headlessly load the app and capture console errors. Run with `node debug.mjs` (requires `npm install` first for the `playwright` dep). The hardcoded port `55670` may need adjusting.

## Deployment

`netlify.toml` sets the publish directory to `.` (repo root) and adds a `no-cache` header for `service-worker.js` so updates propagate immediately. Deploy with:

```bash
netlify deploy --prod --dir .
```

## Architecture

**Single-file app structure:**
- `index.html` — static app shell; all views exist in the DOM at once, toggled via `hidden`
- `app.js` — all logic (~1,269 lines); no external dependencies beyond Firebase CDN SDK
- `styles.css` — all styling with CSS custom properties for runtime theming
- `firebase-config.js` — sets `window.FIREBASE_CONFIG`; loaded via `<script>` before the module

**View routing** is manual: `showView(name)` toggles `hidden` on five views — `signin`, `welcome`, `join`, `create`, and `app`. No router library.

**DOM access** uses a local alias: `const $ = (id) => document.getElementById(id)`. All elements are accessed by ID.

**Real-time subscriptions** use Firebase `onValue`. Refs are collected in the `subscriptions` array and detached via `detachAll()` before switching teams to prevent stale listeners.

## Auth model

Boot is driven by `onAuthStateChanged`. If no Firebase user → `showSignIn()`. On sign-in, `signInWithPopup` triggers the Google OAuth flow and `onAuthStateChanged` handles the rest automatically.

The user's display name is cached in `localStorage` under `squad.name.v1` (fast load; avoids a DB read on every boot). The active team ID is stored under `squad.active.v1`.

`clearAll()` removes both localStorage keys and calls `signOut(auth)`.

## Dev mode identity override (localhost only)

On `localhost`, `onAuthStateChanged` checks `squad.dev.active` in localStorage. If set, it overrides the authenticated user's `uid` and `name` with a saved test session from `squad.dev.sessions`. This lets you test different roles (coach, parent, player) without signing out of Google. The dev panel is injected into the DOM only on localhost.

## Firebase data model

```
users/{uid}:                   # Global — one record per Google account
  name, createdAt
  teams: { teamId: true }      # Membership index

teams/{teamId}/:
  meta:                        # name, ageGroup, sport, colors:{primary,accent}
  members/{uid}:               # role (coach|parent|player), childOf? (playerUid)
  players/{uid}:               # name — standalone records, not linked to user accounts
  invites/{code}:              # role, expiresAt, used, usedBy?
  events/{eventId}:            # type, title, when (ms), location, locationPlaceId?,
                               # locationLat?, locationLon?, notes, createdBy, createdAt
                               # rsvps/{playerUid}: { status, respondedBy, respondedAt }

inviteIndex/{code}:            # Global lookup → { teamId } for join flow
```

Players are separate from users — created by name when a parent joins. RSVPs are keyed by `playerUid`, not `uid`, so multiple parents of the same child share one RSVP.

## Key patterns

**Per-team theming:** Each team stores `colors.primary` and `colors.accent`. On `enterTeam()`, `setTheme()` writes CSS variables `--pri`, `--acc`, `--pri-ink` (auto-computed for contrast) and updates `<meta name="theme-color">`.

**Sport-adaptive labels:** `SPORT_LABELS` maps sport keys to `{ match, training, social, matchVerb }`. Always use `labelsFor(teamMeta.sport)` for event type text — never hardcode "match" or "training" in UI strings.

**Location autocomplete:** The new event form uses the Google Places API with a 350ms debounce. Selecting a suggestion stores `locationPlaceId`, `locationLat`, `locationLon` alongside the text. `locationLink()` generates a Google Maps URL from place ID or coordinates for use in the event detail view.

**Invite codes:** 4 letters + 2 digits (e.g. `ABCD23`), 14-day expiry. Written atomically to both `teams/{id}/invites/{code}` and `inviteIndex/{code}`. On use, the `inviteIndex` entry is set to `null` and `used: true` is set on the team record.

**`bindAppActions()` runs once:** The flag `enterTeam._bound` prevents duplicate event listeners when switching teams. Only subscription setup runs on each team entry.

**Event editing:** `openNewEventModal(existing?)` accepts an optional existing event object. When editing, the modal pre-fills and a `data-editId` attribute on the form tracks which event to overwrite.

## Service worker

Cache name is `squad-shell-v9`. Bump this string when changing any app-shell file to force cache invalidation. Firebase hostnames (`firebaseio.com`, `googleapis.com`, `gstatic.com`) bypass the service worker entirely.

## Firebase security

`database.rules.json` currently allows open read/write (Phase 1). Do not apply these rules to a public-facing deployment. Phase 2 hardens with per-UID write restrictions once Firebase Auth is fully wired into the rules.

## Planned phases

- **Phase 2:** Team chat + announcements channel, push notifications, hardened DB rules
- **Phase 3:** Availability polling, parent ↔ coach DMs
- **Phase 4:** Capacitor wrap for Play Store / App Store
