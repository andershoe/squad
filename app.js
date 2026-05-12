// =====================================================================
// Squad — multi-team team manager
// One user identity, N teams. Per-team theme injected at runtime.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, get, set, push, onValue, update, serverTimestamp, remove, off
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.databaseURL ||
    window.FIREBASE_CONFIG.databaseURL.includes("REPLACE_ME")) {
  document.getElementById("splash").innerHTML =
    '<div style="padding: 24px; text-align: center;">' +
    '<p style="font-weight:600;margin-bottom:8px">Firebase not configured</p>' +
    '<p style="font-size:13px;opacity:0.85">Edit <code>firebase-config.js</code> and reload. See README.</p>' +
    '</div>';
  throw new Error("Missing Firebase config");
}

const app = initializeApp(window.FIREBASE_CONFIG);
const db = getDatabase(app);

// =====================================================================
// Helpers
// =====================================================================

const $ = (id) => document.getElementById(id);

const fmtDate = (ts) => {
  const d = new Date(ts);
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return { day, date, time, full: `${day} ${date} · ${time}` };
};
const initials = (name) => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
};
const genId = () => Math.random().toString(36).slice(2, 10);
const genCode = () => {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 2; i++) out += digits[Math.floor(Math.random() * digits.length)];
  return out;
};
const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  || "team";

const toast = (msg) => {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 3000);
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// =====================================================================
// Sport labels — pick at team creation, used in UI text
// =====================================================================

const SPORT_LABELS = {
  football: { match: "Match", training: "Training", social: "Social", matchVerb: "kick-off" },
  netball:  { match: "Game",  training: "Practice", social: "Social", matchVerb: "start" },
  rugby:    { match: "Fixture", training: "Training", social: "Social", matchVerb: "kick-off" },
  cricket:  { match: "Match", training: "Nets",     social: "Social", matchVerb: "start" },
  hockey:   { match: "Match", training: "Training", social: "Social", matchVerb: "push-back" },
  other:    { match: "Event", training: "Practice", social: "Social", matchVerb: "start" },
};
const labelsFor = (sport) => SPORT_LABELS[sport] || SPORT_LABELS.other;

// Colour palette presets for team creation
const PALETTE = [
  { hex: "#0b2545", light: false }, { hex: "#1d3557", light: false },
  { hex: "#1a1a1f", light: false }, { hex: "#7b1fa2", light: false },
  { hex: "#185fa5", light: false }, { hex: "#1d9e75", light: false },
  { hex: "#0f6e56", light: false }, { hex: "#854f0b", light: false },
  { hex: "#d62828", light: false }, { hex: "#e85d24", light: false },
  { hex: "#f2a623", light: true  }, { hex: "#fcde5a", light: true  },
  { hex: "#97c459", light: true  }, { hex: "#5dcaa5", light: true  },
  { hex: "#ed93b1", light: true  }, { hex: "#ffffff", light: true  },
];

// =====================================================================
// User identity & session
// =====================================================================
// One uid per device, persisted in localStorage. Reused across all teams.
// In Phase 2 this would be replaced by Firebase Anonymous Auth.

const USER_KEY = "squad.user.v1";
const ACTIVE_KEY = "squad.active.v1";

let user = null;        // { uid, name }
let activeTeamId = null;
let teamMeta = null;    // current team's meta { name, sport, colors, ... }
let myMember = null;    // { role, childOf?, ... } for current team

function loadUser() {
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { user = null; }
}
function saveUser() { localStorage.setItem(USER_KEY, JSON.stringify(user)); }
function loadActive() { activeTeamId = localStorage.getItem(ACTIVE_KEY) || null; }
function saveActive(id) { activeTeamId = id; localStorage.setItem(ACTIVE_KEY, id); }
function clearAll() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ACTIVE_KEY);
  user = null; activeTeamId = null;
}

// =====================================================================
// Theme injection (per-team colours)
// =====================================================================

