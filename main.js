// main.js — Perfect WebVTT renderer + custom controls
// - Video + subtitle overlay share the same "frame" rect (aspect-fit).
// - Subtitle drift is compensated by a global offset (applied to cue positions).
// - Offset can be tuned via top-right subtitle settings panel (5px step) and persisted.
// - Bottom HUD auto-hides after 3 seconds of no interaction (when playing). Any interaction shows it.
// - .srt is supported in a simple way (no positioning/style directives).

// ==========================
// Elements
// ==========================
const video = document.getElementById("video");
const player = document.getElementById("player");
const frame = document.getElementById("frame");
const subtitleViewport = document.getElementById("subtitleViewport");

const videoFile = document.getElementById("videoFile");
const subFile = document.getElementById("vttFile");
const hint = document.getElementById("hint");

// HUD
const hud = document.getElementById("hud");
const btnPlay = document.getElementById("btnPlay");
const btnBack = document.getElementById("btnBack");
const btnFwd = document.getElementById("btnFwd");
const btnMute = document.getElementById("btnMute");
const btnFS = document.getElementById("btnFS");
const btnCC = document.getElementById("btnCC");
const seek = document.getElementById("seek");
const vol = document.getElementById("vol");
const speed = document.getElementById("speed");
const aspectSel = document.getElementById("aspect");
const curTime = document.getElementById("curTime");
const durTime = document.getElementById("durTime");

// Subtitle settings (top-right)
const btnSubSettings = document.getElementById("btnSubSettings");
const subPanel = document.getElementById("subPanel");
const btnSubClose = document.getElementById("btnSubClose");
const nudgeUp = document.getElementById("nudgeUp");
const nudgeLeft = document.getElementById("nudgeLeft");
const nudgeRight = document.getElementById("nudgeRight");
const nudgeDown = document.getElementById("nudgeDown");
const offXEl = document.getElementById("offX");
const offYEl = document.getElementById("offY");

let captionsEnabled = true;

// cues: {index,id,start,end,settings,text,hasInline,kind}
let cues = [];
let vttStyleText = "";

// injected style for VTT Style: CSS
const styleEl = document.createElement("style");
styleEl.id = "vtt-style-injected";
document.head.appendChild(styleEl);

// render cache
let lastSubKey = "";
let isSeeking = false;

// aspect handling
let videoAspect = 16 / 9;
let activeAspect = 16 / 9;

// ==========================
// Offset tuning (5px step) + persistence
// ==========================
const OFFSET_STEP = 5;
const OFFSET_STORAGE_KEY = "perfectVttOffset_v3";
const DEFAULT_OFFSET = { x: -80, y: -78 };
const SUB_OFFSET_PC = { x: 0, y: 0 };

let subOffset = loadOffset();

function loadOffset() {
  try {
    const raw = localStorage.getItem(OFFSET_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OFFSET };
    const obj = JSON.parse(raw);
    const x = Number(obj?.x);
    const y = Number(obj?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ...DEFAULT_OFFSET };
    return { x, y };
  } catch {
    return { ...DEFAULT_OFFSET };
  }
}
function saveOffset() {
  try { localStorage.setItem(OFFSET_STORAGE_KEY, JSON.stringify(subOffset)); } catch {}
}
function updateOffsetUI() {
  offXEl.textContent = String(Math.round(subOffset.x));
  offYEl.textContent = String(Math.round(subOffset.y));
}
function nudge(dx, dy) {
  subOffset.x += dx;
  subOffset.y += dy;
  updateOffsetUI();
  saveOffset();
  lastSubKey = "";
  renderSubtitles(video.currentTime || 0);
}
nudgeUp.addEventListener("click", () => nudge(0, -OFFSET_STEP));
nudgeDown.addEventListener("click", () => nudge(0, OFFSET_STEP));
nudgeLeft.addEventListener("click", () => nudge(-OFFSET_STEP, 0));
nudgeRight.addEventListener("click", () => nudge(OFFSET_STEP, 0));
updateOffsetUI();

// ==========================
// Subtitle settings panel toggle
// ==========================
let subPanelOpen = false;

function setSubPanelOpen(open) {
  subPanelOpen = open;
  btnSubSettings.classList.toggle("is-active", open);
  btnSubSettings.setAttribute("aria-expanded", String(open));

  subPanel.classList.toggle("is-hidden", !open);
  subPanel.setAttribute("aria-hidden", String(!open));
  // HUDも「触った扱い」で再表示
  userActivity();
}

btnSubSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  setSubPanelOpen(!subPanelOpen);
});

btnSubClose.addEventListener("click", (e) => {
  e.stopPropagation();
  setSubPanelOpen(false);
});

// 初期は閉じる
subPanel.classList.add("is-hidden");
subPanel.setAttribute("aria-hidden", "true");

// 外側クリックで閉じる（プレイヤー内）
player.addEventListener("pointerdown", (e) => {
  const t = e.target;
  if (!subPanelOpen) return;
  if (t.closest("#subPanel") || t.closest("#btnSubSettings")) return;
  setSubPanelOpen(false);
}, { capture: true });

// ==========================
// HUD auto-hide (3s idle)
// ==========================
const HUD_IDLE_MS = 3000;
let hudTimer = null;

function showHUD() {
  hud.classList.remove("hud-hidden");
}
function hideHUD() {
  if (video.paused) return; // paused中は消さない
  hud.classList.add("hud-hidden");
}
function scheduleHideHUD() {
  clearTimeout(hudTimer);
  if (video.paused) return; // paused中はタイマー不要
  hudTimer = setTimeout(() => hideHUD(), HUD_IDLE_MS);
}
function userActivity() {
  showHUD();
  scheduleHideHUD();
}

// 触れたらHUD復帰
// iOSでも効くように pointer/touch を広めに拾う
["pointermove", "pointerdown", "touchstart", "touchmove", "wheel"].forEach((ev) => {
  player.addEventListener(ev, userActivity, { passive: true });
});
document.addEventListener("keydown", userActivity, { passive: true });

// 再生状態に応じてHUD制御
video.addEventListener("play", () => { showHUD(); scheduleHideHUD(); });
video.addEventListener("pause", () => { showHUD(); clearTimeout(hudTimer); });
video.addEventListener("ended", () => { showHUD(); clearTimeout(hudTimer); });

// ==========================
// Keep --topbar-h accurate
// ==========================
const topbar = document.querySelector(".topbar");
function updateTopbarVar() {
  const h = topbar?.getBoundingClientRect().height || 64;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
}
updateTopbarVar();
new ResizeObserver(updateTopbarVar).observe(topbar);

// ==========================
// Frame layout (aspect-fit)
// ==========================
function parseAspectValue(v) {
  if (v === "auto") return videoAspect || (16 / 9);
  if (v === "16:9") return 16 / 9;
  if (v === "4:3") return 4 / 3;
  if (v === "1:1") return 1;
  return videoAspect || (16 / 9);
}

function layoutFrame() {
  const W = player.clientWidth || 0;
  const H = player.clientHeight || 0;
  if (!W || !H) return;

  const a = activeAspect || (16 / 9);

  let fw = W;
  let fh = fw / a;
  if (fh > H) {
    fh = H;
    fw = fh * a;
  }

  const dpr = window.devicePixelRatio || 1;
  fw = Math.round(fw * dpr) / dpr;
  fh = Math.round(fh * dpr) / dpr;

  frame.style.width = `${fw}px`;
  frame.style.height = `${fh}px`;

  lastSubKey = "";
}

aspectSel.addEventListener("change", () => {
  activeAspect = parseAspectValue(aspectSel.value);
  layoutFrame();
  lastSubKey = "";
});

new ResizeObserver(() => layoutFrame()).observe(player);
document.addEventListener("fullscreenchange", () => layoutFrame());

// ==========================
// File loading
// ==========================
videoFile.addEventListener("change", () => {
  const f = videoFile.files?.[0];
  if (!f) return;
  video.src = URL.createObjectURL(f);
  video.load();
  hint.style.display = "none";
  lastSubKey = "";
  userActivity();
});

subFile.addEventListener("change", async () => {
  const f = subFile.files?.[0];
  if (!f) return;

  const text = await f.text();
  const kind = detectSubtitleFormat(text, f.name);

  if (kind === "vtt") {
    const parsed = parseWebVTT(text);
    cues = parsed.cues;
    vttStyleText = parsed.styleCss;
    styleEl.textContent = transformVttCssToOverlayCss(vttStyleText);
  } else {
    cues = parseSRT(text);
    vttStyleText = "";
    styleEl.textContent = "";
  }

  lastSubKey = "";
  subtitleViewport.innerHTML = "";
  hint.style.display = "none";
  userActivity();
});

