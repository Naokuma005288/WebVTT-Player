// main.js — Perfect WebVTT renderer + custom controls
// IMPORTANT:
// - Video + subtitle overlay share the same "frame" rect (aspect-fit).
// - If you still see center drift (device/browser rendering quirks),
//   we apply a global subtitle offset (shift cues only, not the viewport).
//   This keeps clipping correct while visually aligning centers.

// ==========================
// Elements
// ==========================
const video = document.getElementById("video");
const player = document.getElementById("player");
const frame = document.getElementById("frame");
const subtitleViewport = document.getElementById("subtitleViewport");

const videoFile = document.getElementById("videoFile");
const vttFile = document.getElementById("vttFile");
const hint = document.getElementById("hint");

// custom controls
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

let captionsEnabled = true;

// cues: {index,id,start,end,settings,text,hasInline}
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
// ★見た目補正（ここだけいじればOK）
// 右下にズレるなら「左上へ」＝マイナスにする
// ==========================
const SUB_OFFSET_PX = { x: -80, y: -78 }; // ←ここ調整（例：-6,-4 / -10,-8 など）
const SUB_OFFSET_PC = { x: 0, y: 0 };   // 例: {x:-0.2, y:-0.15}（%補正したい時）

// ----------------------------
// Keep --topbar-h accurate
// ----------------------------
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
});

vttFile.addEventListener("change", async () => {
  const f = vttFile.files?.[0];
  if (!f) return;

  const text = await f.text();
  const parsed = parseWebVTT(text);

  cues = parsed.cues;
  vttStyleText = parsed.styleCss;
  styleEl.textContent = transformVttCssToOverlayCss(vttStyleText);

  lastSubKey = "";
  subtitleViewport.innerHTML = "";
  hint.style.display = "none";
});

video.addEventListener("loadedmetadata", () => {
  if (video.videoWidth && video.videoHeight) {
    videoAspect = video.videoWidth / video.videoHeight;
  }
  activeAspect = parseAspectValue(aspectSel.value);
  layoutFrame();
  syncDurationUI();
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
});

btnBack.addEventListener("click", () => { video.currentTime = Math.max(0, video.currentTime - 5); });

btnFwd.addEventListener("click", () => {
  const d = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(d, video.currentTime + 5);
});

btnMute.addEventListener("click", () => { video.muted = !video.muted; syncVolumeUI(); });

vol.addEventListener("input", () => {
  video.volume = Number(vol.value);
  video.muted = (video.volume === 0);
  syncVolumeUI();
});

speed.addEventListener("change", () => { video.playbackRate = Number(speed.value); });

btnFS.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    try { await player.requestFullscreen(); } catch {}
  } else {
    try { await document.exitFullscreen(); } catch {}
  }
});

btnCC.addEventListener("click", () => {
  captionsEnabled = !captionsEnabled;
  if (!captionsEnabled) subtitleViewport.innerHTML = "";
  lastSubKey = "";
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
});
seek.addEventListener("change", () => {
  const d = Number.isFinite(video.duration) ? video.duration : 0;
  const p = Number(seek.value) / 1000;
  video.currentTime = d * p;
  isSeeking = false;
});

// Click to toggle play (avoid HUD clicks)
player.addEventListener("click", (e) => {
  const el = e.target;
  if (el.closest(".hud") || el.closest(".topbar")) return;
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
// Cue settings
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
// Cue text tags + inline timestamps
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
// Subtitle rendering (★オフセット適用)
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

  // ★字幕をわざと左上へ（%補正も可）
  const ox = SUB_OFFSET_PX.x + (W * (SUB_OFFSET_PC.x / 100));
  const oy = SUB_OFFSET_PX.y + (H * (SUB_OFFSET_PC.y / 100));

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
    const content = vttToHtml(c.text, t);
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
// WebVTT position math (★ox/oyを加算)
// clampは「補正前」にだけ適用（補正で枠外に出てもOK＝見た目優先）
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

    // ★補正を最後に加算
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

  // vertical writing mode
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

  // ★補正
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