function setTheme(primary, accent) {
  const root = document.documentElement;
  root.style.setProperty("--pri", primary);
  root.style.setProperty("--acc", accent);
  root.style.setProperty("--pri-ink", contrastInk(primary));
  $("theme-color-meta").setAttribute("content", primary);
}

function contrastInk(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#1a1a1f" : "#ffffff";
}

// =====================================================================
// Boot
// =====================================================================

async function boot() {
  loadUser();
  loadActive();

  if (!user) return showWelcome();

  // Validate user has at least one team they can enter
  const teams = await listMyTeams();
  if (teams.length === 0) return showWelcome();

  // Resolve active team — fall back to the first if missing/stale
  if (!activeTeamId || !teams.find((t) => t.id === activeTeamId)) {
    saveActive(teams[0].id);
  }

  await enterTeam(activeTeamId);
}

async function listMyTeams() {
  if (!user) return [];
  const snap = await get(ref(db, `users/${user.uid}/teams`));
  const teamIds = Object.keys(snap.val() || {});
  const teams = [];
  for (const id of teamIds) {
    const metaSnap = await get(ref(db, `teams/${id}/meta`));
    if (metaSnap.exists()) teams.push({ id, ...metaSnap.val() });
  }
  return teams;
}

// =====================================================================
// View routing
// =====================================================================

function showView(name) {
  ["welcome", "join", "create", "app"].forEach((v) => {
    $(`view-${v}`).hidden = v !== name;
  });
  $("splash").hidden = true;
}

function showWelcome() {
  // Restore default neutral theme on the welcome screen
  setTheme("#1a1a1f", "#d62828");
  showView("welcome");
}

// =====================================================================
// Welcome screen
// =====================================================================

$("btn-go-join").addEventListener("click", () => {
  showView("join");
  $("join-form").reset();
  $("join-parent-block").hidden = true;
});
$("btn-go-create").addEventListener("click", () => {
  showView("create");
  setupCreateForm();
});
document.querySelectorAll("[data-back-to]").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.backTo));
});

// =====================================================================
// Create-team flow
// =====================================================================

function setupCreateForm() {
  $("create-form").reset();
  $("ct-sport").value = "football";
  document.querySelectorAll("#ct-sport-seg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.sport === "football")
  );

  // Build colour swatches
  const buildSwatches = (containerId, hiddenId, defaultHex) => {
    const c = $(containerId);
    c.innerHTML = PALETTE.map((p) =>
      `<button type="button" class="swatch ${p.hex === defaultHex ? "selected" : ""}"
              data-hex="${p.hex}" data-light="${p.light}"
              style="background:${p.hex}"></button>`
    ).join("");
    $(hiddenId).value = defaultHex;
    c.querySelectorAll(".swatch").forEach((s) => {
      s.addEventListener("click", () => {
        c.querySelectorAll(".swatch").forEach((x) => x.classList.remove("selected"));
        s.classList.add("selected");
        $(hiddenId).value = s.dataset.hex;
        if (hiddenId === "ct-primary") setTheme(s.dataset.hex, $("ct-accent").value);
        else setTheme($("ct-primary").value, s.dataset.hex);
      });
    });
  };
  buildSwatches("ct-primary-grid", "ct-primary", "#0b2545");
  buildSwatches("ct-accent-grid", "ct-accent", "#d62828");
  setTheme("#0b2545", "#d62828");

  if (user) $("ct-coach-name").value = user.name;

  document.querySelectorAll("#ct-sport-seg .seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#ct-sport-seg .seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("ct-sport").value = b.dataset.sport;
    })
  );
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").hidden = true;

  const name = $("ct-name").value.trim();
  const ageGroup = $("ct-age").value.trim();
  const sport = $("ct-sport").value;
  const primary = $("ct-primary").value;
  const accent = $("ct-accent").value;
  const coachName = $("ct-coach-name").value.trim();

  if (!name || !coachName) return;

  // Generate a unique team ID by slug + random suffix
  const baseSlug = slugify(name);
  let teamId = baseSlug;
  let suffix = 0;
  while ((await get(ref(db, `teams/${teamId}/meta`))).exists()) {
    suffix++;
    teamId = `${baseSlug}-${suffix.toString(36)}`;
    if (suffix > 100) { teamId = `${baseSlug}-${genId()}`; break; }
  }

  // Ensure user identity exists
  if (!user) {
    user = { uid: genId(), name: coachName };
    saveUser();
    await set(ref(db, `users/${user.uid}`), { name: coachName, createdAt: Date.now() });
  } else if (user.name !== coachName) {
    user.name = coachName;
    saveUser();
    await update(ref(db, `users/${user.uid}`), { name: coachName });
  }

  const memberUid = user.uid;
  try {
    await update(ref(db), {
      [`teams/${teamId}/meta`]: {
        name, ageGroup, sport,
        colors: { primary, accent },
        createdAt: Date.now(),
        createdBy: memberUid,
      },
      [`teams/${teamId}/members/${memberUid}`]: {
        name: coachName,
        role: "coach",
        joinedAt: Date.now(),
      },
      [`users/${user.uid}/teams/${teamId}`]: true,
    });

    saveActive(teamId);
    await enterTeam(teamId);
    toast("Team created");
  } catch (err) {
    console.error(err);
    $("create-error").textContent = "Couldn't create the team. Check your connection.";
    $("create-error").hidden = false;
  }
});

