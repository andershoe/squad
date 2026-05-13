// =====================================================================
// Squad — multi-team team manager
// One user identity, N teams. Per-team theme injected at runtime.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, get, set, push, onValue, onChildAdded, update, remove, off, query, limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

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
const auth = getAuth(app);
const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();

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

const linkify = (s) => {
  const escaped = escapeHtml(s);
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>'
  );
};

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
// UID comes from Firebase Anonymous Auth (persists in IndexedDB across sessions).
// User's display name is cached in localStorage and backed by Firebase.

const NAME_KEY = "squad.name.v1";
const ACTIVE_KEY = "squad.active.v1";

let user = null;        // { uid, name } — uid from Firebase Auth
let activeTeamId = null;
let teamMeta = null;    // current team's meta { name, sport, colors, ... }
let myMember = null;    // { role, childOf?, ... } for current team

function loadCachedName() {
  try { return localStorage.getItem(NAME_KEY) || null; }
  catch { return null; }
}
function saveName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}
function loadActive() { activeTeamId = localStorage.getItem(ACTIVE_KEY) || null; }
function saveActive(id) { activeTeamId = id; localStorage.setItem(ACTIVE_KEY, id); }
async function clearAll() {
  try {
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  } catch {}
  user = null;
  activeTeamId = null;
  await signOut(auth).catch(() => {});
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
// Boot — driven by Firebase Google Auth state
// =====================================================================

onAuthStateChanged(auth, async (firebaseUser) => {
  if (!firebaseUser) {
    showSignIn();
    return;
  }

  user = { uid: firebaseUser.uid, name: loadCachedName() || firebaseUser.displayName || null };

  loadActive();

  if (!user.name) return showWelcome();

  const teams = await listMyTeams();
  if (teams.length === 0) return showWelcome();

  if (!activeTeamId || !teams.find((t) => t.id === activeTeamId)) {
    saveActive(teams[0].id);
  }

  await enterTeam(activeTeamId);
});

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
  ["welcome", "join", "create", "app", "signin"].forEach((v) => {
    $(`view-${v}`).hidden = v !== name;
  });
  $("splash").hidden = true;
}

function showWelcome() {
  setTheme("#1a1a1f", "#d62828");
  showView("welcome");
}

function showSignIn() {
  setTheme("#1a1a1f", "#d62828");
  showView("signin");
}

async function signInWithGoogle() {
  $("signin-error").hidden = true;
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      $("signin-error").textContent = "Sign-in failed. Please try again.";
      $("signin-error").hidden = false;
    }
  }
}

// =====================================================================
// Sign-in + Welcome screen
// =====================================================================

$("btn-google-signin").addEventListener("click", signInWithGoogle);

$("btn-welcome-signout").addEventListener("click", async () => {
  await clearAll();
  location.reload();
});

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

  // Set/update display name
  if (user.name !== coachName) {
    user.name = coachName;
    saveName(coachName);
    await set(ref(db, `users/${user.uid}`), { name: coachName, createdAt: Date.now() });
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
let pickedPlayerUid = null;

$("join-code").addEventListener("input", () => {
  const code = $("join-code").value.trim().toUpperCase();
  $("join-code").value = code;
  clearTimeout(codePeekTimer);
  pickedPlayerUid = null;
  if (code.length < 5) {
    $("join-parent-block").hidden = true;
    return;
  }
  codePeekTimer = setTimeout(async () => {
    const invite = await findInviteByCode(code);
    if (invite && invite.role === "parent") {
      $("join-parent-block").hidden = false;
      await loadJoinPlayerList(invite.teamId);
    } else {
      $("join-parent-block").hidden = true;
      $("join-child").required = false;
    }
  }, 250);
});

async function loadJoinPlayerList(teamId) {
  pickedPlayerUid = null;
  $("join-child-wrap").hidden = true;
  $("join-child").required = false;
  $("join-child").value = "";

  const snap = await get(ref(db, `teams/${teamId}/players`));
  const players = snap.val() || {};
  const entries = Object.entries(players).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const list = $("join-player-list");

  if (entries.length === 0) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:4px 0">No players added yet.</div>';
    $("btn-child-not-listed").hidden = true;
    $("join-child-wrap").hidden = false;
    $("join-child").required = true;
    return;
  }

  list.innerHTML = entries.map(([uid, p]) =>
    `<button type="button" class="player-pick-item" data-uid="${uid}">${escapeHtml(p.name)}</button>`
  ).join("");

  list.querySelectorAll(".player-pick-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      list.querySelectorAll(".player-pick-item").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      pickedPlayerUid = btn.dataset.uid;
      $("join-child-wrap").hidden = true;
      $("join-child").required = false;
    });
  });

  $("btn-child-not-listed").hidden = false;
}

$("btn-child-not-listed").addEventListener("click", () => {
  $("join-player-list").querySelectorAll(".player-pick-item").forEach((b) => b.classList.remove("selected"));
  pickedPlayerUid = null;
  $("join-child-wrap").hidden = false;
  $("join-child").required = true;
  $("join-child").focus();
});