function detectSubtitleFormat(text, name = "") {
  const lower = name.toLowerCase();
  if (lower.endsWith(".vtt")) return "vtt";
  if (lower.endsWith(".srt")) return "srt";

  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  if (t.startsWith("WEBVTT")) return "vtt";

  const srtLike = /^\s*\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/m.test(t);
  const vttLike = /^\s*\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/m.test(t);

  if (vttLike) return "vtt";
  if (srtLike) return "srt";
  return "vtt";
}

video.addEventListener("loadedmetadata", () => {
  if (video.videoWidth && video.videoHeight) videoAspect = video.videoWidth / video.videoHeight;
  activeAspect = parseAspectValue(aspectSel.value);
  layoutFrame();
  syncDurationUI();
  userActivity();
});
video.addEventListener("loadeddata", () => layoutFrame());
video.addEventListener("playing", () => layoutFrame());

// ==========================
// Controls
// ==========================
btnPlay.addEventListener("click", async () => {
  if (!video.src) return;
  if (video.paused) {
    try { await video.play(); } catch {}
  } else {
    video.pause();
  }
  userActivity();
});

btnBack.addEventListener("click", () => { video.currentTime = Math.max(0, video.currentTime - 5); userActivity(); });
btnFwd.addEventListener("click", () => {
  const d = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(d, video.currentTime + 5);
  userActivity();
});

btnMute.addEventListener("click", () => { video.muted = !video.muted; syncVolumeUI(); userActivity(); });

vol.addEventListener("input", () => {
  video.volume = Number(vol.value);
  video.muted = (video.volume === 0);
  syncVolumeUI();
  userActivity();
});

speed.addEventListener("change", () => { video.playbackRate = Number(speed.value); userActivity(); });

btnFS.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    try { await player.requestFullscreen(); } catch {}
  } else {
    try { await document.exitFullscreen(); } catch {}
  }
  userActivity();
});

btnCC.addEventListener("click", () => {
  captionsEnabled = !captionsEnabled;
  if (!captionsEnabled) subtitleViewport.innerHTML = "";
  lastSubKey = "";
  userActivity();
});

video.addEventListener("play", syncPlayUI);
video.addEventListener("pause", syncPlayUI);
video.addEventListener("volumechange", syncVolumeUI);

function syncPlayUI(){ btnPlay.textContent = video.paused ? "▶" : "⏸"; }
function syncVolumeUI(){
  const muted = video.muted || video.volume === 0;
  btnMute.textContent = muted ? "🔇" : "🔊";
  vol.value = String(muted ? 0 : video.volume);
}
function syncDurationUI(){
  const d = Number.isFinite(video.duration) ? video.duration : 0;
  durTime.textContent = formatTime(d);
}
function formatTime(sec){
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
  return `${m}:${String(r).padStart(2,"0")}`;
}

// Seek bar
seek.addEventListener("input", () => {
  isSeeking = true;
  const d = Number.isFinite(video.duration) ? video.duration : 0;
  const p = Number(seek.value) / 1000;
  curTime.textContent = formatTime(d * p);
  userActivity();
});
seek.addEventListener("change", () => {
  const d = Number.isFinite(video.duration) ? video.duration : 0;
  const p = Number(seek.value) / 1000;
  video.currentTime = d * p;
  isSeeking = false;
  userActivity();
});

// Click to toggle play (avoid UI clicks)
player.addEventListener("click", (e) => {
  const el = e.target;
  if (
    el.closest(".hud") ||
    el.closest(".topbar") ||
    el.closest(".sub-ui") ||
    el.closest("#subPanel") ||
    el.closest("#btnSubSettings")
  ) return;

  // ただのクリックで再生/停止
  btnPlay.click();
});