// =====================================================================
// Join-team flow
// =====================================================================

let codePeekTimer = null;
$("join-code").addEventListener("input", () => {
  const code = $("join-code").value.trim().toUpperCase();
  $("join-code").value = code;
  clearTimeout(codePeekTimer);
  if (code.length < 5) {
    $("join-parent-block").hidden = true;
    return;
  }
  codePeekTimer = setTimeout(async () => {
    const invite = await findInviteByCode(code);
    if (invite && !invite.used && invite.role === "parent") {
      $("join-parent-block").hidden = false;
      $("join-child").required = true;
    } else {
      $("join-parent-block").hidden = true;
      $("join-child").required = false;
    }
  }, 250);
});

async function findInviteByCode(code) {
  // Invites live under each team — we maintain a top-level index for lookup
  const idxSnap = await get(ref(db, `inviteIndex/${code}`));
  const idx = idxSnap.val();
  if (!idx) return null;
  const snap = await get(ref(db, `teams/${idx.teamId}/invites/${code}`));
  const data = snap.val();
  return data ? { ...data, teamId: idx.teamId } : null;
}

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("join-error").hidden = true;

  const code = $("join-code").value.trim().toUpperCase();
  const name = $("join-name").value.trim();
  const childName = $("join-child").value.trim();

  if (!code || !name) return;

  try {
    const invite = await findInviteByCode(code);
    if (!invite) return showJoinError("That code doesn't exist.");
    if (invite.used) return showJoinError("That code has already been used.");
    if (invite.expiresAt && invite.expiresAt < Date.now()) {
      return showJoinError("That code has expired. Ask for a new one.");
    }
    if (invite.role === "parent" && !childName) {
      return showJoinError("Please enter your child's name.");
    }

    // Ensure user identity
    if (!user) {
      user = { uid: genId(), name };
      saveUser();
      await set(ref(db, `users/${user.uid}`), { name, createdAt: Date.now() });
    }

    const teamId = invite.teamId;
    const member = {
      name,
      role: invite.role,
      joinedAt: Date.now(),
    };

    let playerUid = null;
    if (invite.role === "parent") {
      playerUid = await ensurePlayer(teamId, childName);
      member.childOf = playerUid;
    } else if (invite.role === "player") {
      playerUid = user.uid;
    }

    await update(ref(db), {
      [`teams/${teamId}/members/${user.uid}`]: member,
      [`teams/${teamId}/invites/${code}/used`]: true,
      [`teams/${teamId}/invites/${code}/usedBy`]: user.uid,
      [`teams/${teamId}/invites/${code}/usedAt`]: Date.now(),
      [`inviteIndex/${code}`]: null,
      [`users/${user.uid}/teams/${teamId}`]: true,
    });

    saveActive(teamId);
    await enterTeam(teamId);
    toast("Welcome!");
  } catch (err) {
    console.error(err);
    showJoinError("Couldn't join — check your connection and try again.");
  }
});