async function findInviteByCode(code) {
  const c = code.trim().toUpperCase();
  const idxSnap = await get(ref(db, `inviteIndex/${c}`));
  const idx = idxSnap.val();
  if (!idx) return null;
  const snap = await get(ref(db, `teams/${idx.teamId}/invites/${c}`));
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
    if (invite.expiresAt && invite.expiresAt < Date.now()) {
      return showJoinError("That code has expired. Ask for a new one.");
    }
    if (invite.role === "parent" && !pickedPlayerUid && !childName) {
      return showJoinError("Please select your child or add them using the link below.");
    }

    // Set/update display name
    if (user.name !== name) {
      user.name = name;
      saveName(name);
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
      playerUid = pickedPlayerUid || await ensurePlayer(teamId, childName);
      member.childOf = playerUid;
    } else if (invite.role === "player") {
      playerUid = user.uid;
    }

    await update(ref(db), {
      [`teams/${teamId}/members/${user.uid}`]: member,
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
  subscriptions.forEach((s) => typeof s === "function" ? s() : off(s));
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
  $("btn-add-player").hidden = !isCoach;
  $("home-ground-label").hidden = !isCoach;
  $("home-ground-section").hidden = !isCoach;
  $("league-teams-label").hidden = !isCoach;
  $("league-teams-list").hidden = !isCoach;
  $("btn-add-league-team").hidden = !isCoach;
  if (isCoach) $("home-ground-input").value = teamMeta.homeGround || "";

  // Populate sport-specific event type segmented control
  buildEventTypeSeg();

  // Bind once
  if (!enterTeam._bound) {
    bindAppActions();
    enterTeam._bound = true;
  }

  // Coach-only chat button
  $("btn-chat-announce").hidden = !isCoach;

  // Subscribe to data
  subscribeEvents();
  subscribeTeam();
  subscribeChat();
  subscribeLeagueTeams();
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
      $("ne-match-config").hidden = b.dataset.type !== "match";
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
  $("btn-signout").addEventListener("click", async () => {
    if (!confirm("Sign out of all teams on this device?")) return;
    await clearAll();
    location.reload();
  });

  // Home/Away toggle
  $("ne-homeaway-seg").querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("ne-homeaway-seg").querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $("ne-homeaway").value = btn.dataset.ha;
      applyHomeAwayLocation(btn.dataset.ha);
    });
  });

  // New event
  $("btn-new-event").addEventListener("click", () => openNewEventModal());
  document.querySelectorAll("[data-close-new]").forEach((el) =>
    el.addEventListener("click", () => {
      $("modal-new-event").hidden = true;
      $("form-new-event").removeAttribute("data-edit-id");
    })
  );
  $("form-new-event").addEventListener("submit", onCreateEvent);

  // Event detail modal close
  $("modal-close").addEventListener("click", () => $("modal-event").hidden = true);
  $("modal-event").querySelector(".modal-backdrop").addEventListener("click", () => $("modal-event").hidden = true);

  // Chat
  $("btn-chat-send").addEventListener("click", () => sendChatMessage("message"));
  $("btn-chat-announce").addEventListener("click", () => sendChatMessage("announcement"));
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage("message"); }
  });
  $("chat-input").addEventListener("input", () => {
    const el = $("chat-input");
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  });

  $("btn-chat-photo").addEventListener("click", () => $("chat-photo-input").click());
  $("chat-photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast("Image too large (max 10 MB)"); return; }
    await sendChatImage(file);
  });
  document.querySelectorAll(".tab-bar .tab").forEach((btn) => {
    if (btn.dataset.tab === "chat") {
      btn.addEventListener("click", () => {
        const list = $("chat-messages");
        setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
        markRead();
      });
    }
  });

  setupLightbox();

  // Player profile modals
  document.querySelectorAll("[data-close-player]").forEach((el) =>
    el.addEventListener("click", () => $("modal-player").hidden = true)
  );
  document.querySelectorAll("[data-close-player-edit]").forEach((el) =>
    el.addEventListener("click", () => $("modal-player-edit").hidden = true)
  );
  $("pe-photo-wrap").addEventListener("click", () => $("pe-photo-input").click());
  $("pe-photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file && editingPlayerUid) await uploadPlayerPhoto(editingPlayerUid, file);
  });
  $("btn-save-player").addEventListener("click", savePlayerEdit);

  // Home ground
  setupHomeGroundAutocomplete();
  $("btn-save-home-ground").addEventListener("click", async () => {
    const val = $("home-ground-input").value.trim();
    const updates = { [`teams/${activeTeamId}/meta/homeGround`]: val || null };
    if (homeGroundPicked) {
      updates[`teams/${activeTeamId}/meta/homeGroundPlaceId`] = homeGroundPicked.placeId || null;
      updates[`teams/${activeTeamId}/meta/homeGroundLat`] = homeGroundPicked.lat || null;
      updates[`teams/${activeTeamId}/meta/homeGroundLon`] = homeGroundPicked.lon || null;
    }
    await update(ref(db), updates);
    teamMeta.homeGround = val;
    teamMeta.homeGroundPlaceId = homeGroundPicked?.placeId || null;
    teamMeta.homeGroundLat = homeGroundPicked?.lat || null;
    teamMeta.homeGroundLon = homeGroundPicked?.lon || null;
    homeGroundPicked = null;
    toast("Home ground saved");
  });

  // League teams
  $("btn-add-league-team").addEventListener("click", () => {
    $("add-lt-name").value = "";
    $("modal-add-league-team").hidden = false;
    $("add-lt-name").focus();
  });
  document.querySelectorAll("[data-close-add-lt]").forEach((el) =>
    el.addEventListener("click", () => $("modal-add-league-team").hidden = true)
  );
  $("add-lt-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmAddLeagueTeam(); }
  });
  $("btn-confirm-add-lt").addEventListener("click", confirmAddLeagueTeam);

  async function confirmAddLeagueTeam() {
    const name = $("add-lt-name").value.trim();
    if (!name) return;
    $("btn-confirm-add-lt").disabled = true;
    try {
      await push(ref(db, `teams/${activeTeamId}/leagueTeams`), { name });
      $("modal-add-league-team").hidden = true;
    } catch { toast("Couldn't save"); }
    finally { $("btn-confirm-add-lt").disabled = false; }
  }

  // Add player modal
  $("btn-add-player").addEventListener("click", () => {
    $("add-player-name").value = "";
    $("modal-add-player").hidden = false;
    $("add-player-name").focus();
  });
  document.querySelectorAll("[data-close-add-player]").forEach((el) =>
    el.addEventListener("click", () => $("modal-add-player").hidden = true)
  );
  $("add-player-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmAddPlayer(); }
  });
  $("btn-confirm-add-player").addEventListener("click", confirmAddPlayer);

  async function confirmAddPlayer() {
    const name = $("add-player-name").value.trim();
    if (!name) return;
    $("btn-confirm-add-player").disabled = true;
    try {
      await set(ref(db, `teams/${activeTeamId}/players/${genId()}`), {
        name, createdAt: Date.now(),
      });
      $("modal-add-player").hidden = true;
      toast(`${name} added`);
    } catch (err) {
      toast("Couldn't add player");
    } finally {
      $("btn-confirm-add-player").disabled = false;
    }
  }

  // Invite generation modal
  $("btn-new-invite").addEventListener("click", () => $("modal-invite").hidden = false);
  document.querySelectorAll("[data-close-invite]").forEach((el) =>
    el.addEventListener("click", () => $("modal-invite").hidden = true)
  );
  document.querySelectorAll(".invite-role-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("modal-invite").hidden = true;
      onGenerateInvite(btn.dataset.role);
    })
  );
}

