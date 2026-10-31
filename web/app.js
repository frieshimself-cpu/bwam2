// Shared dashboard logic for the website (boot.js) and the extension popup (popup.js).
// eslint-disable-next-line no-unused-vars
function initDashboard({ apiBase, token, onUnauthorized }) {
  const $ = (id) => document.getElementById(id);
  const API = (apiBase || "").replace(/\/$/, "");
  let state = null;
  let dirty = false; // the user is editing wallets / settings; don't overwrite their input
  let loaded = false;
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
  function short(a) {
    return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "";
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
    const meta = [run.source.summary, run.trigger === "watch" ? `copied from ${short(run.devWallet)}` : "manual relaunch", `started ${fmtTime(run.startedAt)}`];
    wrap.append(el("div", { class: "meta", text: meta.join(" · ") }));
    if (run.error) wrap.append(el("div", { class: "notice", text: run.error }));
    const list = el("ul", { class: "launches" });
    for (const launch of run.launches) {
      const window = run.windows.find((w) => w.index === launch.index);
      const li = el("li", {}, [
        el("span", { class: "idx", text: launch.index === 0 && run.trigger === "watch" ? "orig" : `#${launch.index}` }),
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
    const copies = Math.max(1, Number(s.maxRelaunches || 0));
    return `worst case ≈ ${(perLaunch * copies).toFixed(3)} SOL per launch you make (${copies} cop${copies === 1 ? "y" : "ies"})`;
  }

  // The simple card holds dev buy + test mode; the advanced form holds the rest. Same settings object.
  function fillAll(s, wallets) {
    const form = $("settings");
    for (const [key, value] of Object.entries(s)) {
      const input = form.elements[key];
      if (!input) continue;
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = value;
    }
    $("dev-buy").value = s.devBuySol;
    $("test-mode").checked = !!s.dryRun;
    $("dev-wallets").value = (wallets || []).join("\n");
    $("cost").textContent = costEstimate(s);
  }

  function readSettings() {
    const out = {};
    for (const input of $("settings").elements) {
      if (!input.name) continue;
      out[input.name] = input.type === "checkbox" ? input.checked : input.value;
    }
    out.devBuySol = $("dev-buy").value;
    out.dryRun = $("test-mode").checked;
    return out;
  }

  function readWallets() {
    return $("dev-wallets").value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  }

  function render(next) {
    state = next;
    const status = $("status");
    const testing = state.settings.dryRun;
    if (state.updating) {
      status.textContent = "updating…";
      status.className = "pill busy";
    } else if (!state.rpc.ok) {
      status.textContent = "RPC not configured";
      status.className = "pill err";
    } else if (state.busy) {
      status.textContent = testing ? "copying (test mode)" : "copying";
      status.className = "pill busy";
    } else if (state.watching) {
      status.textContent = `watching ${state.devWallets.length} wallet${state.devWallets.length === 1 ? "" : "s"}${testing ? " (test mode)" : ""}`;
      status.className = "pill on";
    } else {
      status.textContent = "stopped";
      status.className = "pill";
    }

    $("launcher").textContent = state.launcher ? state.launcher.address : "not configured";
    $("balance").textContent = state.launcher ? fmtSol(state.launcher.balanceSol) : "—";
    $("version").textContent = state.version || "—";
    $("update").disabled = !!state.updating || !!state.busy;

    const notice = $("notice");
    const problems = [];
    if (!state.rpc.ok) problems.push(state.rpc.error);
    if (!state.launcher) problems.push(state.launcherError);
    if (state.launcher && state.launcher.balanceSol !== null && state.launcher.balanceSol < 0.03) {
      problems.push(`launch wallet is low (${fmtSol(state.launcher.balanceSol)}); each copy costs about 0.03 SOL plus the dev buy`);
    }
    notice.hidden = problems.length === 0;
    notice.textContent = problems.join(" · ");

    const ready = state.rpc.ok && !!state.launcher;
    $("start").textContent = state.watching ? "Save changes" : "Save & start";
    $("start").disabled = !ready;
    $("stop").hidden = !state.watching;
    $("stop-run").hidden = !state.busy;
    $("relaunch").disabled = state.busy || !ready;

    if (!loaded || !dirty) {
      fillAll(state.settings, state.devWallets);
      loaded = true;
    }

    $("current").replaceChildren(state.current ? renderRun(state.current, true) : el("p", { class: "hint", text: "Nothing running." }));
    $("history").replaceChildren(
      ...(state.history.length
        ? state.history.map((run) => el("div", { class: "history-item" }, [renderRun(run, false)]))
        : [el("p", { class: "hint", text: "No runs yet." })]),
    );
  }

  function appendLog(entry) {
    const pre = $("log");
    pre.append(el("div", { class: entry.level, text: `[${fmtTime(entry.ts)}] ${entry.msg}` }));
    while (pre.childElementCount > 400) pre.firstChild.remove();
    pre.scrollTop = pre.scrollHeight;
  }

  function connect() {
    if (events) events.close();
    events = new EventSource(`${API}/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
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

  // Save wallets + settings, then make sure watching is on.
  async function saveAndStart() {
    const wallets = readWallets();
    if (wallets.length === 0) throw new Error("paste at least one wallet address to copy");
    await api("/api/dev-wallets", { addresses: wallets });
    await api("/api/settings", readSettings());
    const next = await api("/api/watch", { on: true });
    dirty = false;
    render(next);
  }

  for (const id of ["dev-wallets", "dev-buy", "test-mode"]) $(id).addEventListener("input", () => (dirty = true));
  $("settings").addEventListener("input", () => {
    dirty = true;
    $("cost").textContent = costEstimate(readSettings());
  });
  $("start").addEventListener("click", () => saveAndStart().catch(fail));
  $("stop").addEventListener("click", () => api("/api/watch", { on: false }).then(render).catch(fail));
  $("stop-run").addEventListener("click", () => api("/api/stop", {}).then(render).catch(fail));
  $("settings").addEventListener("submit", (e) => {
    e.preventDefault();
    api("/api/settings", readSettings())
      .then((next) => {
        dirty = false;
        render(next);
      })
      .catch(fail);
  });
  $("relaunch").addEventListener("click", () => {
    const mint = $("relaunch-mint").value.trim();
    if (!mint) return;
    api("/api/relaunch", { mint }).then(render).catch(fail);
  });
  $("update").addEventListener("click", () => {
    if (!window.confirm("Pull the latest version from GitHub and restart the backend? Watching resumes by itself afterwards.")) return;
    api("/api/update", {}).then(render).catch(fail);
  });

  start();
}