function showJoinError(msg) {
  $("join-error").textContent = msg;
  $("join-error").hidden = false;
}

async function ensurePlayer(teamId, childName) {
  const playersSnap = await get(ref(db, `teams/${teamId}/players`));
  const players = playersSnap.val() || {};
  const existing = Object.entries(players).find(
    ([_, p]) => p.name.toLowerCase() === childName.toLowerCase()
  );
  if (existing) return existing[0];

  const playerUid = genId();
  await set(ref(db, `teams/${teamId}/players/${playerUid}`), {
    name: childName,
    createdAt: Date.now(),
  });
  return playerUid;
}

// =====================================================================
// Team entry — load meta, apply theme, subscribe to data
// =====================================================================

let subscriptions = []; // refs to detach on team switch

function detachAll() {
  subscriptions.forEach((s) => off(s));
  subscriptions = [];
}

async function enterTeam(teamId) {
  detachAll();
  activeTeamId = teamId;

  const metaSnap = await get(ref(db, `teams/${teamId}/meta`));
  if (!metaSnap.exists()) {
    toast("Team no longer exists.");
    saveActive(null);
    return showWelcome();
  }
  teamMeta = metaSnap.val();

  const memberSnap = await get(ref(db, `teams/${teamId}/members/${user.uid}`));
  if (!memberSnap.exists()) {
    toast("You're no longer in that team.");
    await remove(ref(db, `users/${user.uid}/teams/${teamId}`));
    return boot();
  }
  myMember = memberSnap.val();

  // Apply team theme
  setTheme(teamMeta.colors?.primary || "#0b2545", teamMeta.colors?.accent || "#d62828");

  // Render header
  $("header-title").textContent = teamMeta.name;
  $("header-sub").textContent = [teamMeta.ageGroup, prettySport(teamMeta.sport)]
    .filter(Boolean).join(" · ");
  $("header-crest").textContent = initials(teamMeta.name);

  // Me-tab info
  $("me-name").textContent = user.name;
  $("me-role").textContent = roleLabel(myMember.role) + " · " + teamMeta.name;
  if (myMember.childOf) {
    const ps = await get(ref(db, `teams/${teamId}/players/${myMember.childOf}`));
    const p = ps.val();
    if (p) {
      $("me-child").hidden = false;
      $("me-child").textContent = `Parent of ${p.name}`;
    }
  } else {
    $("me-child").hidden = true;
  }

  // Coach-only UI
  const isCoach = myMember.role === "coach";
  $("btn-new-event").hidden = !isCoach;
  $("btn-new-invite").hidden = !isCoach;
  $("invites-label").hidden = !isCoach;
  $("invites-list").hidden = !isCoach;

  // Populate sport-specific event type segmented control
  buildEventTypeSeg();

  // Bind once
  if (!enterTeam._bound) {
    bindAppActions();
    enterTeam._bound = true;
  }

  // Subscribe to data
  subscribeEvents();
  subscribeTeam();
  if (isCoach) subscribeInvites();

  // Render the My-Teams list on the Me tab
  renderMyTeams();

  setupInstallPrompt();
  showView("app");
}

function prettySport(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}
function roleLabel(role) {
  return { coach: "Coach", parent: "Parent", player: "Player" }[role] || role;
}