// =====================================================================
// Events & RSVPs
// =====================================================================

let eventsCache = {};
let playersCache = {};
let membersCache = {};
let leagueTeamsCache = {};
let locationPicked = null;
let homeGroundPicked = null;

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

function locationLink(e, extraClass = "") {
  if (!e.location) return "";
  let url;
  if (e.locationPlaceId) {
    url = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(e.locationPlaceId)}`;
  } else {
    const lat = parseFloat(e.locationLat);
    const lon = parseFloat(e.locationLon);
    url = (!isNaN(lat) && !isNaN(lon))
      ? `https://www.google.com/maps?q=${lat},${lon}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`;
  }
  return ` · <a href="${url}" target="_blank" rel="noopener noreferrer" class="location-link${extraClass ? " " + extraClass : ""}" onclick="event.stopPropagation()">${escapeHtml(e.location)}</a>`;
}


function setupLocationAutocomplete() {
  const input = $("ne-location");
  const dropdown = $("ne-location-ac");
  let debounceTimer = null;
  let sessionToken = crypto.randomUUID();

  input.addEventListener("input", () => {
    locationPicked = null;
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 2) { dropdown.hidden = true; return; }
    debounceTimer = setTimeout(() => fetchPlacesSuggestions(q), 350);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => { dropdown.hidden = true; }, 150);
  });

  async function fetchPlacesSuggestions(q) {
    const key = window.MAPS_API_KEY;
    if (!key || key.startsWith("REPLACE")) { dropdown.hidden = true; return; }

    try {
      const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
        },
        body: JSON.stringify({
          input: q,
          includedRegionCodes: ["gb"],
          sessionToken,
        }),
      });
      const data = await res.json();
      const suggestions = data.suggestions || [];
      if (!suggestions.length) { dropdown.hidden = true; return; }

      dropdown.innerHTML = suggestions.map((s, i) => {
        const p = s.placePrediction;
        const main = p.structuredFormat?.mainText?.text || "";
        const secondary = p.structuredFormat?.secondaryText?.text || "";
        return `<div class="ac-item" data-index="${i}" data-place-id="${escapeHtml(p.placeId)}">
          <div class="ac-name">${escapeHtml(main)}</div>
          ${secondary ? `<div class="ac-detail">${escapeHtml(secondary)}</div>` : ""}
        </div>`;
      }).join("");

      dropdown.querySelectorAll(".ac-item").forEach((el) => {
        el.addEventListener("mousedown", async (ev) => {
          ev.preventDefault();
          const placeId = el.dataset.placeId;
          const idx = parseInt(el.dataset.index);
          const p = suggestions[idx]?.placePrediction;
          input.value = p?.structuredFormat?.mainText?.text || input.value;
          dropdown.hidden = true;

          // Fetch coordinates + reset session token (session ends on selection)
          sessionToken = crypto.randomUUID();
          const loc = await fetchPlaceLocation(placeId, key);
          if (loc) locationPicked = { lat: loc.latitude, lon: loc.longitude, placeId };
        });
      });

      dropdown.hidden = false;
    } catch {
      dropdown.hidden = true;
    }
  }
}

function setupHomeGroundAutocomplete() {
  const input = $("home-ground-input");
  const dropdown = $("home-ground-ac");
  let debounceTimer = null;
  let sessionToken = crypto.randomUUID();

  input.addEventListener("input", () => {
    homeGroundPicked = null;
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 2) { dropdown.hidden = true; return; }
    debounceTimer = setTimeout(async () => {
      const key = window.MAPS_API_KEY;
      if (!key || key.startsWith("REPLACE")) { dropdown.hidden = true; return; }
      try {
        const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat" },
          body: JSON.stringify({ input: q, includedRegionCodes: ["gb"], sessionToken }),
        });
        const data = await res.json();
        const suggestions = data.suggestions || [];
        if (!suggestions.length) { dropdown.hidden = true; return; }
        dropdown.innerHTML = suggestions.map((s, i) => {
          const p = s.placePrediction;
          const main = p.structuredFormat?.mainText?.text || "";
          const secondary = p.structuredFormat?.secondaryText?.text || "";
          return `<div class="ac-item" data-index="${i}" data-place-id="${escapeHtml(p.placeId)}">
            <div class="ac-name">${escapeHtml(main)}</div>
            ${secondary ? `<div class="ac-detail">${escapeHtml(secondary)}</div>` : ""}
          </div>`;
        }).join("");
        dropdown.querySelectorAll(".ac-item").forEach((el) => {
          el.addEventListener("mousedown", async (ev) => {
            ev.preventDefault();
            const placeId = el.dataset.placeId;
            const idx = parseInt(el.dataset.index);
            const p = suggestions[idx]?.placePrediction;
            input.value = p?.structuredFormat?.mainText?.text || input.value;
            dropdown.hidden = true;
            sessionToken = crypto.randomUUID();
            const loc = await fetchPlaceLocation(placeId, key);
            if (loc) homeGroundPicked = { lat: loc.latitude, lon: loc.longitude, placeId };
          });
        });
        dropdown.hidden = false;
      } catch { dropdown.hidden = true; }
    }, 350);
  });
  input.addEventListener("blur", () => setTimeout(() => { dropdown.hidden = true; }, 150));
}

