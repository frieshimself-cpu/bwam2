// Shared dashboard logic for the website (boot.js) and the extension popup (popup.js).
// eslint-disable-next-line no-unused-vars
function initDashboard({ apiBase, token, onUnauthorized }) {
  const $ = (id) => document.getElementById(id);
  const API = (apiBase || "").replace(/\/$/, "");
  let state = null;
  let settingsDirty = false;
  let settingsLoaded = false;
  let events = null;

  async function api(path, body) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function fmtSol(n) {
    return n === null || n === undefined ? "—" : `${Number(n).toFixed(4)} SOL`;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  }
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function renderRun(run, live) {
    const wrap = el("div", { class: "run" });
    const title = el("div", { class: "title" });
    title.append(`"${run.source.name}" ($${run.source.symbol})`);
    if (run.outcome) title.append(el("span", { class: `outcome ${run.outcome}`, text: run.outcome }));
    wrap.append(title);
    const meta = [run.source.summary, run.trigger === "watch" ? `copied from ${run.devWallet}` : "manual relaunch", `started ${fmtTime(run.startedAt)}`];
    wrap.append(el("div", { class: "meta", text: meta.join(" · ") }));
    if (run.error) wrap.append(el("div", { class: "notice", text: run.error }));
    const list = el("ul", { class: "launches" });
    for (const launch of run.launches) {
      const window = run.windows.find((w) => w.index === launch.index);
      const li = el("li", {}, [
        el("span", { class: "idx", text: `#${launch.index}` }),
        el("a", { href: launch.url, target: "_blank", rel: "noopener", text: launch.mint }),
      ]);
      if (window) {
        li.append(el("span", { class: "result", text: `${window.buys} outside buy(s) from ${window.buyers} wallet(s), ${fmtSol(window.solRaised)} on curve` }));
      } else if (live) {
        li.append(el("span", { class: "result", text: "watching…" }));
      }
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  function costEstimate(s) {
    const perLaunch = 0.03 + Number(s.devBuySol || 0) + (s.jitoUrl ? Number(s.jitoTipSol || 0) : 0);
    const launches = Number(s.maxRelaunches || 0) + 1;
    return `worst case ≈ ${(perLaunch * launches).toFixed(3)} SOL for ${launches} launches`;
  }

  function fillSettings(s) {
    const form = $("settings");
    for (const [key, value] of Object.entries(s)) {
      const input = form.elements[key];
      if (!input) continue;
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = value;
    }
    $("cost").textContent = costEstimate(s);
  }

  function readSettings() {
    const form = $("settings");
    const out = {};
    for (const input of form.elements) {
      if (!input.name) continue;
      out[input.name] = input.type === "checkbox" ? input.checked : input.value;
    }
    return out;
  }

  function render(next) {
    state = next;
    const status = $("status");
    if (!state.rpc.ok) {
      status.textContent = "RPC not configured";
      status.className = "pill err";
    } else if (state.busy) {
      status.textContent = "relaunching";
      status.className = "pill busy";
    } else if (state.watching) {
      status.textContent = `watching ${state.devWallet.slice(0, 4)}…${state.devWallet.slice(-4)}`;
      status.className = "pill on";
    } else {
      status.textContent = "idle";
      status.className = "pill";
    }

    if (document.activeElement !== $("dev-wallet")) $("dev-wallet").value = state.devWallet || "";
    $("launcher").textContent = state.launcher ? state.launcher.address : "not configured";
    $("balance").textContent = state.launcher ? fmtSol(state.launcher.balanceSol) : "—";

    const notice = $("notice");
    const problems = [];
    if (!state.rpc.ok) problems.push(state.rpc.error);
    if (!state.launcher) problems.push(state.launcherError);
    notice.hidden = problems.length === 0;
    notice.textContent = problems.join(" · ");

    const toggle = $("toggle-watch");
    toggle.textContent = state.watching ? "Stop watching" : "Start watching";
    toggle.className = state.watching ? "" : "primary";
    toggle.disabled = !state.rpc.ok || !state.launcher || (!state.watching && !state.devWallet);
    $("stop-run").hidden = !state.busy;
    $("relaunch").disabled = state.busy || !state.rpc.ok || !state.launcher;

    if (!settingsLoaded || !settingsDirty) {
      fillSettings(state.settings);
      settingsLoaded = true;
    }

    const current = $("current");
    current.replaceChildren(state.current ? renderRun(state.current, true) : el("p", { class: "hint", text: "Nothing running." }));

    const history = $("history");
    history.replaceChildren(
      ...(state.history.length
        ? state.history.map((run) => el("div", { class: "history-item" }, [renderRun(run, false)]))
        : [el("p", { class: "hint", text: "No runs yet." })]),
    );
  }

  function appendLog(entry) {
    const pre = $("log");
    const line = el("div", { class: entry.level, text: `[${fmtTime(entry.ts)}] ${entry.msg}` });
    pre.append(line);
    while (pre.childElementCount > 400) pre.firstChild.remove();
    pre.scrollTop = pre.scrollHeight;
  }

  function connect() {
    if (events) events.close();
    const url = `${API}/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    events = new EventSource(url);
    events.addEventListener("state", (e) => {
      const next = JSON.parse(e.data);
      if (!state) {
        $("log").replaceChildren();
        next.logs.forEach(appendLog);
      }
      render(next);
    });
    events.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
    events.onerror = () => {
      $("status").textContent = "disconnected";
      $("status").className = "pill err";
    };
  }

  // A plain request first: it exposes a 401 (bad/missing token), which EventSource cannot.
  function start() {
    api("/api/state")
      .then(() => connect())
      .catch((err) => {
        $("status").textContent = /401/.test(err.message) ? "needs API token" : "backend unreachable";
        $("status").className = "pill err";
        fail(err);
      });
  }

  function fail(err) {
    appendLog({ ts: Date.now(), level: "error", msg: err.message });
  }

  $("set-dev-wallet").addEventListener("click", () => api("/api/dev-wallet", { address: $("dev-wallet").value }).then(render).catch(fail));
  $("dev-wallet").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("set-dev-wallet").click();
  });
  $("toggle-watch").addEventListener("click", () => api("/api/watch", { on: !state.watching }).then(render).catch(fail));
  $("stop-run").addEventListener("click", () => api("/api/stop", {}).then(render).catch(fail));
  $("relaunch").addEventListener("click", () => {
    const mint = $("relaunch-mint").value.trim();
    if (!mint) return;
    api("/api/relaunch", { mint }).then(render).catch(fail);
  });
  $("settings").addEventListener("input", () => {
    settingsDirty = true;
    $("cost").textContent = costEstimate(readSettings());
  });
  $("settings").addEventListener("submit", (e) => {
    e.preventDefault();
    api("/api/settings", readSettings())
      .then((next) => {
        settingsDirty = false;
        render(next);
      })
      .catch(fail);
  });

  start();
}