function buildEventTypeSeg() {
  const labels = labelsFor(teamMeta.sport);
  const types = [
    ["match", labels.match],
    ["training", labels.training],
    ["social", labels.social],
  ];
  $("ne-type-seg").innerHTML = types.map(([t, lbl], i) =>
    `<button type="button" class="seg-btn ${i === 0 ? "active" : ""}" data-type="${t}">${escapeHtml(lbl)}</button>`
  ).join("");
  $("ne-type").value = "match";
  $("ne-type-seg").querySelectorAll(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      $("ne-type-seg").querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("ne-type").value = b.dataset.type;
    })
  );
}

// =====================================================================
// App-level action wiring (once)
// =====================================================================

function bindAppActions() {
  // Tab bar
  document.querySelectorAll(".tab-bar .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-bar .tab").forEach((b) => b.classList.toggle("active", b === btn));
      ["events", "chat", "team", "me"].forEach((id) => {
        $(`tab-${id}`).hidden = id !== target;
      });
    });
  });

  // Header → team switcher
  $("btn-switch-team").addEventListener("click", openSwitcher);
  document.querySelectorAll("[data-close-switcher]").forEach((el) =>
    el.addEventListener("click", () => $("modal-switcher").hidden = true)
  );
  $("btn-switcher-add").addEventListener("click", () => {
    $("modal-switcher").hidden = true;
    showWelcome();
  });
  $("btn-add-team").addEventListener("click", () => showWelcome());

  // Sign out
  $("btn-signout").addEventListener("click", () => {
    if (!confirm("Sign out of all teams on this device?")) return;
    clearAll();
    location.reload();
  });

  // New event
  $("btn-new-event").addEventListener("click", openNewEventModal);
  document.querySelectorAll("[data-close-new]").forEach((el) =>
    el.addEventListener("click", () => $("modal-new-event").hidden = true)
  );
  $("form-new-event").addEventListener("submit", onCreateEvent);

  // Event detail modal close
  $("modal-close").addEventListener("click", () => $("modal-event").hidden = true);
  $("modal-event").querySelector(".modal-backdrop").addEventListener("click", () => $("modal-event").hidden = true);

  // Invite generation
  $("btn-new-invite").addEventListener("click", onGenerateInvite);
}

// =====================================================================
// Events & RSVPs
// =====================================================================

let eventsCache = {};
let playersCache = {};
let membersCache = {};

function subscribeEvents() {
  const evRef = ref(db, `teams/${activeTeamId}/events`);
  onValue(evRef, (snap) => {
    eventsCache = snap.val() || {};
    renderEvents();
  });
  subscriptions.push(evRef);

  const pRef = ref(db, `teams/${activeTeamId}/players`);
  onValue(pRef, (snap) => {
    playersCache = snap.val() || {};
    renderEvents();
    renderTeam();
  });
  subscriptions.push(pRef);
}

function renderEvents() {
  const list = $("events-list");
  const now = Date.now();
  const upcoming = Object.entries(eventsCache)
    .map(([id, e]) => ({ id, ...e }))
    .filter((e) => e.when >= now - 1000 * 60 * 60 * 4)
    .sort((a, b) => a.when - b.when);

  if (upcoming.length === 0) {
    list.innerHTML = '<div class="empty">No upcoming events yet.</div>';
    return;
  }

  list.innerHTML = upcoming.map((e, i) => renderEventCard(e, i === 0)).join("");

  list.querySelectorAll(".event-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll(".rsvp-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setMyRsvp(id, btn.dataset.status);
      });
    });
    card.addEventListener("click", () => openEventDetail(id));
  });
}