async function fetchPlaceLocation(placeId, key) {
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "location",
      },
    });
    const data = await res.json();
    return data.location || null;
  } catch {
    return null;
  }
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
        ${e.homeAway === "home" ? '<span class="badge home-away">H</span>' : e.homeAway === "away" ? '<span class="badge home-away away">A</span>' : ""}
        <span>${when.day} ${when.date}</span>
      </div>
      <h3 class="event-title">${escapeHtml(e.title)}</h3>
      <div class="event-when">${when.time}${locationLink(e)}</div>
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
  const playerUid = myMember.role === "parent" ? myMember.childOf : user.uid;
  return event.rsvps?.[playerUid]?.status || null;
}

async function setMyRsvp(eventId, status) {
  const playerUid = myMember.role === "parent" ? myMember.childOf : user.uid;
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

  const myRsvpStatus = e.rsvps?.[user.uid]?.status || null;
  const myRsvpHtml = myMember.role === "coach" ? `
    <div class="section-label" style="margin-left:0">Your attendance</div>
    <div class="rsvp-row" style="margin-bottom:16px">
      <button class="rsvp-btn ${myRsvpStatus === "no" ? "selected no" : ""}" data-self-rsvp="no">Out</button>
      <button class="rsvp-btn ${myRsvpStatus === "maybe" ? "selected maybe" : ""}" data-self-rsvp="maybe">Maybe</button>
      <button class="rsvp-btn ${myRsvpStatus === "yes" ? "selected yes" : ""}" data-self-rsvp="yes">In</button>
    </div>
  ` : "";

  $("modal-body").innerHTML = `
    <div class="detail-hero">
      <span class="badge ${e.type}">${escapeHtml(typeLabel)}</span>
      <div class="detail-title">${escapeHtml(e.title)}</div>
      <div class="detail-when">${when.full}${locationLink(e, "detail-location-link")}</div>
    </div>
    ${e.notes ? `<p style="margin:0 0 16px;color:var(--ink-2);font-size:14px">${escapeHtml(e.notes)}</p>` : ""}
    ${myRsvpHtml}
    <div class="section-label" style="margin-left:0">Responses</div>
    <div class="detail-rsvp-list">${rsvpLines || '<div class="empty">No players yet.</div>'}</div>
    ${myMember.role === "coach" ? `
      <button id="btn-edit-event" class="btn btn-secondary" style="width:100%;margin-top:20px">Edit event</button>
      <button id="btn-delete-event" class="btn btn-secondary" style="width:100%;margin-top:8px;color:var(--red);border-color:var(--red)">Delete event</button>
    ` : ""}
  `;
  $("modal-event").hidden = false;

  $("modal-body").querySelectorAll("[data-self-rsvp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await setMyRsvp(eventId, btn.dataset.selfRsvp);
      $("modal-event").hidden = true;
    });
  });

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
    $("btn-edit-event")?.addEventListener("click", () => {
      $("modal-event").hidden = true;
      openNewEventModal({ ...e, id: eventId });
    });
    $("btn-delete-event")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${e.title}"? This can't be undone.`)) return;
      await remove(ref(db, `teams/${activeTeamId}/events/${eventId}`));
      $("modal-event").hidden = true;
      toast("Event deleted");
    });
  }
}

function openNewEventModal(existing) {
  locationPicked = null;
  $("modal-new-event").hidden = false;

  const type = existing?.type || "match";
  const isMatch = type === "match";

  // Match-only config visibility
  $("ne-match-config").hidden = !isMatch;

  // Rebuild opponent chips whenever modal opens
  buildOpponentChips(existing?.opponent || null);

  // Home/Away state
  const ha = existing?.homeAway || "home";
  $("ne-homeaway").value = ha;
  $("ne-homeaway-seg").querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.ha === ha)
  );

  if (existing) {
    $("ne-heading").textContent = "Edit event";
    $("ne-submit").textContent = "Update event";
    $("ne-title").value = existing.title || "";
    const iso = existing.when
      ? new Date(existing.when - new Date(existing.when).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "";
    $("ne-when").value = iso;
    $("ne-location").value = existing.location || "";
    if (existing.locationLat && existing.locationLon) {
      locationPicked = { lat: existing.locationLat, lon: existing.locationLon };
    }
    $("ne-notes").value = existing.notes || "";
    $("ne-type").value = type;
    $("ne-type-seg").querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.type === type)
    );
    $("form-new-event").dataset.editId = existing.id;
  } else {
    const labels = labelsFor(teamMeta.sport);
    $("ne-heading").textContent = `New ${labels.match.toLowerCase()} / ${labels.training.toLowerCase()} / ${labels.social.toLowerCase()}`;
    $("ne-submit").textContent = "Create event";
    const d = new Date();
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
    d.setHours(10, 0, 0, 0);
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $("ne-when").value = iso;
    $("ne-title").value = "";
    $("ne-location").value = "";
    $("ne-notes").value = "";
    $("ne-type").value = "match";
    $("ne-type-seg").querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.type === "match")
    );
    $("form-new-event").removeAttribute("data-edit-id");
    // Auto-fill home ground for new home matches
    applyHomeAwayLocation("home");
  }
}

