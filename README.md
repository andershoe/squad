# Squad

A no-ads, multi-team manager. PWA hosted on Netlify, data in Firebase.

One deployment, many teams. Each team has its own roster, events, colours, and sport. Users can belong to multiple teams (one parent with kids in two clubs; one coach managing several age groups; a player in two teams) and switch between them from the header.

> **Squad is a placeholder name** — change `<title>`, the `name` field in `manifest.webmanifest`, and the splash text in `index.html` to rebrand.

## What it does (Phase 1)

- **Create a team**: pick name, age group, sport, primary + accent colour. You become the founding coach.
- **Join a team**: enter an invite code. App detects the role (coach / parent / player) and asks for the right details.
- **Events**: matches, training, socials (labels adapt to sport — "match" for football, "game" for netball, "fixture" for rugby, etc.)
- **RSVPs**: parents respond on behalf of their child; coaches can override.
- **Squad roster**: see all coaches, players, and linked parents.
- **Invite codes**: coaches generate codes for new joiners; one-shot, 14-day expiry.
- **Multi-team**: switch between teams from the header dropdown or the Me tab.
- **PWA**: installs to home screen, works offline (app shell cached).

## What's next (planned)

- **Phase 2**: team chat + announcements channel, push notifications.
- **Phase 3**: availability polling, parent ↔ coach DMs.
- **Phase 4**: Capacitor wrap → Play Store + App Store listings.

## Setup

### 1. Create the Firebase project

1. <https://console.firebase.google.com/> → **Add project**. Skip Analytics.
2. **Build → Realtime Database → Create database**. Pick a region close to your users (`europe-west1` for UK). Start in **locked mode**.
3. **Build → Realtime Database → Rules** → paste the contents of `database.rules.json` → **Publish**.
4. **Project settings (gear) → General**. Scroll to "Your apps", click `</>`, name it "Squad web", **don't** check Hosting. Copy the `firebaseConfig` object.

### 2. Drop the config in

Replace each `REPLACE_ME` in `firebase-config.js` with the corresponding value. The `databaseURL` looks like `https://your-project-default-rtdb.europe-west1.firebasedatabase.app`.

### 3. Deploy to Netlify

Either drag the `squad` folder onto <https://app.netlify.com/drop>, or:

```bash
npm install -g netlify-cli
cd squad
netlify deploy --prod --dir .
```

You'll get a URL like `https://your-name.netlify.app`.

### 4. Use it

1. Open the URL on your phone.
2. Tap **Create a new team**. You become the team's coach.
3. From the Team tab, generate invite codes (parent / player / coach) and share them by WhatsApp.
4. Parents open the URL, enter the code, and the app does the rest.

### 5. To add a second team

Open the app, tap **Me → Add another team**, pick **Create** or **Join**. Switch between teams from the header chevron.

## Data model (Firebase Realtime Database)

```
users/{uid}:
  name, createdAt
  teams: { teamId1: true, teamId2: true, ... }   # which teams this user is in

teams/{teamId}/:
  meta: { name, ageGroup, sport, colors: {primary, accent}, createdAt, createdBy }
  members/{uid}: { name, role, childOf?, joinedAt }
  players/{uid}: { name, createdAt }
  invites/{code}: { role, createdAt, expiresAt, used, usedBy?, usedAt? }
  events/{eventId}:
    type ("match" | "training" | "social"),
    title, when (ms), location, notes, createdBy, createdAt
    rsvps/{playerUid}: { status, respondedBy, respondedAt }

inviteIndex/{code}:                                # global lookup so you don't need
  { teamId, createdAt }                            # to scan every team on join
```

**Key design choices**

- *RSVPs by player, not user*: one player ↔ one RSVP. Two parents of the same child see one shared answer; coaches can answer for non-responders.
- *Users are global, members are per-team*: one identity across all your teams, but role and player-link can differ per team.
- *Theme is data*: each team carries its own primary/accent in `meta.colors`. CSS reads from runtime-injected custom properties — switching teams re-themes the whole UI instantly.
- *Sport-adaptive labels*: football says "Match", netball says "Game", cricket says "Match" with "Nets" for practice, etc. Defined in `SPORT_LABELS` in `app.js` — easy to add more sports or override.
- *Invite index*: top-level `/inviteIndex/{code}` maps codes to teams so a parent joining doesn't need to scan every team. Cleaned up automatically when used.

## Security

Phase 1 uses **open RTDB rules** because there is no Firebase Auth — auth is invite-code-only, with session in `localStorage`. This is fine for private team apps where the URL is shared only with people you trust, but not appropriate for a fully public product. See the comment block in `database.rules.json` for the Phase 2 hardening path.

## Local development

```bash
cd squad
python3 -m http.server 8080
# Open http://localhost:8080
```

The service worker won't activate over `file://` — always go through a server.

To test the **install to home screen** flow, you need the live HTTPS URL on your phone. Service workers + the install prompt only work over HTTPS or localhost.

## Renaming the product

To replace "Squad" with your own name (e.g. "Team Sheet", "Kickoff"):

1. `index.html` — `<title>`, splash `<p>`, h1 on the welcome view
2. `manifest.webmanifest` — `name` and `short_name`
3. `README.md` — wherever you like

Run `python3 icons/generate-icons.py` after editing the icon colours if you want a different brand mark.

## File map

| File | Purpose |
|------|---------|
| `index.html` | App shell — onboarding views + main app |
| `styles.css` | All styling. Per-team colours are injected at runtime; no edits needed for rebrand. |
| `app.js` | All logic. User identity, team CRUD, theme, events, RSVPs, invites, multi-team switcher |
| `firebase-config.js` | **You fill this in** with your Firebase project values |
| `manifest.webmanifest` | PWA manifest |
| `service-worker.js` | Offline app-shell cache |
| `database.rules.json` | Firebase RTDB security rules (paste into Firebase console) |
| `icons/generate-icons.py` | Generates the three icons |
| `icons/icon-*.png` | App icons |