function renderEventCard(e, isNext) {
  const when = fmtDate(e.when);
  const counts = countRsvps(e.rsvps);
  const myStatus = getMyRsvpStatus(e);
  const isPast = e.when < Date.now() - 1000 * 60 * 60 * 2;
  const labels = labelsFor(teamMeta.sport);
  const typeLabel = labels[e.type] || labels.match;

  return `
    <article class="event-card ${isNext ? "next" : ""}" data-id="${e.id}">
      <div class="event-meta">
        <span class="badge ${e.type}">${escapeHtml(typeLabel)}</span>
        <span>${when.day} ${when.date}</span>
      </div>
      <h3 class="event-title">${escapeHtml(e.title)}</h3>
      <div class="event-when">${when.time}${e.location ? " · " + escapeHtml(e.location) : ""}</div>
      ${isPast ? "" : renderRsvpRow(myStatus)}
      <div class="counts">
        <span><span class="dot yes"></span>${counts.yes} yes</span>
        <span><span class="dot maybe"></span>${counts.maybe} maybe</span>
        <span><span class="dot no"></span>${counts.no} out</span>
        ${counts.none > 0 ? `<span><span class="dot none"></span>${counts.none} pending</span>` : ""}
      </div>
    </article>
  `;
}

function renderRsvpRow(myStatus) {
  const childName = childNameForSession();
  const yesLabel = myMember.role === "parent" && childName ? `${childName} in` : "In";
  return `
    <div class="rsvp-row" onclick="event.stopPropagation()">
      <button class="rsvp-btn ${myStatus === "no" ? "selected no" : ""}" data-status="no">Out</button>
      <button class="rsvp-btn ${myStatus === "maybe" ? "selected maybe" : ""}" data-status="maybe">Maybe</button>
      <button class="rsvp-btn ${myStatus === "yes" ? "selected yes" : ""}" data-status="yes">${escapeHtml(yesLabel)}</button>
    </div>
  `;
}

function childNameForSession() {
  if (myMember.role === "parent" && myMember.childOf) {
    return playersCache[myMember.childOf]?.name?.split(/\s+/)[0] || null;
  }
  if (myMember.role === "player") return user.name?.split(/\s+/)[0] || null;
  return null;
}

function countRsvps(rsvps) {
  const totalPlayers = Object.keys(playersCache).length || 1;
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const r of Object.values(rsvps || {})) {
    if (counts[r.status] !== undefined) counts[r.status]++;
  }
  counts.none = Math.max(0, totalPlayers - counts.yes - counts.maybe - counts.no);
  return counts;
}

function getMyRsvpStatus(event) {
  const playerUid = myMember.role === "parent" ? myMember.childOf
                  : myMember.role === "player" ? user.uid
                  : null;
  if (!playerUid) return null;
  return event.rsvps?.[playerUid]?.status || null;
}

async function setMyRsvp(eventId, status) {
  const playerUid = myMember.role === "parent" ? myMember.childOf
                  : myMember.role === "player" ? user.uid
                  : null;
  if (!playerUid) {
    toast("Coaches can RSVP from the event detail view.");
    return;
  }
  await set(ref(db, `teams/${activeTeamId}/events/${eventId}/rsvps/${playerUid}`), {
    status, respondedBy: user.uid, respondedAt: Date.now(),
  });
  toast(status === "yes" ? "You're in" : status === "maybe" ? "Marked maybe" : "Marked out");
}