function buildOpponentChips(selectedOpponent) {
  $("ne-opponent").value = selectedOpponent || "";
  $("ne-opponent-other-wrap").hidden = true;
  $("ne-opponent-other").value = "";
  const chips = $("ne-opponent-chips");
  const entries = Object.entries(leagueTeamsCache).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const allChips = [
    ...entries.map(([, t]) => ({ label: t.name, value: t.name })),
    { label: "Other…", value: "__other__", other: true },
  ];
  chips.innerHTML = allChips.map((c) =>
    `<button type="button" class="opponent-chip${c.other ? " other" : ""}${c.value === selectedOpponent ? " selected" : ""}" data-val="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`
  ).join("");

  chips.querySelectorAll(".opponent-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      chips.querySelectorAll(".opponent-chip").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      if (btn.dataset.val === "__other__") {
        $("ne-opponent-other-wrap").hidden = false;
        $("ne-opponent-other").focus();
        $("ne-opponent").value = "";
        $("ne-opponent-other").oninput = () => {
          $("ne-opponent").value = $("ne-opponent-other").value.trim();
          if ($("ne-title").value === "" || $("ne-title").value.startsWith("vs ")) {
            $("ne-title").value = $("ne-opponent-other").value.trim() ? `vs ${$("ne-opponent-other").value.trim()}` : "";
          }
        };
      } else {
        $("ne-opponent-other-wrap").hidden = true;
        $("ne-opponent").value = btn.dataset.val;
        if ($("ne-title").value === "" || $("ne-title").value.startsWith("vs ")) {
          $("ne-title").value = `vs ${btn.dataset.val}`;
        }
      }
    });
  });
}

function applyHomeAwayLocation(ha) {
  if (ha === "home" && teamMeta.homeGround) {
    $("ne-location").value = teamMeta.homeGround;
    locationPicked = teamMeta.homeGroundLat ? {
      lat: teamMeta.homeGroundLat, lon: teamMeta.homeGroundLon,
      placeId: teamMeta.homeGroundPlaceId || null,
    } : null;
  } else if (ha === "away") {
    $("ne-location").value = "";
    locationPicked = null;
  }
}

