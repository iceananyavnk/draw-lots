/**
 * The list panel, one self-contained HTML document for command:webview:create. Plain DOM,
 * no framework. It renders whatever state the driver posts and sends user intents back;
 * the driver owns the list, ids, limits and the wheel. `:root{ /*__THEME__* / }` is filled
 * with the --dd-* tokens on creation and replaced on theme changes.
 */
export const PANEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style id="theme">:root{/*__THEME__*/}</style>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
    background: var(--dd-surface-panel, #fff);
    color: var(--dd-text-primary, rgba(0,0,0,.95));
    font-family: var(--dd-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--dd-type-body-size, 12px);
    line-height: var(--dd-type-body-line, 18px);
}
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--dd-focus-ring, #888); outline-offset: 2px; }
svg { display: block; }
[hidden] { display: none !important; }

.panel { height: 100%; padding: var(--dd-space-16, 16px); display: flex; flex-direction: column; gap: var(--dd-space-12, 12px); }
.head { display: flex; justify-content: space-between; align-items: baseline; }
.head h1 {
    margin: 0;
    font-size: var(--dd-type-heading-size, 14px);
    line-height: var(--dd-type-heading-line, 20px);
    font-weight: var(--dd-type-heading-weight, 600);
}
.headR { display: flex; align-items: center; gap: var(--dd-space-6, 6px); }
.iconbtn { width: 28px; height: 28px; border: 0; border-radius: var(--dd-radius-md, 6px); background: transparent; color: var(--dd-text-secondary, rgba(0,0,0,.7)); display: grid; place-items: center; cursor: pointer; padding: 0; }
.iconbtn:hover { background: var(--dd-interaction-hover, rgba(0,0,0,.04)); color: var(--dd-text-primary, rgba(0,0,0,.95)); }
.iconbtn svg { width: 16px; height: 16px; }
.iconbtn[aria-pressed="true"] .off, .iconbtn[aria-pressed="false"] .on { display: none; }
.iconbtn[aria-pressed="false"] { color: var(--dd-text-tertiary, rgba(0,0,0,.5)); }
.count { font-size: var(--dd-type-caption-size, 11px); line-height: var(--dd-type-caption-line, 16px); color: var(--dd-text-tertiary, rgba(0,0,0,.5)); font-variant-numeric: tabular-nums; }