function openEventDetail(eventId) {
  const e = { id: eventId, ...eventsCache[eventId] };
  if (!e.title) return;
  const when = fmtDate(e.when);
  const labels = labelsFor(teamMeta.sport);
  const typeLabel = labels[e.type] || labels.match;

  const players = Object.entries(playersCache).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const rsvpLines = players.map(([uid, p]) => {
    const r = e.rsvps?.[uid];
    const status = r?.status || "none";
    const label = { yes: "In", maybe: "Maybe", no: "Out", none: "—" }[status];
    const coachCtl = myMember.role === "coach"
      ? ` <button class="rsvp-btn" style="flex:0;padding:4px 8px;font-size:11px" data-coach-rsvp="${uid}">edit</button>` : "";
    return `
      <div class="rsvp-line">
        <div class="avatar">${initials(p.name)}</div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="status ${status}">${label}</div>
        ${coachCtl}
      </div>
    `;
  }).join("");

  $("modal-body").innerHTML = `
    <div class="detail-hero">
      <span class="badge ${e.type}">${escapeHtml(typeLabel)}</span>
      <div class="detail-title">${escapeHtml(e.title)}</div>
      <div class="detail-when">${when.full}${e.location ? " · " + escapeHtml(e.location) : ""}</div>
    </div>
    ${e.notes ? `<p style="margin:0 0 16px;color:var(--ink-2);font-size:14px">${escapeHtml(e.notes)}</p>` : ""}
    <div class="section-label" style="margin-left:0">Responses</div>
    <div class="detail-rsvp-list">${rsvpLines || '<div class="empty">No players yet.</div>'}</div>
    ${myMember.role === "coach" ? `<button id="btn-delete-event" class="btn btn-secondary" style="width:100%;margin-top:20px;color:var(--red);border-color:var(--red)">Delete event</button>` : ""}
  `;
  $("modal-event").hidden = false;

  if (myMember.role === "coach") {
    $("modal-body").querySelectorAll("[data-coach-rsvp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const playerUid = btn.dataset.coachRsvp;
        const next = prompt("Set status: yes / maybe / no / clear", "yes");
        if (!next) return;
        if (next === "clear") {
          remove(ref(db, `teams/${activeTeamId}/events/${eventId}/rsvps/${playerUid}`));
        } else if (["yes", "maybe", "no"].includes(next)) {
          set(ref(db, `teams/${activeTeamId}/events/${eventId}/rsvps/${playerUid}`), {
            status: next, respondedBy: user.uid, respondedAt: Date.now(),
          });
        }
      });
    });
    $("btn-delete-event")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${e.title}"? This can't be undone.`)) return;
      await remove(ref(db, `teams/${activeTeamId}/events/${eventId}`));
      $("modal-event").hidden = true;
      toast("Event deleted");
    });
  }
}

function openNewEventModal() {
  $("modal-new-event").hidden = false;
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
  d.setHours(10, 0, 0, 0);
  const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("ne-when").value = iso;
  $("ne-title").value = "";
  $("ne-location").value = "";
  $("ne-notes").value = "";
  const labels = labelsFor(teamMeta.sport);
  $("ne-heading").textContent = `New ${labels.match.toLowerCase()} / ${labels.training.toLowerCase()} / ${labels.social.toLowerCase()}`;
}

async function onCreateEvent(e) {
  e.preventDefault();
  const event = {
    type: $("ne-type").value,
    title: $("ne-title").value.trim(),
    when: new Date($("ne-when").value).getTime(),
    location: $("ne-location").value.trim(),
    notes: $("ne-notes").value.trim(),
    createdBy: user.uid,
    createdAt: Date.now(),
  };
  const newRef = push(ref(db, `teams/${activeTeamId}/events`));
  await set(newRef, event);
  $("modal-new-event").hidden = true;
  toast("Event created");
}

// =====================================================================
// Team list, invites
// =====================================================================

function subscribeTeam() {
  const mRef = ref(db, `teams/${activeTeamId}/members`);
  onValue(mRef, (snap) => {
    membersCache = snap.val() || {};
    renderTeam();
  });
  subscriptions.push(mRef);
}

function renderTeam() {
  const list = $("team-list");
  const players = Object.entries(playersCache).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const coaches = Object.entries(membersCache).filter(([_, m]) => m.role === "coach");

  const html = [];
  if (coaches.length) {
    html.push('<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-3);margin:0 0 4px">Coaches</div>');
    html.push(coaches.map(([uid, m]) => `
      <div class="member">
        <div class="avatar">${initials(m.name)}</div>
        <div class="member-text"><div class="member-name">${escapeHtml(m.name)}</div></div>
        <div class="role-pill coach">Coach</div>
      </div>
    `).join(""));
  }

  html.push('<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-3);margin:14px 0 4px">Players</div>');
  if (players.length === 0) {
    html.push('<div class="empty">No players yet — parents will add them when they join.</div>');
  } else {
    html.push(players.map(([uid, p]) => {
      const parents = Object.values(membersCache).filter((m) => m.childOf === uid);
      const parentNote = parents.length ? parents.map((m) => m.name).join(", ") : "No parent linked";
      return `
        <div class="member">
          <div class="avatar">${initials(p.name)}</div>
          <div class="member-text">
            <div class="member-name">${escapeHtml(p.name)}</div>
            <div class="member-role">${escapeHtml(parentNote)}</div>
          </div>
        </div>
      `;
    }).join(""));
  }
  list.innerHTML = html.join("");
}