// ==========================
// Frame synced loop
// ==========================
function startSync() {
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    const cb = () => { tick(); video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
  } else {
    const raf = () => { tick(); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }
}
startSync();

function tick() {
  if (video.src) {
    const t = video.currentTime || 0;
    if (!isSeeking) {
      curTime.textContent = formatTime(t);
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      seek.value = d > 0 ? String(Math.floor((t / d) * 1000)) : "0";
    }
  }
  if (captionsEnabled) renderSubtitles(video.currentTime);
}

// ==========================
// WebVTT parsing
// ==========================
function parseWebVTT(input) {
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");

  let i = 0;
  let styleCss = "";
  const cueList = [];
  let cueIndex = 0;

  if (lines[i]?.startsWith("WEBVTT")) i++;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    if (/^Style:\s*$/i.test(line.trim())) {
      i++;
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") break;
        buf.push(l);
        i++;
      }
      const block = buf.join("\n").trim();
      if (block) styleCss += (styleCss ? "\n" : "") + block;
      continue;
    }

    if (line.startsWith("NOTE")) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    if (line.startsWith("REGION")) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    let cueId = null;
    let tsLine = line;

    if (!isTimestampLine(tsLine)) {
      cueId = tsLine.trim();
      i++;
      tsLine = lines[i] ?? "";
    }

    if (!isTimestampLine(tsLine)) { i++; continue; }

    const { start, end, settings } = parseTimestampLine(tsLine);

    i++;
    const payload = [];
    while (i < lines.length && lines[i].trim() !== "") {
      payload.push(lines[i]);
      i++;
    }

    const rawText = payload.join("\n");
    const parsedSettings = parseCueSettings(settings);
    const hasInline = /<(\d{2}:)?\d{2}:\d{2}\.\d{3}>/.test(rawText);

    cueList.push({
      index: cueIndex++,
      id: cueId,
      start,
      end,
      settings: parsedSettings,
      text: rawText,
      hasInline,
      kind: "vtt",
    });

    i++;
  }

  cueList.sort((a, b) => (a.start - b.start) || (a.index - b.index));
  return { styleCss, cues: cueList };
}

function isTimestampLine(line) {
  return /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(line);
}

function parseTimestampLine(line) {
  const m = line.match(
    /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})(.*)$/
  );
  if (!m) return { start: 0, end: 0, settings: "" };
  return {
    start: parseVttTime(m[1]),
    end: parseVttTime(m[2]),
    settings: (m[3] || "").trim(),
  };
}