async function onCreateEvent(e) {
  e.preventDefault();
  const loc = $("ne-location").value.trim();
  const eventData = {
    type: $("ne-type").value,
    title: $("ne-title").value.trim(),
    when: new Date($("ne-when").value).getTime(),
    location: loc,
    locationPlaceId: locationPicked?.placeId || null,
    locationLat: locationPicked?.lat || null,
    locationLon: locationPicked?.lon || null,
    notes: $("ne-notes").value.trim(),
  };

  if ($("ne-type").value === "match") {
    eventData.homeAway = $("ne-homeaway").value;
    eventData.opponent = $("ne-opponent").value.trim() || null;
  }

  const editId = $("form-new-event").dataset.editId;
  if (editId) {
    await update(ref(db, `teams/${activeTeamId}/events/${editId}`), eventData);
    toast("Event updated");
  } else {
    eventData.createdBy = user.uid;
    eventData.createdAt = Date.now();
    const newRef = push(ref(db, `teams/${activeTeamId}/events`));
    await set(newRef, eventData);
    toast("Event created");
  }

  locationPicked = null;
  $("form-new-event").removeAttribute("data-edit-id");
  $("modal-new-event").hidden = true;
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
  const isCoach = myMember.role === "coach";
  const players = Object.entries(playersCache).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const coaches = Object.entries(membersCache).filter(([_, m]) => m.role === "coach");

  const removeBtn = (uid, isPlayer = false) =>
    isCoach && uid !== user.uid
      ? `<button class="btn-remove" data-uid="${uid}" data-player="${isPlayer ? "1" : ""}">Remove</button>`
      : "";

  const html = [];
  if (coaches.length) {
    html.push('<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-3);margin:0 0 4px">Coaches</div>');
    html.push(coaches.map(([uid, m]) => `
      <div class="member">
        <div class="avatar">${initials(m.name)}</div>
        <div class="member-text"><div class="member-name">${escapeHtml(m.name)}</div></div>
        ${removeBtn(uid)}
        <div class="role-pill coach">Coach</div>
      </div>
    `).join(""));
  }

  html.push('<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-3);margin:14px 0 4px">Players</div>');
  if (players.length === 0) {
    html.push('<div class="empty">No players yet.</div>');
  } else {
    html.push(players.map(([playerUid, p]) => {
      const parents = Object.entries(membersCache).filter(([_, m]) => m.childOf === playerUid);
      const parentAvatars = parents.length
        ? parents.map(([pUid, m]) =>
            `<div class="parent-avatar${isCoach ? " removable" : ""}" title="${escapeHtml(m.name)}" data-parent-uid="${pUid}" data-parent-name="${escapeHtml(m.name)}">${initials(m.name)}</div>`
          ).join("")
        : `<span class="no-parent-hint">No parent</span>`;
      const photoEl = p.photoUrl
        ? `<img src="${escapeHtml(p.photoUrl)}" class="member-photo" />`
        : `<div class="avatar">${initials(p.name)}</div>`;
      return `
        <div class="member clickable" data-player-uid="${playerUid}">
          ${photoEl}
          <div class="member-text">
            <div class="member-name">${p.squadNumber ? `<span class="squad-num">#${p.squadNumber}</span> ` : ""}${escapeHtml(p.name)}</div>
            ${p.nickname ? `<div class="member-sub">"${escapeHtml(p.nickname)}"</div>` : ""}
          </div>
          <div class="parent-avatars">${parentAvatars}</div>
          ${removeBtn(playerUid, true)}
        </div>
      `;
    }).join(""));
  }
  list.innerHTML = html.join("");

  if (isCoach) {
    list.querySelectorAll(".btn-remove").forEach((btn) => {
      btn.addEventListener("click", () => kickMember(btn.dataset.uid, btn.dataset.player === "1"));
    });
    list.querySelectorAll(".parent-avatar.removable").forEach((el) => {
      el.addEventListener("click", () => {
        if (confirm(`Remove ${el.dataset.parentName} from the team?`)) {
          kickMember(el.dataset.parentUid, false);
        }
      });
    });
  }

  list.querySelectorAll("[data-player-uid]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".btn-remove, .parent-avatar")) return;
      openPlayerCard(row.dataset.playerUid);
    });
  });
}

// =====================================================================
// Player profile
// =====================================================================

let editingPlayerUid = null;

function openPlayerCard(playerUid) {
  const player = playersCache[playerUid];
  if (!player) return;

  const isCoach = myMember.role === "coach";
  const parents = Object.entries(membersCache).filter(([_, m]) => m.childOf === playerUid);
  const isMyChild = parents.some(([pUid]) => pUid === user.uid);
  const canEdit = isCoach || isMyChild;

  const photoEl = player.photoUrl
    ? `<img src="${escapeHtml(player.photoUrl)}" class="player-card-photo" />`
    : `<div class="player-card-photo player-card-photo--placeholder">${initials(player.name)}</div>`;

  if (isMyChild && !isCoach) {
    // FIFA-style card for parents viewing their child
    $("player-card-body").innerHTML = renderFifaCard(player, playerUid, canEdit);
  } else {
    // Info card for coaches and others
    const parentRows = isCoach ? parents.map(([, m]) =>
      `<div class="player-card-row">
        <span class="player-card-label">Parent</span>
        <span>${escapeHtml(m.name)}${m.phone ? ` · <a href="tel:${escapeHtml(m.phone)}" style="color:inherit">${escapeHtml(m.phone)}</a>` : " <span style='color:var(--ink-3);font-size:12px'>no number</span>"}</span>
      </div>`
    ).join("") : "";

    const medicalRow = isCoach && player.medicalNotes
      ? `<div class="player-card-row player-card-row--medical">
           <span class="player-card-label">Medical</span>
           <span>${escapeHtml(player.medicalNotes)}</span>
         </div>` : "";

    $("player-card-body").innerHTML = `
      <div class="player-card-hero">
        ${photoEl}
        <div class="player-card-info">
          <div class="player-card-name">${escapeHtml(player.name)}</div>
          ${player.nickname ? `<div class="player-card-nick">"${escapeHtml(player.nickname)}"</div>` : ""}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            ${player.squadNumber ? `<div class="player-card-pos">#${player.squadNumber}</div>` : ""}
            ${player.position ? `<div class="player-card-pos">${escapeHtml(player.position)}</div>` : ""}
          </div>
        </div>
      </div>
      ${parentRows}${medicalRow}
      ${canEdit ? `<button id="btn-edit-this-player" class="btn btn-secondary" style="width:100%;margin-top:16px">Edit profile</button>` : ""}
    `;
  }

  $("modal-player").hidden = false;

  $("btn-edit-this-player")?.addEventListener("click", () => {
    $("modal-player").hidden = true;
    openPlayerEdit(playerUid);
  });
}

function renderFifaCard(player, playerUid, canEdit) {
  const photoContent = player.photoUrl
    ? `<img src="${escapeHtml(player.photoUrl)}" class="fifa-photo" />`
    : `<div class="fifa-photo fifa-photo--placeholder">${initials(player.name)}</div>`;

  return `
    <div class="fifa-card">
      <div class="fifa-top">
        <div class="fifa-top-left">
          ${player.squadNumber ? `<div class="fifa-number">${player.squadNumber}</div>` : ""}
          ${player.position ? `<div class="fifa-pos">${escapeHtml(player.position)}</div>` : ""}
        </div>
        <span class="fifa-team">${escapeHtml(teamMeta.name)}</span>
      </div>
      <div class="fifa-photo-wrap">${photoContent}</div>
      <div class="fifa-divider"></div>
      <div class="fifa-name">${escapeHtml(player.name).toUpperCase()}</div>
      ${player.nickname ? `<div class="fifa-nick">"${escapeHtml(player.nickname)}"</div>` : ""}
    </div>
    ${canEdit ? `<button id="btn-edit-this-player" class="btn btn-secondary" style="width:100%;margin-top:16px">Edit profile</button>` : ""}
  `;
}

function openPlayerEdit(playerUid) {
  editingPlayerUid = playerUid;
  const player = playersCache[playerUid];
  const isCoach = myMember.role === "coach";
  const parents = Object.entries(membersCache).filter(([_, m]) => m.childOf === playerUid);
  const myParentEntry = parents.find(([pUid]) => pUid === user.uid);

  $("pe-heading").textContent = `Edit — ${player.name}`;
  $("pe-number").value = player.squadNumber || "";
  $("pe-nickname").value = player.nickname || "";
  $("pe-position").value = player.position || "";

  if (player.photoUrl) {
    $("pe-photo-preview").src = player.photoUrl;
    $("pe-photo-preview").hidden = false;
    $("pe-photo-placeholder").textContent = "";
    $("pe-photo-placeholder").style.display = "none";
  } else {
    $("pe-photo-preview").hidden = true;
    $("pe-photo-placeholder").style.display = "";
    $("pe-photo-placeholder").textContent = initials(player.name);
  }

  $("pe-medical-wrap").hidden = !isCoach;
  if (isCoach) $("pe-medical").value = player.medicalNotes || "";

  $("pe-phone-wrap").hidden = !myParentEntry;
  if (myParentEntry) $("pe-phone").value = myParentEntry[1].phone || "";

  $("modal-player-edit").hidden = false;
}

async function savePlayerEdit() {
  const playerUid = editingPlayerUid;
  if (!playerUid) return;

  const btn = $("btn-save-player");
  btn.disabled = true;

  try {
    const isCoach = myMember.role === "coach";
    const parents = Object.entries(membersCache).filter(([_, m]) => m.childOf === playerUid);
    const myParentEntry = parents.find(([pUid]) => pUid === user.uid);
    const numVal = parseInt($("pe-number").value);
    const updates = {
      [`teams/${activeTeamId}/players/${playerUid}/squadNumber`]: (!isNaN(numVal) && numVal > 0) ? numVal : null,
      [`teams/${activeTeamId}/players/${playerUid}/nickname`]: $("pe-nickname").value.trim() || null,
      [`teams/${activeTeamId}/players/${playerUid}/position`]: $("pe-position").value.trim() || null,
    };
    if (isCoach) {
      updates[`teams/${activeTeamId}/players/${playerUid}/medicalNotes`] = $("pe-medical").value.trim() || null;
    }
    if (myParentEntry) {
      updates[`teams/${activeTeamId}/members/${user.uid}/phone`] = $("pe-phone").value.trim() || null;
    }
    await update(ref(db), updates);
    $("modal-player-edit").hidden = true;
    toast("Saved");
  } catch (err) {
    console.error("Save player failed:", err);
    toast("Couldn't save");
  } finally {
    btn.disabled = false;
  }
}

async function uploadPlayerPhoto(playerUid, file) {
  if (file.size > 5 * 1024 * 1024) { toast("Photo too large (max 5 MB)"); return; }
  toast("Uploading…");
  try {
    const path = `teams/${activeTeamId}/players/${playerUid}/photo`;
    const snap = await uploadBytes(storageRef(storage, path), file);
    const url = await getDownloadURL(snap.ref);
    await set(ref(db, `teams/${activeTeamId}/players/${playerUid}/photoUrl`), url);
    $("pe-photo-preview").src = url;
    $("pe-photo-preview").hidden = false;
    $("pe-photo-placeholder").style.display = "none";
    toast("Photo updated");
  } catch (err) {
    console.error("Photo upload failed:", err);
    toast("Couldn't upload photo");
  }
}

async function kickMember(uid, isPlayer) {
  try {
    const updates = {
      [`teams/${activeTeamId}/members/${uid}`]: null,
      [`users/${uid}/teams/${activeTeamId}`]: null,
    };
    if (isPlayer) updates[`teams/${activeTeamId}/players/${uid}`] = null;
    await update(ref(db), updates);
    toast("Removed");
  } catch (err) {
    console.error("Failed to remove member:", err);
    toast(`Error: ${err.code || err.message}`);
  }
}

function subscribeInvites() {
  const iRef = ref(db, `teams/${activeTeamId}/invites`);
  onValue(iRef, (snap) => {
    const invites = snap.val() || {};
    const active = Object.entries(invites)
      .filter(([_, i]) => !i.expiresAt || i.expiresAt > Date.now())
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
        <button class="icon-btn" data-revoke="${code}" title="Revoke" style="color:var(--red)">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="5" y1="5" x2="15" y2="15" /><line x1="15" y1="5" x2="5" y2="15" />
          </svg>
        </button>
      </div>
    `).join("") : '<div class="empty">No active invite codes.</div>';

    $("invites-list").querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.copy);
        toast(`Copied ${btn.dataset.copy}`);
      });
    });
    $("invites-list").querySelectorAll("[data-revoke]").forEach((btn) => {
      btn.addEventListener("click", () => revokeInvite(btn.dataset.revoke));
    });
  });
  subscriptions.push(iRef);
}