function subscribeInvites() {
  const iRef = ref(db, `teams/${activeTeamId}/invites`);
  onValue(iRef, (snap) => {
    const invites = snap.val() || {};
    const active = Object.entries(invites)
      .filter(([_, i]) => !i.used && (!i.expiresAt || i.expiresAt > Date.now()))
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    $("invites-list").innerHTML = active.length ? active.map(([code, i]) => `
      <div class="invite-item">
        <div class="invite-code">${code}</div>
        <div class="invite-meta">${roleLabel(i.role)}<br>${i.expiresAt ? "expires " + new Date(i.expiresAt).toLocaleDateString("en-GB") : "no expiry"}</div>
        <button class="icon-btn" data-copy="${code}" title="Copy" style="color:var(--ink-2)">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="6" y="6" width="11" height="11" rx="2" /><rect x="3" y="3" width="11" height="11" rx="2" />
          </svg>
        </button>
      </div>
    `).join("") : '<div class="empty">No active invites. Tap the button below to generate one.</div>';

    $("invites-list").querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.copy);
        toast(`Copied ${btn.dataset.copy}`);
      });
    });
  });
  subscriptions.push(iRef);
}

async function onGenerateInvite() {
  const role = prompt("Generate invite for: coach / parent / player", "parent");
  if (!role || !["coach", "parent", "player"].includes(role)) return;
  const code = genCode();
  await update(ref(db), {
    [`teams/${activeTeamId}/invites/${code}`]: {
      role,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14,
      used: false,
    },
    [`inviteIndex/${code}`]: { teamId: activeTeamId, createdAt: Date.now() },
  });
  toast(`Code: ${code}`);
}

// =====================================================================
// Team switcher + my-teams list
// =====================================================================

async function renderMyTeams() {
  const teams = await listMyTeams();
  $("my-teams-list").innerHTML = teams.map((t) => renderTeamRow(t)).join("");
  $("my-teams-list").querySelectorAll(".team-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      if (id !== activeTeamId) {
        saveActive(id);
        enterTeam(id);
      }
    });
  });
}

function renderTeamRow(t) {
  const current = t.id === activeTeamId ? "current" : "";
  const subtitle = [t.ageGroup, prettySport(t.sport)].filter(Boolean).join(" · ");
  return `
    <div class="team-row ${current}" data-id="${t.id}">
      <div class="avatar" style="background:${t.colors?.primary || "#1a1a1f"};color:${contrastInk(t.colors?.primary || "#1a1a1f")}">${initials(t.name)}</div>
      <div class="team-text">
        <div class="team-name">${escapeHtml(t.name)}</div>
        <div class="team-meta">${escapeHtml(subtitle)}</div>
      </div>
      ${current ? '<div class="role-pill" style="background:var(--pri);color:var(--pri-ink)">Active</div>' : ""}
    </div>
  `;
}

async function openSwitcher() {
  const teams = await listMyTeams();
  $("switcher-list").innerHTML = teams.map(renderTeamRow).join("");
  $("switcher-list").querySelectorAll(".team-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      $("modal-switcher").hidden = true;
      if (id !== activeTeamId) {
        saveActive(id);
        enterTeam(id);
      }
    });
  });
  $("modal-switcher").hidden = false;
}

// =====================================================================
// Install prompt
// =====================================================================

let deferredInstall = null;
function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    $("btn-install").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      $("btn-install").hidden = true;
    } else {
      toast("On iPhone: tap Share, then Add to Home Screen");
    }
  });
}

// =====================================================================
// Service worker
// =====================================================================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

boot();