.input {
    height: var(--dd-control-md, 36px);
    width: 100%;
    padding: 0 var(--dd-space-12, 12px);
    border-radius: var(--dd-radius-lg, 8px);
    background: var(--dd-surface-section, #f4f4f5);
    border: 1px solid var(--dd-border-subtle, rgba(0,0,0,.1));
}
.input::placeholder { color: var(--dd-text-tertiary, rgba(0,0,0,.5)); }
.input:focus { outline: none; border-color: var(--dd-focus-ring, #888); box-shadow: 0 0 0 1px var(--dd-focus-ring, #888); }
.input:disabled { color: var(--dd-text-disabled, rgba(0,0,0,.3)); cursor: not-allowed; }
.hint { margin: 0; font-size: var(--dd-type-caption-size, 11px); line-height: var(--dd-type-caption-line, 16px); color: var(--dd-text-tertiary, rgba(0,0,0,.5)); }

.picks { display: flex; align-items: center; }
.switch { display: inline-flex; align-items: center; gap: var(--dd-space-8, 8px); border: 0; background: none; padding: 2px; border-radius: var(--dd-radius-sm, 4px); cursor: pointer;
    font-size: var(--dd-type-label-size, 12px); line-height: var(--dd-type-label-line, 16px); font-weight: var(--dd-type-label-weight, 500); color: var(--dd-text-secondary, rgba(0,0,0,.7)); }
.switch .track { position: relative; width: 28px; height: 16px; border-radius: var(--dd-radius-full, 999px); background: var(--dl-switch-off, #71717A); flex: none; transition: background 120ms; }
.switch .thumb { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #FFFFFF; border: 1px solid rgba(0,0,0,0.2); transition: transform 120ms; }
.switch[aria-checked="true"] .track { background: var(--dd-accent, #C5F601); }
.switch[aria-checked="true"] .thumb { transform: translateX(12px); }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; flex: 1; min-height: 80px; }
.list li { display: flex; align-items: center; gap: var(--dd-space-6, 6px); padding: var(--dd-space-4, 4px); border-radius: var(--dd-radius-md, 6px); }
.list li:hover { background: var(--dd-interaction-hover, rgba(0,0,0,.04)); }
.mark { width: 16px; height: 16px; flex: none; color: var(--dd-text-tertiary, rgba(0,0,0,.5)); }
.nm { flex: 1; min-width: 0; overflow-wrap: anywhere; text-align: left; border: 0; background: transparent; padding: var(--dd-space-4, 4px) var(--dd-space-6, 6px);
    border-radius: var(--dd-radius-sm, 4px); cursor: text; }
.nm:hover { box-shadow: inset 0 0 0 1px var(--dd-border-subtle, rgba(0,0,0,.1)); }
li.picked .nm { color: var(--dd-text-tertiary, rgba(0,0,0,.5)); }
.nmedit { flex: 1; min-width: 0; height: 28px; padding: 0 var(--dd-space-6, 6px); border-radius: var(--dd-radius-sm, 4px); background: var(--dd-surface-section, #f4f4f5);
    border: 1px solid var(--dd-focus-ring, #888); box-shadow: 0 0 0 1px var(--dd-focus-ring, #888); outline: none; }
.x { width: 22px; height: 22px; flex: none; border: 0; border-radius: var(--dd-radius-sm, 4px); background: transparent; color: var(--dd-text-tertiary, rgba(0,0,0,.5)); cursor: pointer; opacity: 0; padding: 0; }
.x svg { width: 14px; height: 14px; margin: auto; }
.list li:hover .x, .list li:focus-within .x, .x:focus-visible { opacity: 1; }
.x:hover { background: var(--dd-interaction-hover, rgba(0,0,0,.04)); color: var(--dd-text-primary, rgba(0,0,0,.95)); }
@media (hover: none) { .x { opacity: 1; } }
.empty { color: var(--dd-text-tertiary, rgba(0,0,0,.5)); padding: var(--dd-space-8, 8px) var(--dd-space-4, 4px); }

.listfoot { display: flex; justify-content: flex-end; align-items: center; gap: var(--dd-space-6, 6px); }
.vdivider { width: 1px; height: 12px; background: var(--dd-divider-strong, rgba(0,0,0,.12)); }
.textbtn { border: 0; background: none; color: var(--dd-text-tertiary, rgba(0,0,0,.5)); cursor: pointer; padding: 2px var(--dd-space-4, 4px); border-radius: var(--dd-radius-sm, 4px);
    font-size: var(--dd-type-label-size, 12px); line-height: var(--dd-type-label-line, 16px); font-weight: var(--dd-type-label-weight, 500); }
.textbtn:hover { color: var(--dd-text-primary, rgba(0,0,0,.95)); background: var(--dd-interaction-hover, rgba(0,0,0,.04)); }
.textbtn.confirm { color: var(--dd-status-danger, #e5484d); }

.foot { border-top: 1px solid var(--dd-divider, rgba(0,0,0,.06)); padding-top: var(--dd-space-12, 12px); display: flex; flex-direction: column; gap: var(--dd-space-8, 8px); }
.status { display: flex; align-items: center; gap: var(--dd-space-6, 6px); color: var(--dd-text-tertiary, rgba(0,0,0,.5)); }
.status .d { width: 6px; height: 6px; border-radius: 50%; background: var(--dd-status-success, #53C683); }
.status.busy .d { background: var(--dd-text-tertiary, rgba(0,0,0,.5)); animation: blink 800ms infinite; }
@keyframes blink { 50% { opacity: .3; } }
.primary { height: var(--dd-control-md, 36px); width: 100%; border: 0; border-radius: var(--dd-radius-lg, 8px); background: var(--dd-accent, #C5F601); color: var(--dd-on-accent, #090909);
    font-size: var(--dd-type-label-size, 12px); font-weight: var(--dd-type-label-weight, 500); cursor: pointer; }
.primary:hover { background: var(--dd-accent-hover, #D4FF2E); }
.primary:active { background: var(--dd-accent-pressed, #B3E000); }
.primary:disabled { background: var(--dd-interaction-disabled, rgba(0,0,0,.06)); color: var(--dd-text-disabled, rgba(0,0,0,.3)); cursor: not-allowed; }
.notice { margin: 0; padding: var(--dd-space-8, 8px); border-radius: var(--dd-radius-md, 6px); background: var(--dd-status-warning-subtle, var(--dd-surface-section, #f4f4f5)); color: var(--dd-text-primary, rgba(0,0,0,.95)); }
@media (prefers-reduced-motion: reduce) { .status.busy .d { animation: none; } .switch .track, .switch .thumb { transition: none; } }
</style>
</head>
<body>
<main class="panel" aria-label="Draw Lots">
    <div class="head">
        <h1 id="title">New wheel</h1>
        <div class="headR">
            <span class="count" id="count"></span>
            <button class="iconbtn" id="soundBtn" aria-pressed="true" title="Mute sounds" aria-label="Mute sounds">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 6.2C3.9 6.1 4.9 6.1 5.8 6L8.9 3.3C9.1 3.1 9.4 3.3 9.4 3.6 9.5 6.5 9.5 9.6 9.4 12.4 9.4 12.7 9.1 12.9 8.9 12.7L5.8 10C4.8 9.9 3.8 9.9 2.8 9.8 2.5 9.8 2.4 9.6 2.4 9.3 2.3 8.4 2.4 7.4 2.4 6.6 2.4 6.4 2.6 6.2 2.8 6.2z"/><path class="on" d="M11.3 6.1c.6.6.9 1.2.9 1.9 0 .7-.3 1.3-.8 1.9M12.9 4.4c1 1 1.5 2.2 1.5 3.6 0 1.4-.6 2.6-1.5 3.6"/><path class="off" d="M11.4 6.3c1 1 2 2.1 2.9 3.2M14.2 6.2c-1 1.1-1.9 2.2-2.9 3.4"/></svg>
            </button>
        </div>
    </div>
    <p class="notice" id="notice" role="alert" hidden></p>
    <div id="editor">
        <input class="input" id="nameInput" type="text" placeholder="Add a name or option" maxlength="60" autocomplete="off" aria-label="Add a name or option" />
    </div>
    <p class="hint" id="limitHint" hidden>Up to 20 items</p>
    <div class="picks" id="picks" hidden>
        <button class="switch" id="removePicked" role="switch" aria-checked="true"><span class="track"><span class="thumb"></span></span>Remove picked names</button>
    </div>
    <ul class="list" id="list" aria-label="Items"></ul>
    <div class="listfoot" id="listFoot">
        <button class="textbtn" id="resetPicked" hidden>Reset picks</button>
        <span class="vdivider" id="resetDivider" aria-hidden="true" hidden></span>
        <button class="textbtn" id="clearAll">Clear all</button>
    </div>
    <div class="foot" id="foot">
        <div class="status" id="status" role="status" aria-live="polite"><span class="d"></span><span id="statusText">Wheel is up to date</span></div>
        <button class="primary" id="addWheel">Add wheel to board</button>
    </div>
</main>
<script>
(function () {
    var api = acquireDrawdyApi();
    var X_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4.6 4.4C7 6.6 9.2 9 11.5 11.6M11.3 4.5C9 6.7 6.8 9.1 4.5 11.5"/></svg>';
    var CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.3 8.6C4.5 9.6 5.5 10.7 6.4 11.9 8.1 9 10.3 6.2 12.9 3.8"/></svg>';
    var $ = function (id) { return document.getElementById(id); };
    var input = $("nameInput"), list = $("list");

    var state = null;
    var pending = null;
    var editing = null;
    var clearTimer = null;

    function send(msg) { api.postMessage(msg); }

    function focusKey() {
        var el = document.activeElement;
        return el && el.getAttribute ? el.getAttribute("data-key") : null;
    }

    function restoreFocus(key) {
        if (!key) return;
        var el = document.querySelector('[data-key="' + key + '"]');
        if (el && !el.disabled) el.focus();
        else if (!input.disabled) input.focus();
    }

    function render() {
        if (!state) return;
        var key = focusKey();
        var edit = state.mode === "edit";
        var items = state.items, picked = {};
        (state.picked || []).forEach(function (id) { picked[id] = true; });

        $("title").textContent = edit ? "Editing wheel" : "New wheel";
        $("count").textContent = items.length === 0 ? "" : items.length + (items.length === 1 ? " item" : " items");

        var full = items.length >= state.max;
        input.disabled = full;
        $("limitHint").hidden = !full;

        $("picks").hidden = !edit;
        $("removePicked").setAttribute("aria-checked", String(!!state.removePicked));
        var anyPicked = edit && state.picked && state.picked.length > 0;
        $("resetPicked").hidden = !anyPicked;
        $("resetDivider").hidden = !anyPicked;

        list.innerHTML = "";
        items.forEach(function (it) {
            var li = document.createElement("li");
            var isPicked = edit && picked[it.id];
            if (isPicked) li.className = "picked";
            var mark = document.createElement("span");
            mark.className = "mark";
            if (isPicked) { mark.innerHTML = CHECK_ICON; mark.title = "Picked"; }
            var nm = document.createElement("button");
            nm.className = "nm";
            nm.textContent = it.name;
            nm.title = "Click to edit";
            nm.setAttribute("aria-label", "Edit " + it.name + (isPicked ? ", picked" : ""));
            nm.setAttribute("data-key", "nm-" + it.id);
            nm.onclick = function () { startEdit(nm, it); };
            var x = document.createElement("button");
            x.className = "x";
            x.innerHTML = X_ICON;
            x.title = "Remove";
            x.setAttribute("aria-label", "Remove " + it.name);
            x.setAttribute("data-key", "x-" + it.id);
            x.onclick = function () { removeItem(it.id); };
            li.appendChild(mark); li.appendChild(nm); li.appendChild(x);
            list.appendChild(li);
        });
        if (items.length === 0) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = "Add names or options to spin.";
            list.appendChild(empty);
        }
        $("listFoot").hidden = items.length === 0;

        $("status").hidden = !edit;
        $("status").classList.toggle("busy", state.status === "pending");
        $("statusText").textContent = state.status === "pending" ? "Updating wheel\\u2026" : "Wheel is up to date";
        $("addWheel").hidden = state.mode !== "draft";
        $("addWheel").disabled = items.length < 2;

        $("notice").hidden = !state.notice;
        $("notice").textContent = state.notice || "";
        restoreFocus(key);
    }

    function removeItem(id) {
        var items = state.items, i = items.findIndex(function (it) { return it.id === id; });
        var next = items[i + 1] || items[i - 1];
        send({ type: "remove", id: id });
        // Keep keyboard focus in the list: move it to the neighbour's remove button.
        if (next) { var nextKey = "x-" + next.id; setTimeout(function () { restoreFocus(nextKey); }, 0); }
        else input.focus();
    }

    function startEdit(button, it) {
        var field = document.createElement("input");
        field.className = "nmedit";
        field.value = it.name;
        field.maxLength = 60;
        field.setAttribute("aria-label", "Edit " + it.name);
        button.replaceWith(field);
        field.focus();
        field.select();
        editing = it.id;
        var done = false;
        function finish(save) {
            if (done) return;
            done = true;
            editing = null;
            var value = field.value.trim();
            if (save && value && value !== it.name) send({ type: "rename", id: it.id, name: value });
            if (pending) { state = pending; pending = null; }
            render();
            restoreFocus("nm-" + it.id);
        }
        field.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        field.addEventListener("blur", function () { finish(true); });
    }

    function addNames(names) {
        var clean = names.map(function (n) { return n.trim(); }).filter(function (n) { return n.length > 0; });
        if (clean.length > 0) send({ type: "add", names: clean });
    }

    input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            addNames([input.value]);
            input.value = "";
        }
    });
    input.addEventListener("paste", function (e) {
        var text = (e.clipboardData || window.clipboardData).getData("text");
        if (/\\r?\\n/.test(text)) {
            e.preventDefault();
            addNames(text.split(/\\r?\\n/));
            input.value = "";
        }
    });

    $("clearAll").addEventListener("click", function () {
        var b = $("clearAll");
        if (clearTimer) {
            clearTimeout(clearTimer);
            clearTimer = null;
            b.textContent = "Clear all";
            b.classList.remove("confirm");
            send({ type: "clear" });
            input.focus();
            return;
        }
        b.textContent = "Clear all?";
        b.classList.add("confirm");
        clearTimer = setTimeout(function () {
            clearTimer = null;
            b.textContent = "Clear all";
            b.classList.remove("confirm");
        }, 3000);
    });
    $("removePicked").addEventListener("click", function () {
        send({ type: "setRemovePicked", value: !(state && state.removePicked) });
    });
    $("resetPicked").addEventListener("click", function () { send({ type: "resetPicked" }); });
    $("addWheel").addEventListener("click", function () { send({ type: "addWheel" }); });

    // ---- Sound: synthesized with Web Audio, as in the prototype. No audio files. ----
    var audio = null, muted = false, voices = [];
    var STORED_HINT = "draw-lots:sound-stored";

    // The context is created and resumed only by a pointerdown in the panel (browser autoplay rules).
    document.addEventListener("pointerdown", function () {
        if (!audio) {
            try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
        }
        if (audio && audio.state === "suspended") audio.resume();
    }, true);

    function canPlay() { return !!audio && audio.state === "running" && !muted; }

    function tone(t, freq, dur, vol, type) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = type || "sine";
        o.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
        voices.push({ gain: g, end: t + dur + 0.02 });
    }
    function sfxTick(t) {
        tone(t, 1500, 0.035, 0.09, "triangle");
        tone(t, 380, 0.03, 0.05, "sine");
    }
    function sfxLand(t) {
        [523.25, 659.25, 783.99, 1046.5].forEach(function (f, k) {
            tone(t + k * 0.07, f, k === 3 ? 0.55 : 0.28, k === 3 ? 0.16 : 0.12, "sine");
        });
    }
    function silence() {
        voices.forEach(function (v) { try { v.gain.disconnect(); } catch (e) {} });
        voices = [];
    }
    function prune() {
        var now = audio ? audio.currentTime : 0;
        voices = voices.filter(function (v) { return v.end > now; });
    }

    // Same maths as the driver's tickTimes: a wedge boundary passes the notch whenever the
    // rotation crosses a multiple of the wedge angle; ease-out quart is inverted per boundary.
    function tickTimes(s) {
        var out = [], wedge = 360 / s.count, end = s.startDeg + s.deltaDeg, last = -Infinity;
        if (s.count < 2 || s.deltaDeg <= 0) return out;
        for (var m = Math.floor(s.startDeg / wedge) + 1; m * wedge <= end; m++) {
            var u = (m * wedge - s.startDeg) / s.deltaDeg;
            var t = (1 - Math.pow(1 - u, 0.25)) * s.durationMs;
            if (t - last >= 45) { out.push(t); last = t; }
        }
        return out;
    }

    function playSpin(s, elapsedMs) {
        if (!canPlay()) return;
        prune();
        var elapsed = elapsedMs || 0, base = audio.currentTime - elapsed / 1000;
        tickTimes(s).forEach(function (t) { if (t >= elapsed) sfxTick(base + t / 1000); });
        sfxLand(base + s.durationMs / 1000);
    }

    function setMuted(value, fromUser) {
        muted = value;
        var b = $("soundBtn"), label = muted ? "Turn sounds on" : "Mute sounds";
        b.setAttribute("aria-pressed", String(!muted));
        b.title = label;
        b.setAttribute("aria-label", label);
        if (muted) silence();
        if (fromUser) send({ type: "setMuted", muted: muted });
    }
    $("soundBtn").addEventListener("click", function () { setMuted(!muted, true); });

    var motion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (motion && motion.addEventListener) {
        motion.addEventListener("change", function () { send({ type: "reducedMotion", value: motion.matches }); });
    }
    function storedHint() { try { return window.localStorage.getItem(STORED_HINT) === "1"; } catch (e) { return false; } }

    api.onMessage(function (msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "spin") { playSpin(msg.schedule, msg.elapsedMs); return; }
        if (msg.type === "spinCancel") { silence(); if (canPlay()) sfxLand(audio.currentTime); return; }
        if (msg.type === "land") { if (canPlay()) sfxLand(audio.currentTime); return; }
        if (msg.type === "sound") { setMuted(!!msg.muted, false); return; }
        if (msg.type === "soundStored") { try { window.localStorage.setItem(STORED_HINT, "1"); } catch (e) {} return; }
        if (msg.type === "theme") {
            $("theme").textContent = ":root{" + msg.css + "}";
        } else if (msg.type === "state") {
            // A list update that arrives while a row is being edited waits for the edit to end.
            if (editing) { pending = msg.state; return; }
            state = msg.state;
            render();
        }
    });
    send({ type: "ready", reducedMotion: !!(motion && motion.matches), soundStored: storedHint() });
})();
</script>
</body>
</html>
`;