// =====================================================================
// League teams + home ground
// =====================================================================

function subscribeLeagueTeams() {
  const ltRef = ref(db, `teams/${activeTeamId}/leagueTeams`);
  onValue(ltRef, (snap) => {
    leagueTeamsCache = snap.val() || {};
    renderLeagueTeams();
  });
  subscriptions.push(ltRef);
}

function renderLeagueTeams() {
  const isCoach = myMember.role === "coach";
  const entries = Object.entries(leagueTeamsCache).sort((a, b) => a[1].name.localeCompare(b[1].name));
  $("league-teams-list").innerHTML = entries.length ? entries.map(([id, t]) => `
    <div class="member">
      <div class="member-text"><div class="member-name">${escapeHtml(t.name)}</div></div>
      ${isCoach ? `<button class="btn-remove" data-lt-id="${id}">Remove</button>` : ""}
    </div>
  `).join("") : '<div class="empty" style="padding:0 0 8px">No league opponents added yet.</div>';

  if (isCoach) {
    $("league-teams-list").querySelectorAll("[data-lt-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await remove(ref(db, `teams/${activeTeamId}/leagueTeams/${btn.dataset.ltId}`));
      });
    });
  }
}

async function onGenerateInvite(role) {
  const code = genCode();
  try {
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
  } catch (err) {
    console.error("Failed to save invite code:", err);
    toast(`Error: ${err.code || err.message}`);
  }
}