function parseVttTime(t) {
  const [hh, mm, ss] = t.split(":");
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

// ==========================
// SRT parsing (simple)
// ==========================
function parseSRT(input) {
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return [];

  const blocks = text.split(/\n{2,}/);
  const out = [];
  let idx = 0;

  for (const b of blocks) {
    const lines = b.split("\n").map(l => l.trimEnd());
    if (!lines.length) continue;

    let p = 0;
    if (/^\d+$/.test(lines[p]?.trim() || "")) p++;

    const timeLine = lines[p] || "";
    const m = timeLine.match(
      /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!m) continue;

    const start = parseSrtTime(m[1]);
    const end = parseSrtTime(m[2]);

    p++;
    const payload = lines.slice(p).join("\n").trim();
    if (!payload) continue;

    out.push({
      index: idx++,
      id: null,
      start,
      end,
      settings: {
        vertical: null,
        line: "auto",
        lineAlign: "start",
        position: "auto",
        positionAlign: "auto",
        size: 100,
        align: "center",
        hasSize: false,
      },
      text: payload,
      hasInline: false,
      kind: "srt",
    });
  }

  out.sort((a, b) => (a.start - b.start) || (a.index - b.index));
  return out;
}

function parseSrtTime(t) {
  const m = t.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number(m[4]);
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

// ==========================
// Cue settings (VTT)
// ==========================
function parseCueSettings(settingsStr) {
  const out = {
    vertical: null,
    line: "auto",
    lineAlign: "start",
    position: "auto",
    positionAlign: "auto",
    size: 100,
    align: "center",
    hasSize: false,
  };
  if (!settingsStr) return out;

  const parts = settingsStr.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const [k, vRaw] = p.split(":");
    if (!k || vRaw == null) continue;

    const key = k.trim();
    const v = vRaw.trim();

    if (key === "vertical") {
      if (v === "rl" || v === "lr") out.vertical = v;
    } else if (key === "line") {
      const [val, align] = v.split(",");
      out.line = val;
      if (align) out.lineAlign = normalizeAlignToken(align);
    } else if (key === "position") {
      const [val, palign] = v.split(",");
      out.position = val;
      if (palign) out.positionAlign = normalizeAlignToken(palign);
    } else if (key === "size") {
      out.hasSize = true;
      const n = parsePercent(v);
      if (Number.isFinite(n)) out.size = clamp(n, 0, 100);
    } else if (key === "align") {
      out.align = v;
    }
  }
  return out;
}

function normalizeAlignToken(tok) {
  const t = String(tok).trim().toLowerCase();
  if (t === "line-left") return "start";
  if (t === "line-right") return "end";
  if (t === "start" || t === "center" || t === "end") return t;
  return "auto";
}

function parsePercent(v) {
  const m = String(v).match(/^(-?\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : NaN;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ==========================
// Style: ::cue CSS => overlay CSS
// ==========================
function transformVttCssToOverlayCss(vttCss) {
  if (!vttCss) return "";
  let css = vttCss;

  css = css.replace(/::cue\s*\(\s*c\.([^)]+?)\s*\)/g, (_, clsPart) => {
    const classes = clsPart
      .split(".")
      .filter(Boolean)
      .map((c) => `.c-${escapeCssIdent(c)}`)
      .join("");
    return `.cue-box ${classes}`.trim();
  });

  css = css.replace(/::cue\s*\(\s*v\[voice="([^"]+)"\]\s*\)/g, (_, voice) => {
    return `.cue-box .v-voice[data-voice="${voice.replaceAll('"', '\\"')}"]`;
  });

  css = css.replace(/::cue\b/g, ".cue-box");
  return css;
}

function escapeCssIdent(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ==========================
// Text handling
// ==========================
function decodeEntities(str) {
  const ta = document.createElement("textarea");
  ta.innerHTML = str;
  return ta.value;
}

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function applyInlineTimestamps(raw, tNow) {
  const re = /<(\d{2}:)?\d{2}:\d{2}\.\d{3}>/g;
  if (!re.test(raw)) return raw;
  re.lastIndex = 0;

  let out = "";
  let last = 0;
  let allow = true;

  for (const m of raw.matchAll(re)) {
    const idx = m.index;
    const tag = m[0];
    if (allow) out += raw.slice(last, idx);
    const sec = parseInlineTimestampToSeconds(tag.slice(1, -1));
    allow = tNow >= sec;
    last = idx + tag.length;
  }
  if (allow) out += raw.slice(last);
  return out;
}

function parseInlineTimestampToSeconds(ts) {
  const parts = ts.split(":");
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    h = Number(parts[0]); m = Number(parts[1]); s = Number(parts[2]);
  } else {
    m = Number(parts[0]); s = Number(parts[1]);
  }
  return h * 3600 + m * 60 + s;
}

function vttToHtml(rawText, tNow) {
  const text = applyInlineTimestamps(rawText, tNow);

  const allowed = new Set(["b", "i", "u", "c", "v", "lang", "ruby", "rt"]);
  const tagRe = /<\/?[^>]+>/g;

  let out = "";
  let last = 0;
  const stack = [];

  const flushText = (s) => {
    const decoded = decodeEntities(s);
    out += escapeHtml(decoded);
  };

  for (const m of text.matchAll(tagRe)) {
    const idx = m.index;
    const tag = m[0];

    flushText(text.slice(last, idx));
    last = idx + tag.length;

    if (tag.startsWith("</")) {
      const name = tag.slice(2, -1).trim().toLowerCase();
      if (!allowed.has(name)) { flushText(tag); continue; }
      while (stack.length) {
        const top = stack.pop();
        out += closeHtmlFor(top);
        if (top.name === name) break;
      }
      continue;
    }

    const inside = tag.slice(1, -1).trim();
    const head = (inside.split(/\s+/)[0] || "").trim();
    const name = (head.split(".")[0] || "").toLowerCase();

    if (!allowed.has(name)) { flushText(tag); continue; }

    const node = parseStartTag(inside);
    out += openHtmlFor(node);
    stack.push(node);
  }

  flushText(text.slice(last));
  while (stack.length) out += closeHtmlFor(stack.pop());
  return out.replace(/\n/g, "<br>");
}

function srtToHtml(rawText) {
  const allowed = new Set(["b", "i", "u"]);
  const tagRe = /<\/?[^>]+>/g;

  let out = "";
  let last = 0;
  const stack = [];

  const flushText = (s) => { out += escapeHtml(s); };

  for (const m of rawText.matchAll(tagRe)) {
    const idx = m.index;
    const tag = m[0];

    flushText(rawText.slice(last, idx));
    last = idx + tag.length;

    if (tag.startsWith("</")) {
      const name = tag.slice(2, -1).trim().toLowerCase();
      if (!allowed.has(name)) { flushText(tag); continue; }
      while (stack.length) {
        const top = stack.pop();
        out += `</${top.name}>`;
        if (top.name === name) break;
      }
      continue;
    }

    const inside = tag.slice(1, -1).trim().toLowerCase();
    const name = (inside.split(/\s+/)[0] || "").trim();
    if (!allowed.has(name)) { flushText(tag); continue; }

    out += `<${name}>`;
    stack.push({ name });
  }

  flushText(rawText.slice(last));
  while (stack.length) out += `</${stack.pop().name}>`;
  return out.replace(/\n/g, "<br>");
}

function parseStartTag(inside) {
  const parts = inside.split(/\s+/);
  const head = parts[0] || "";
  const name = (head.split(".")[0] || "").toLowerCase();

  if (name === "c") {
    const classes = head.split(".").slice(1).filter(Boolean).map((c) => `c-${c}`);
    return { name, classes };
  }
  if (name === "v") {
    const voice = inside.slice(1).trim();
    return { name, voice };
  }
  if (name === "lang") {
    const lang = parts[1] ? parts[1].trim() : "";
    return { name, lang };
  }
  return { name };
}

function openHtmlFor(node) {
  switch (node.name) {
    case "b": return "<b>";
    case "i": return "<i>";
    case "u": return "<u>";
    case "ruby": return "<ruby>";
    case "rt": return "<rt>";
    case "lang": return `<span lang="${escapeHtml(node.lang || "")}">`;
    case "v": return `<span class="v-voice" data-voice="${escapeHtml(node.voice || "")}">`;
    case "c": return `<span class="${(node.classes || []).map(escapeHtml).join(" ")}">`;
    default: return "";
  }
}
function closeHtmlFor(node) {
  switch (node.name) {
    case "b": return "</b>";
    case "i": return "</i>";
    case "u": return "</u>";
    case "ruby": return "</ruby>";
    case "rt": return "</rt>";
    case "lang":
    case "v":
    case "c": return "</span>";
    default: return "";
  }
}

// ==========================
// Subtitle rendering
// ==========================
function renderSubtitles(t) {
  if (!cues.length || !Number.isFinite(t)) {
    if (subtitleViewport.innerHTML) subtitleViewport.innerHTML = "";
    lastSubKey = "";
    return;
  }

  const W = frame.clientWidth || 0;
  const H = frame.clientHeight || 0;
  if (!W || !H) return;

  const ox = subOffset.x + (W * (SUB_OFFSET_PC.x / 100));
  const oy = subOffset.y + (H * (SUB_OFFSET_PC.y / 100));

  const active = getActiveCues(t);
  if (!active.length) {
    if (subtitleViewport.innerHTML) subtitleViewport.innerHTML = "";
    lastSubKey = "";
    return;
  }

  const needsTimeKey = active.some((c) => c.hasInline);
  const cueKey = active.map((c) => c.index).join(",");
  const key = needsTimeKey ? `${cueKey}|${t.toFixed(3)}` : cueKey;
  if (key === lastSubKey) return;
  lastSubKey = key;

  subtitleViewport.innerHTML = active.map((c) => {
    const box = computeBoxStyle(c.settings, W, H, ox, oy);
    const content = (c.kind === "srt") ? srtToHtml(c.text) : vttToHtml(c.text, t);
    const extraClass = c.settings.hasSize ? "" : " cue-default-font";

    return `
      <div class="cue-box${extraClass}"
        style="
          left:${box.left};
          top:${box.top};
          width:${box.width};
          ${box.height !== "auto" ? `height:${box.height};` : ""}
          text-align:${box.textAlign};
          writing-mode:${box.writingMode};
          transform:${box.transform};
        ">
        ${content}
      </div>
    `;
  }).join("");
}

function getActiveCues(t) {
  let lo = 0, hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const pivot = lo;

  const out = [];
  for (let i = pivot; i < cues.length; i++) {
    const c = cues[i];
    if (c.start > t) break;
    if (c.end > t) out.push(c);
  }
  for (let i = pivot - 1; i >= 0; i--) {
    const c = cues[i];
    if (c.start > t) continue;
    if (c.end <= t) break;
    out.push(c);
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

// ==========================
// WebVTT position math (ox/oy added at the end)
// ==========================
function percentOrDefault(v, dflt) {
  if (v == null || v === "auto") return dflt;
  const p = parsePercent(String(v).trim());
  return Number.isFinite(p) ? p : dflt;
}

function resolvePositionAlign(s) {
  let a = s.positionAlign && s.positionAlign !== "auto" ? s.positionAlign : "auto";
  if (a !== "auto") return a;

  const align = (s.align || "center").toLowerCase();
  if (align === "start" || align === "left") return "start";
  if (align === "end" || align === "right") return "end";
  return "center";
}

function resolveLineAlign(s) {
  const la = (s.lineAlign || "start").toLowerCase();
  if (la === "center" || la === "end" || la === "start") return la;
  return "start";
}

function computeBoxStyle(s, W, H, ox, oy) {
  const vertical = s.vertical === "rl" || s.vertical === "lr";
  const writingMode = vertical ? (s.vertical === "rl" ? "vertical-rl" : "vertical-lr") : "horizontal-tb";

  const sizePct = clamp(Number.isFinite(s.size) ? s.size : 100, 0, 100);
  const posPct = clamp(percentOrDefault(s.position, 50), 0, 100);

  const align = (s.align || "center").toLowerCase();
  let textAlign = "center";
  if (align === "start" || align === "left") textAlign = "left";
  if (align === "end" || align === "right") textAlign = "right";

  const positionAlign = resolvePositionAlign(s);
  const lineAlign = resolveLineAlign(s);

  if (!vertical) {
    const regionW = (W * sizePct) / 100;
    const x = (W * posPct) / 100;

    let anchorX = 0;
    if (positionAlign === "center") anchorX = regionW / 2;
    if (positionAlign === "end") anchorX = regionW;

    let leftPx = x - anchorX;
    leftPx = clamp(leftPx, 0, Math.max(0, W - regionW));

    let yPx = H;
    let translateY = "-100%";

    const line = s.line;
    if (typeof line === "string" && line.trim().endsWith("%")) {
      const lp = clamp(parsePercent(line.trim()), 0, 100);
      yPx = (H * lp) / 100;
      translateY = lineAlign === "center" ? "-50%" : (lineAlign === "end" ? "-100%" : "0%");
    } else if (line === "auto" || line == null) {
      yPx = H;
      translateY = "-100%";
    } else {
      const n = Number(line);
      const lineH = Math.max(18, H * 0.055);
      if (Number.isFinite(n)) {
        yPx = (n >= 0) ? (n * lineH) : (H + n * lineH);
        yPx = clamp(yPx, 0, H);
        translateY = lineAlign === "center" ? "-50%" : (lineAlign === "end" ? "-100%" : "0%");
      }
    }

    leftPx += ox;
    yPx += oy;

    return {
      left: `${leftPx.toFixed(3)}px`,
      top: `${yPx.toFixed(3)}px`,
      width: `${regionW.toFixed(3)}px`,
      height: "auto",
      transform: `translateY(${translateY})`,
      textAlign,
      writingMode,
    };
  }

  const regionH = (H * sizePct) / 100;
  const y = (H * posPct) / 100;

  let anchorY = 0;
  if (positionAlign === "center") anchorY = regionH / 2;
  if (positionAlign === "end") anchorY = regionH;

  let topPx = y - anchorY;
  topPx = clamp(topPx, 0, Math.max(0, H - regionH));

  let xPx = W;
  let translateX = "-100%";
  const line = s.line;

  if (typeof line === "string" && line.trim().endsWith("%")) {
    const lp = clamp(parsePercent(line.trim()), 0, 100);
    xPx = (W * lp) / 100;
    translateX = lineAlign === "center" ? "-50%" : (lineAlign === "end" ? "-100%" : "0%");
  } else if (line === "auto" || line == null) {
    xPx = W;
    translateX = "-100%";
  } else {
    const n = Number(line);
    const colW = Math.max(18, W * 0.055);
    if (Number.isFinite(n)) {
      xPx = (n >= 0) ? (n * colW) : (W + n * colW);
      xPx = clamp(xPx, 0, W);
      translateX = lineAlign === "center" ? "-50%" : (lineAlign === "end" ? "-100%" : "0%");
    }
  }

  xPx += ox;
  topPx += oy;

  return {
    left: `${xPx.toFixed(3)}px`,
    top: `${topPx.toFixed(3)}px`,
    width: "auto",
    height: `${regionH.toFixed(3)}px`,
    transform: `translateX(${translateX})`,
    textAlign,
    writingMode,
  };
}