// =====================================================================
// Chat
// =====================================================================

let messagesCache = [];

function setupLightbox() {
  $("chat-messages").addEventListener("click", (e) => {
    if (e.target.classList.contains("chat-img")) {
      $("lightbox-img").src = e.target.src;
      $("modal-lightbox").hidden = false;
    }
  });
  $("modal-lightbox").addEventListener("click", () => {
    $("modal-lightbox").hidden = true;
    $("lightbox-img").src = "";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("modal-lightbox").hidden = true;
  });
}

function subscribeChat() {
  messagesCache = [];
  $("chat-messages").innerHTML = '<div class="empty">Loading…</div>';
  const cRef = query(ref(db, `teams/${activeTeamId}/messages`), limitToLast(100));
  const unsub = onChildAdded(cRef, (snap) => {
    messagesCache.push({ id: snap.key, ...snap.val() });
    renderChat(messagesCache);
  });
  subscriptions.push(unsub);
}

function renderChat(msgs) {
  const list = $("chat-messages");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (msgs.length === 0) {
    list.innerHTML = '<div class="empty">No messages yet.</div>';
    return;
  }
  list.innerHTML = msgs.map(renderMessage).join("");
  if (atBottom) list.scrollTop = list.scrollHeight;
  if (!$("tab-chat").hidden) {
    markRead();
  } else {
    updateChatBadge();
    renderAnnouncements();
  }
}

function getLastRead() {
  return parseInt(localStorage.getItem(`squad.chat.read.${activeTeamId}`) || "0");
}

function markRead() {
  localStorage.setItem(`squad.chat.read.${activeTeamId}`, Date.now());
  updateChatBadge();
  renderAnnouncements();
}

function updateChatBadge() {
  const lastRead = getLastRead();
  const unread = messagesCache.filter((m) => m.sentAt > lastRead).length;
  const badge = $("chat-tab-badge");
  if (unread > 0) {
    badge.textContent = unread > 99 ? "99+" : unread;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderAnnouncements() {
  const announcements = messagesCache.filter((m) => m.type === "announcement").slice(-5).reverse();
  if (announcements.length === 0) {
    $("announcements-feed").hidden = true;
    return;
  }
  const lastRead = getLastRead();
  $("announcements-feed").hidden = false;
  $("announcements-list").innerHTML = announcements.map((a) => {
    const isNew = a.sentAt > lastRead;
    const when = new Date(a.sentAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return `<div class="announcement-card">
      ${isNew ? '<span class="badge-new">New</span>' : ""}
      <div class="ann-text">${escapeHtml(a.text)}</div>
      <div class="ann-meta">${escapeHtml(a.name || "Coach")} · ${when}</div>
    </div>`;
  }).join("");
}

function renderMessage(m) {
  const isMe = m.uid === user.uid;
  const when = new Date(m.sentAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (m.type === "image") {
    return `
      <div class="chat-row ${isMe ? "me" : "them"}">
        ${!isMe ? `<div class="chat-sender">${escapeHtml(m.name || "?")}</div>` : ""}
        <div class="chat-bubble chat-bubble-img">
          <img src="${escapeHtml(m.imageUrl)}" class="chat-img" alt="image" loading="lazy" />
        </div>
        <div class="chat-time">${when}</div>
      </div>`;
  }
  if (m.type === "announcement") {
    return `
      <div class="chat-announcement">
        <div class="chat-ann-label">📣 ${escapeHtml(m.name || "Coach")}</div>
        <div class="chat-ann-text">${linkify(m.text)}</div>
        <div class="chat-time" style="opacity:0.7;margin-top:6px">${when}</div>
      </div>`;
  }
  return `
    <div class="chat-row ${isMe ? "me" : "them"}">
      ${!isMe ? `<div class="chat-sender">${escapeHtml(m.name || "?")}</div>` : ""}
      <div class="chat-bubble">${linkify(m.text)}</div>
      <div class="chat-time">${when}</div>
    </div>`;
}

async function sendChatImage(file) {
  const btn = $("btn-chat-photo");
  btn.disabled = true;
  toast("Uploading…");
  try {
    const path = `teams/${activeTeamId}/chat/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const snap = await uploadBytes(storageRef(storage, path), file);
    const url = await getDownloadURL(snap.ref);
    await push(ref(db, `teams/${activeTeamId}/messages`), {
      type: "image",
      imageUrl: url,
      uid: user.uid,
      name: user.name || "?",
      sentAt: Date.now(),
    });
  } catch (err) {
    console.error("Image upload failed:", err);
    toast("Couldn't send image");
  } finally {
    btn.disabled = false;
  }
}

async function sendChatMessage(type) {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  input.focus();
  try {
    await push(ref(db, `teams/${activeTeamId}/messages`), {
      text,
      uid: user.uid,
      name: user.name || "?",
      sentAt: Date.now(),
      type,
    });
  } catch (err) {
    console.error("Chat send failed:", err);
    toast("Couldn't send message");
    input.value = text;
  }
}

async function revokeInvite(code) {
  try {
    await update(ref(db), {
      [`teams/${activeTeamId}/invites/${code}`]: null,
      [`inviteIndex/${code}`]: null,
    });
    toast(`Code ${code} revoked`);
  } catch (err) {
    console.error("Failed to revoke invite:", err);
    toast(`Error: ${err.code || err.message}`);
  }
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

setupLocationAutocomplete();

if ("serviceWorker" in navigator) {
  if (location.hostname === "localhost") {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
  } else {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }
}
