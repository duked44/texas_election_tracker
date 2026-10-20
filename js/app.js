/* Texas Early Vote Tracker — shared by the desktop app and the website.
   Everything renders from data/dashboard.json, which the collector rewrites. */
(() => {
  const POLL_MS = 60_000;
  const TZ = "America/Chicago";
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const C = {};
  const COLOR_KEYS = ["rep", "dem", "both", "none", "mid", "inperson", "mail", "accent", "grid", "surface-3", "past-mid", "past-pres",
    "avg-mid", "avg-pres", "pace-lo", "pace-hi", "rep-text", "dem-text", "seq-0", "seq-1", "seq-2", "seq-3", "seq-4", "seq-5"];
  const loadColors = () => COLOR_KEYS.forEach(k => C[k] = css("--" + k));
  loadColors();
  const NODATA = "repeating-linear-gradient(45deg,var(--nodata-b) 0 3px,var(--nodata-a) 3px 6px)";

  const fmt = d3.format(",");
  const fmtK = (n) => n >= 1e6 ? d3.format(".2f")(n / 1e6) + "M" : n >= 1e4 ? d3.format(".0f")(n / 1e3) + "K" : fmt(n);
  const pct = (n, digits = 1) => n == null || isNaN(n) ? "—" : n.toFixed(digits) + "%";
  const share = (a, b) => b ? 100 * a / b : null;
  const parseDay = (s) => new Date(s + "T12:00:00");
  const dayShort = (s) => parseDay(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const dayLong = (s) => parseDay(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const timeCT = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const dateTimeCT = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
  const shortCT = (iso) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} hr ${m % 60} min ago`;
  };

  let paceBasis = "common";
  let D = null, geo = null, mapMode = "turnout", selected = null, sortKey = "total", sortDir = -1;
  const tip = document.getElementById("tooltip");

  // ---------------------------------------------------------------- tooltip
  function showTip(evt, title, rows) {
    tip.innerHTML = `<div class="t">${title}</div>` + rows.map(([k, v]) => `<div class="r"><span>${k}</span><b>${v}</b></div>`).join("");
    tip.style.display = "block";
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + 14, y = evt.clientY + 14;
    if (x + w > innerWidth - 8) x = evt.clientX - w - 14;
    if (y + h > innerHeight - 8) y = evt.clientY - h - 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const hideTip = () => tip.style.display = "none";

  // ---------------------------------------------------------------- tabs
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
  function switchView(v) {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    document.querySelectorAll(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    try { localStorage.setItem("tab", v); } catch (e) {}
    if (D) render();
  }
  try { const t = localStorage.getItem("tab"); if (t && document.getElementById("view-" + t)) switchView(t); } catch (e) {}

  // ---------------------------------------------------------------- refresh button (desktop only)
  const isLocal = ["127.0.0.1", "localhost"].includes(location.hostname);
  const refreshBtn = document.getElementById("refresh-btn");
  if (isLocal) {
    refreshBtn.hidden = false;
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = "Checking…";
      try { await fetch("/api/refresh", { method: "POST" }); } catch (e) {}
      setTimeout(() => { refreshBtn.disabled = false; refreshBtn.textContent = "Check now"; load(); }, 15000);
    });
  }

  // ---------------------------------------------------------------- data
  async function load() {
    try {
      const r = await fetch("data/dashboard.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const changed = !D || j.generated_at !== D.generated_at;
      D = j;
      if (changed) render(); else renderFreshness();
    } catch (e) {
      document.getElementById("updated-sub").textContent = "Can't reach data file — retrying";
      document.getElementById("live-dot").className = "dot bad";
    }
  }

  // ---------------------------------------------------------------- freshness
  function renderFreshness() {
    const s = D.status;
    const changed = D.data_changed_at || D.generated_at;
    const sameDay = new Date(changed).toLocaleDateString("en-CA", { timeZone: TZ }) === new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    document.getElementById("updated-at").textContent = sameDay ? timeCT(changed) + " CT" : dateTimeCT(changed);
    renderCountdown();
    const through = D.data_through ? dayLong(D.data_through) : "—";
    document.getElementById("updated-sub").innerHTML =
      `Votes counted through <b>${through}</b> · ${s.last_check ? "Checked state " + ago(s.last_check) : "First check in progress"}`;
    const ageMin = s.last_check ? (Date.now() - new Date(s.last_check)) / 60000 : 0;
    const dot = document.getElementById("live-dot");
    dot.className = "dot " + (s.last_check_ok === false ? "bad" : ageMin > 3 * (s.poll_minutes || 10) ? "warn" : "ok");
    dot.title = s.last_check ? `Last check with the state: ${dateTimeCT(s.last_check)}` : "";

    // Notices: one compact strip, one line each; tap a line for the full explanation.
    const notes = [];   // { key, cls, title, short, detail, meter? }
    if (s.last_check_ok === false && s.errors && s.errors.length)
      notes.push({ key: "err", cls: "bad", title: "State server trouble", short: "showing the last good data, retrying every 2 min",
        detail: `The state's data server had trouble on the last check (${s.errors[s.errors.length - 1].msg.replace(/</g, "&lt;")}). The tracker keeps showing the most recent good data and retries automatically every 2 minutes.` });
    else if (s.last_check && ageMin > 3 * (s.poll_minutes || 10))
      notes.push({ key: "stale", cls: "warn", title: "Data may be stale", short: `last good check ${ago(s.last_check)}`,
        detail: `The last successful check with the state was ${ago(s.last_check)}.` });
    if (D.incoming) {
      const inc = D.incoming;
      notes.push({ key: "incoming", cls: "info", title: `${dayShort(inc.date)} coming in`,
        short: `${inc.share_registered}% of voters' counties reported · switches at ${inc.needed}%`,
        meter: Math.min(1, inc.share_registered / inc.needed),
        detail: `${inc.counties} ${inc.counties === 1 ? "county has" : "counties have"} reported the full day so far (${inc.share_registered}% of registered voters)${inc.partial_counties ? `; ${inc.partial_counties} more posted early partial uploads (${fmt(inc.partial_votes)} votes)` : ""}. Headline totals already include every vote reported. Day-by-day charts and pace move to ${dayShort(inc.date)} once counties holding ${inc.needed}% of voters have reported.` });
    }
    if (D.awaiting && D.awaiting.length)
      notes.push({ key: "awaiting", cls: "warn", title: `${D.awaiting.length} ${D.awaiting.length === 1 ? "county" : "counties"} awaiting data`,
        short: D.awaiting.length <= 3 ? D.awaiting.join(", ") : `${D.awaiting.slice(0, 2).join(", ")} +${D.awaiting.length - 2} more`,
        detail: `${D.awaiting.join(", ")}. The state has almost no early-vote data for ${D.awaiting.length === 1 ? "this county" : "these counties"} yet; ${D.awaiting.length === 1 ? "it's" : "they're"} shown as missing rather than near-zero turnout.` });
    const bigMissing = D.counties.filter(c => !c.reported_today && !c.awaiting && c.registered >= 150000).sort((a, b) => b.registered - a.registered);
    if (bigMissing.length)
      notes.push({ key: "bigmissing", cls: "warn", title: `${bigMissing.length} large ${bigMissing.length === 1 ? "county" : "counties"} behind`,
        short: bigMissing.length <= 3 ? bigMissing.map(c => c.name).join(", ") : `${bigMissing.slice(0, 2).map(c => c.name).join(", ")} +${bigMissing.length - 2} more`,
        detail: `Missing from the state's ${D.data_through ? dayShort(D.data_through) : ""} numbers: ${bigMissing.map(c => c.name + (c.incomplete ? " (incomplete)" : "")).join(", ")}. Statewide totals will jump when they upload.` });
    const host = document.getElementById("banner");
    host.innerHTML = notes.length ? `<div class="notices">${notes.map(n => `
      <details class="notice ${n.cls}" data-key="${n.key}"${openNotes.has(n.key) ? " open" : ""}>
        <summary><i class="ndot"></i><b>${n.title}</b><span class="nshort">${n.short}</span>${n.meter != null ? `<span class="nmeter"><span style="width:${(100 * n.meter).toFixed(1)}%"></span></span>` : ""}<span class="nmore" aria-hidden="true"></span></summary>
        <div class="nbody">${n.detail}</div>
      </details>`).join("")}</div>` : "";
    host.querySelectorAll("details").forEach(d => d.addEventListener("toggle", () => d.open ? openNotes.add(d.dataset.key) : openNotes.delete(d.dataset.key)));
  }
  setInterval(() => D && renderFreshness(), 30_000);

  // ---------------------------------------------------------------- render
  // Days until Election Day (Texas date), shown in the header.
  const openNotes = new Set();
  // Live countdown to polls closing (7 PM Central on Election Day; El Paso and Hudspeth close an hour later).
  // Nov 3 falls after daylight saving ends, so Central is UTC-6.
  function renderCountdown() {
    const el = document.getElementById("countdown");
    if (!D || !D.election) return;
    const close = new Date(D.election.election_day + "T19:00:00-06:00");
    let s = Math.floor((close - Date.now()) / 1000);
    el.hidden = false;
    el.title = "Polls close at 7 PM Central on Nov 3 (8 PM Central in El Paso and Hudspeth counties)";
    if (s <= 0) { el.innerHTML = `<b>Polls closed</b>`; return; }
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); s %= 60;
    const narrow = matchMedia("(max-width: 720px)").matches;   // phones: 13d 8h 40m 44s
    const u = (n, w) => narrow ? `<b>${n}</b>${w[0]}` : `<b>${n}</b> ${w}${n === 1 ? "" : "s"}`;
    el.innerHTML = `<span class="cd-l">Polls close in</span> ` + [d ? u(d, "day") : "", u(h, "hour"), u(m, "minute"), u(s, "second")].filter(Boolean).join(narrow ? " " : ", ");
  }
  setInterval(renderCountdown, 1000);

  // ---- light / dark mode
  const themeBtn = document.getElementById("theme-btn");
  const SUN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"></circle><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"></path></svg>';
  const MOON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path></svg>';
  function syncThemeBtn() {
    const light = document.documentElement.dataset.theme === "light";
    themeBtn.innerHTML = light ? MOON : SUN;
    themeBtn.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
    themeBtn.title = light ? "Dark mode" : "Light mode";
  }
  themeBtn.addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    if (light) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("theme", light ? "light" : "dark"); } catch (e) {}
    syncThemeBtn();
    loadColors();
    if (D) render();
  });
  syncThemeBtn();

  // ---- side summary next to the map
  document.getElementById("side-all").addEventListener("click", () => switchView("counties"));
  function renderSideSummary() {
    const top = [...D.counties].sort((a, b) => b.total - a.total).slice(0, 7);
    const short = r => r === "Big 5 Urban" ? "Big 5" : r === "Suburban Ring" ? "Suburban" : r === "Rio Grande Valley" ? "RGV" : r.split(" ")[0];
    const ul = document.getElementById("side-largest");
    ul.innerHTML = top.map(c => `<li data-fips="${c.fips}"><span><b>${c.name}</b><span class="tag">${short(c.region)}</span></span><span class="v">${fmt(c.total)} · ${pct(c.turnout_pct)}</span></li>`).join("");
    ul.querySelectorAll("li").forEach(li => li.addEventListener("click", () => zoomTo(li.dataset.fips)));
    const comp = D.statewide.comp, tot = D.statewide.roster_total;
    const parts = [{ k: "R", label: "R primary", fill: C.rep, txt: C["rep-text"] }, { k: "D", label: "D primary", fill: C.dem, txt: C["dem-text"] },
                   { k: "N", label: "No primary", fill: C.none, txt: "var(--text-primary)" }];
    const val = k => k === "N" ? comp.N + comp.X : comp[k];
    document.getElementById("side-comp").innerHTML = tot ? `
      <div class="stack">${parts.map(p => { const v = 100 * val(p.k) / tot; return `<div style="width:${v}%;background:${p.fill}">${v >= 8 ? pct(v, 0) : ""}</div>`; }).join("")}</div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px;font-size:12px;color:var(--text-secondary)">
        ${parts.map(p => `<div><div style="color:${p.txt};font-weight:700">${p.label}</div><div class="num">≈ ${fmt(val(p.k))}</div></div>`).join("")}
      </div>
      <div class="caveat">Estimated from voter lists covering ${pct(share(D.statewide.listed_total, D.statewide.total), 0)} of ballots, weighted by county. Shows which party's 2026 primary a voter chose, not how anyone is voting for Senate.</div>`
      : `<div class="caveat">Voter lists are still loading.</div>`;
  }

  function render() {
    renderFreshness();
    const active = document.querySelector(".view.active").id;
    if (active === "view-ev") { setMapChrome(); renderKpis(); renderMap(); renderSideSummary(); renderCum(); renderDaily(); renderPace(); renderComp(); renderExtended(); renderCompDaily(); renderRegions(); renderLeaders(); renderSources(); }
    if (active === "view-counties") renderCounties();
    if (active === "view-eday") renderEday();
  }

  // Before in-person voting opens only mail exists, so "since Oct 18" on day 1 really means "since voting opened".
  const sinceLabel = () => !D.previous_day ? "" : D.previous_day < D.election.ev_in_person_start ? "since early voting opened" : `since ${dayShort(D.previous_day)}`;

  function evDays() {
    const out = [];
    for (let d = parseDay(D.election.ev_in_person_start); d <= parseDay(D.election.ev_end); d.setDate(d.getDate() + 1))
      out.push(d.toISOString().slice(0, 10));
    return out;
  }

  // ---------------------------------------------------------------- KPIs
  function renderKpis() {
    const s = D.statewide;
    const prevTotal = d3.sum(D.counties, c => c.prev_total || 0);
    const days = evDays();
    const dataDay = D.data_through ? days.indexOf(D.data_through) + 1 : 0;
    // Today's calendar date in Texas (Central), not the date of the latest numbers.
    const todayCT = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const todayN = days.indexOf(todayCT) + 1;
    const evState = todayCT < days[0] ? "before" : todayCT > days[days.length - 1] ? "after" : "during";
    const pace = D.compare && D.compare.summary && D.compare.summary.common;
    const k = [
      { cls: "hero", label: "Total early ballots", value: fmt(s.total),
        delta: (s.since_through > 0 && D.incoming ? `<span class="up">+${fmt(s.since_through)}</span> reported so far for ${dayShort(D.incoming.date)} · ` : "")
          + `${pct(s.turnout_pct, 2)} of ${fmtK(s.registered)} registered voters` },
      { label: "In person", value: fmt(s.in_person), delta: (() => {
          const ipNew = s.in_person - d3.sum(D.counties, c => c.in_person_through ?? c.in_person);
          return ipNew > 0 && D.incoming ? `<span class="up">+${fmt(ipNew)}</span> so far for ${dayShort(D.incoming.date)}`
            : `<span class="up">+${fmt(s.in_person_day)}</span> on ${D.data_through ? dayLong(D.data_through) : "—"}`; })() },
      { label: "Mail ballots", value: fmt(s.mail), delta: `${pct(share(s.mail, s.total))} of ballots` },
      { label: "Pace vs. midterms", value: pace && pace.pace_vs_mid ? `${pace.pace_vs_mid.toFixed(2)}<small>×</small>` : "—",
        delta: pace && pace.pace_vs_mid ? `vs. 2014–2022 average on day ${D.compare.current_day}` : "Past-election data loading" },
      { label: evState === "during" ? "Early voting" : "Early voting",
        value: evState === "during" ? `Day ${todayN} <small>of ${days.length}</small>` : evState === "before" ? `Starts ${dayShort(days[0])}` : "Ended",
        delta: (dataDay > 0 ? `Counted through day ${dataDay} · ${s.counties_reporting_day} of ${s.counties_total} counties in` : "No in-person votes counted yet"),
        progress: evState === "after" ? 1 : Math.max(0, todayN) / days.length },
    ];
    document.getElementById("kpis").innerHTML = k.map(x => `
      <div class="card kpi ${x.cls || ""}"><div class="label">${x.label}</div><div class="value num">${x.value}</div>
      <div class="delta">${x.delta}</div>${x.progress != null ? `<div class="progress"><i style="width:${100 * x.progress}%"></i></div>` : ""}</div>`).join("");
  }

  // ---------------------------------------------------------------- map
  document.querySelectorAll("#map-mode button").forEach(b => b.addEventListener("click", () => {
    mapMode = b.dataset.mode;
    document.querySelectorAll("#map-mode button").forEach(x => x.classList.toggle("active", x === b));
    renderMap();
  }));

  const leanOf = (c) => !c.awaiting && c.comp && (c.comp.R + c.comp.D) >= 20 ? (c.comp.R - c.comp.D) / (c.comp.R + c.comp.D) : null;

  // ---------------------------------------------------------------- 2024 results (Texas Legislative Council, by precinct)
  // R24[fips][precinct] = [cruz, allred, senOther, trump, harris, presOther]; county totals summed from precincts.
  let R24 = null, R24c = {};
  async function loadR24() {
    if (R24) return R24;
    try { R24 = await (await fetch("data/results-2024.json")).json(); } catch (e) { R24 = {}; }
    for (const [f, ps] of Object.entries(R24)) {
      const t = [0, 0, 0, 0, 0, 0];
      for (const v of Object.values(ps)) v.forEach((x, i) => t[i] += x);
      R24c[f] = t;
    }
    return R24;
  }
  const senTot = r => r ? r[0] + r[1] + r[2] : 0;
  const presTot = r => r ? r[3] + r[4] + r[5] : 0;
  const senMargin = r => senTot(r) ? (r[0] - r[1]) / senTot(r) : null;   // + = Cruz
  const marginTxt = (m, rLab = "R", dLab = "D") => m == null ? "—" : m >= 0 ? `${rLab}+${(100 * m).toFixed(1)}` : `${dLab}+${(-100 * m).toFixed(1)}`;
  function results24Rows(r, ballots) {
    if (!r || !senTot(r)) return [];
    const rows = [["2024 Senate", `Cruz ${pct(100 * r[0] / senTot(r))} · Allred ${pct(100 * r[1] / senTot(r))}`],
                  ["2024 Senate margin", marginTxt(senMargin(r), "Cruz ", "Allred ")]];
    if (presTot(r)) rows.push(["2024 President", `Trump ${pct(100 * r[3] / presTot(r))} · Harris ${pct(100 * r[4] / presTot(r))}`]);
    if (ballots != null) rows.push(["Early ballots vs 2024 Senate votes", pct(100 * ballots / senTot(r))]);
    return rows;
  }
  const dlRows = rows => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  // ---------------------------------------------------------------- map (state view + county zoom with precincts)
  let zoomFips = null, selPrecinct = null, precMode = "ballots", mapCtx = null;
  const precGeoCache = {};
  const seqRamp = () => [C["seq-0"], C["seq-1"], C["seq-2"], C["seq-3"], C["seq-4"], C["seq-5"]];

  function countyColoring() {
    const ramp = seqRamp();
    if (mapMode === "turnout") {
      const max = d3.quantile(D.counties.map(c => c.turnout_pct || 0).sort(d3.ascending), 0.97) || 1;
      return { val: c => c.awaiting ? null : c.turnout_pct, color: d3.scaleSequential(d3.interpolateRgbBasis(ramp)).domain([0, max]).clamp(true),
        hint: "Early ballots as a share of registered voters", legend: rampLegend(ramp, "0%", pct(max, 0) + "+") };
    }
    if (mapMode === "votes") {
      const max = d3.max(D.counties, c => c.total) || 1;
      return { val: c => c.awaiting ? null : c.total, color: d3.scaleSequentialSqrt(d3.interpolateRgbBasis(ramp)).domain([0, max]),
        hint: "Total early ballots cast (square-root scale)", legend: rampLegend(ramp, "0", fmtK(max)) };
    }
    if (mapMode === "lean") {
      return { val: leanOf, color: d3.scaleDiverging(d3.interpolateRgbBasis([C.dem, C.mid, C.rep])).domain([-0.6, 0, 0.6]).clamp(true),
        hint: "Among early voters with 2026 primary history: Republican minus Democratic primary voters",
        legend: rampLegend([C.dem, C.mid, C.rep], "More D-primary voters", "More R-primary voters") };
    }
    if (mapMode === "sen24") {
      return { val: c => senMargin(R24c[c.fips]), color: d3.scaleDiverging(d3.interpolateRgbBasis([C.dem, C.mid, C.rep])).domain([-0.5, 0, 0.5]).clamp(true),
        hint: "2024 U.S. Senate result: Ted Cruz (R) vs. Colin Allred (D) margin. For context next to 2026 turnout.",
        legend: rampLegend([C.dem, C.mid, C.rep], "Allred +50", "Cruz +50") };
    }
    if (mapMode === "pace") {
      const lo = C["pace-lo"], hi = C["pace-hi"], mid = C.mid;
      return { val: c => !c.awaiting && c.cmp ? c.cmp.pace_vs_mid : null, color: d3.scaleDiverging(d3.interpolateRgbBasis([lo, mid, hi])).domain([0.5, 1, 1.5]).clamp(true),
        hint: "2026 early turnout vs. the same day of early voting in the midterm average (2014, 2018, 2022 where available). 1.0× = same pace",
        legend: rampLegend([lo, mid, hi], "0.5× (slower)", "1.5×+ (faster)") };
    }
    const v = c => share(c.in_person_day, c.registered);
    const max = d3.quantile(D.counties.map(c => v(c) || 0).sort(d3.ascending), 0.97) || 1;
    return { val: c => c.reported_today ? v(c) : null, color: d3.scaleSequential(d3.interpolateRgbBasis(ramp)).domain([0, max]).clamp(true),
      hint: `In-person votes on ${D.data_through ? dayLong(D.data_through) : "the latest day"}, as a share of registered voters`,
      legend: rampLegend(ramp, "0%", pct(max, 1) + "+") + ` <span><i class="sw" style="background:${NODATA}"></i>No report for this day</span>` };
  }

  const pBallots = r => r ? Math.max(r.n, r.county_n || 0) : 0;
  function precinctColoring(rows) {
    const ramp = seqRamp();
    if (precMode === "lean") {
      return { val: r => r && r.R + r.D >= 10 ? (r.R - r.D) / (r.R + r.D) : null,
        color: d3.scaleDiverging(d3.interpolateRgbBasis([C.dem, C.mid, C.rep])).domain([-0.6, 0, 0.6]).clamp(true),
        hint: "Early voters with 2026 primary history: Republican minus Democratic primary voters (precincts with 10+ such voters)",
        legend: rampLegend([C.dem, C.mid, C.rep], "More D-primary voters", "More R-primary voters") };
    }
    if (precMode === "sen24") {
      const res = R24[zoomFips] || {};
      return { val: r => r ? senMargin(res[r.p]) : null, byP: true,
        color: d3.scaleDiverging(d3.interpolateRgbBasis([C.dem, C.mid, C.rep])).domain([-0.6, 0, 0.6]).clamp(true),
        hint: "2024 U.S. Senate result in each precinct: Cruz (R) vs. Allred (D) margin",
        legend: rampLegend([C.dem, C.mid, C.rep], "Allred +60", "Cruz +60") };
    }
    if (precMode === "share24") {
      const res = R24[zoomFips] || {};
      return { val: r => r && senTot(res[r.p]) >= 25 ? pBallots(r) / senTot(res[r.p]) : null, byP: true,
        color: d3.scaleSequential(d3.interpolateRgbBasis(seqRamp())).domain([0, 0.6]).clamp(true),
        hint: "Early ballots so far as a share of the precinct's total 2024 Senate votes. A turnout-style rate without needing registered voters.",
        legend: rampLegend(seqRamp(), "0%", "60%+") };
    }
    if (precMode === "mail") {
      return { val: r => r && r.n >= 10 ? r.mail / r.n : null, color: d3.scaleSequential(d3.interpolateRgbBasis(ramp)).domain([0, 0.5]).clamp(true),
        hint: "Share of each precinct's early ballots cast by mail", legend: rampLegend(ramp, "0%", "50%+") };
    }
    if (precMode === "noprim") {
      return { val: r => r && r.n >= 10 ? r.N / r.n : null, color: d3.scaleSequential(d3.interpolateRgbBasis(ramp)).domain([0, 0.8]).clamp(true),
        hint: "Share of each precinct's early voters who skipped the 2026 primaries", legend: rampLegend(ramp, "0%", "80%+") };
    }
    const max = d3.quantile(rows.map(pBallots).sort(d3.ascending), 0.98) || 1;
    return { val: r => r ? pBallots(r) : null, color: d3.scaleSequentialSqrt(d3.interpolateRgbBasis(ramp)).domain([0, max]).clamp(true),
      hint: "Early ballots cast in each precinct (square-root scale). Registered voters per precinct aren't published, so this is a count, not a rate.",
      legend: rampLegend(ramp, "0", fmt(Math.round(max)) + "+") };
  }

  async function precinctGeo(fips) {
    if (!precGeoCache[fips]) precGeoCache[fips] = await (await fetch(`data/precinct-geo/${fips}.json`)).json();
    return precGeoCache[fips];
  }
  async function precinctData(fips) {
    let data = precCache[fips];
    if (!data || data._for !== D.generated_at) {   // re-download once per dashboard refresh
      data = await (await fetch(`data/precincts/${fips}.json?t=${Date.now()}`, { cache: "no-store" })).json();
      data._for = D.generated_at;
      precCache[fips] = data;
    }
    return data;
  }

  function zoomTransform(fips) {
    const { W, H, path } = mapCtx;
    const f = geo.features.find(x => x.id === fips);
    const [[x0, y0], [x1, y1]] = path.bounds(f);
    const k = Math.min(60, 0.88 / Math.max((x1 - x0) / W, (y1 - y0) / H));
    return d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
  }

  // ---------------------------------------------------------------- zoom slider (works on the state map and county maps)
  const ZMIN = 1, ZMAX = 10;
  let userZoom = null;
  function setupUserZoom(svg) {
    const { W, H } = mapCtx;
    if (!userZoom) {
      userZoom = d3.zoom().scaleExtent([ZMIN, ZMAX]).clickDistance(4)
        .filter(e => e.type !== "dblclick" && !e.button)   // wheel zooms at the cursor; drag pans
        .wheelDelta(e => -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002))
        .on("zoom", e => {
          svg.select("g.uz").attr("transform", e.transform);
          const k = e.transform.k;
          document.getElementById("zoom-range").value = k;
          document.getElementById("zoom-val").textContent = k.toFixed(1) + "×";
          document.getElementById("map").classList.toggle("pannable", k > 1.01);
        });
      svg.call(userZoom);
    }
    userZoom.extent([[0, 0], [W, H]]).translateExtent([[0, 0], [W, H]]);
  }
  const mapSvg = () => d3.select("#map svg");
  // Animate, then make sure the final state lands even if animation frames are paused (background window).
  function applyZoom(fn, ms) {
    if (!userZoom) return;
    if (!ms) { mapSvg().call(fn); return; }
    mapSvg().transition("uz").duration(ms).call(fn);
    setTimeout(() => { mapSvg().interrupt("uz").call(fn); }, ms + 80);
  }
  function setZoom(k, animate = true) {
    k = Math.max(ZMIN, Math.min(ZMAX, k));
    applyZoom(sel => sel.call(userZoom.scaleTo, k), animate ? 300 : 0);
  }
  function resetUserZoom(animate = true) {
    applyZoom(sel => sel.call(userZoom.transform, d3.zoomIdentity), animate ? 500 : 0);
  }
  document.getElementById("zoom-range").addEventListener("input", e => setZoom(+e.target.value, false));
  document.getElementById("zoom-in").addEventListener("click", () => setZoom(+document.getElementById("zoom-range").value * 1.5));
  document.getElementById("zoom-out").addEventListener("click", () => setZoom(+document.getElementById("zoom-range").value / 1.5));
  document.getElementById("zoom-reset").addEventListener("click", () => resetUserZoom());

  async function zoomTo(fips) {
    if (!mapCtx) return;
    zoomFips = fips; selected = fips; selPrecinct = null; hideTip();
    resetUserZoom();
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setMapChrome();
    const vp = d3.select("#map svg g.vp");
    vp.select("g.precincts").selectAll("*").remove();
    await renderMap({ skipTransform: true });
    // Draw precincts when the zoom finishes; the timer covers interrupted animations and
    // backgrounded windows (where animation frames pause).
    let drawn = false;
    const draw = () => { if (!drawn && zoomFips === fips) { drawn = true; vp.attr("transform", zoomTransform(fips).toString()); drawPrecincts(true); } };
    vp.transition().duration(850).ease(d3.easeCubicInOut).attr("transform", zoomTransform(fips).toString())
      .on("end", draw).on("interrupt", draw);
    setTimeout(draw, 1000);
    renderSide();
  }

  function zoomOut() {
    if (!zoomFips) return;
    zoomFips = null; selPrecinct = null; hideTip();
    resetUserZoom();
    setMapChrome();
    const vp = d3.select("#map svg g.vp");
    const pg = vp.select("g.precincts");
    const clear = () => { if (!zoomFips) pg.selectAll("*").remove(); pg.style("opacity", 1); };
    pg.transition().duration(250).style("opacity", 0).on("end", clear).on("interrupt", clear);
    setTimeout(clear, 400);
    vp.transition().duration(750).ease(d3.easeCubicInOut).attr("transform", d3.zoomIdentity.toString());
    renderMap({ skipTransform: true });
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") zoomOut(); });

  function setMapChrome() {
    const zoomed = !!zoomFips;
    document.getElementById("map-mode").hidden = zoomed;
    document.getElementById("prec-mode").hidden = !zoomed;
    document.getElementById("map-back").hidden = !zoomed;
    document.getElementById("side-charts").hidden = zoomed;
    document.getElementById("map-side").hidden = !zoomed;
    const c = zoomed && D.counties.find(x => x.fips === zoomFips);
    document.getElementById("map-title").textContent = zoomed ? `${c ? c.name : ""} County precincts` : "Texas by county";
  }

  async function renderMap(opts = {}) {
    if (!geo) geo = await (await fetch("data/tx-counties.geojson")).json();
    await loadR24();
    const el = document.getElementById("map");
    const W = el.clientWidth || 700, H = Math.round(W * 0.92);
    if (!mapCtx || mapCtx.W !== W) {
      const proj = d3.geoConicConformal().parallels([27.5, 35]).rotate([100, 0]).fitSize([W, H], geo);
      mapCtx = { W, H, proj, path: d3.geoPath(proj) };
    }
    const { path } = mapCtx;
    const byFips = new Map(D.counties.map(c => [c.fips, c]));
    const cc = countyColoring();
    if (!zoomFips) {
      document.getElementById("map-hint").textContent = cc.hint;
      document.getElementById("map-legend").innerHTML = cc.legend;
    }

    const svg = d3.select(el).selectAll("svg").data([0]).join("svg").attr("viewBox", `0 0 ${W} ${H}`);
    if (svg.select("defs").empty()) {
      const defs = svg.append("defs");
      defs.append("pattern").attr("id", "nodata").attr("width", 6).attr("height", 6).attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)")
        .call(p => { p.append("rect").attr("width", 6).attr("height", 6).style("fill", "var(--nodata-a)"); p.append("rect").attr("width", 3).attr("height", 6).style("fill", "var(--nodata-b)"); });
      const vp = svg.append("g").attr("class", "uz").append("g").attr("class", "vp");
      vp.append("g").attr("class", "counties");
      vp.append("g").attr("class", "precincts");
    }
    setupUserZoom(svg);
    const vp = svg.select("g.vp");
    if (!opts.skipTransform) vp.attr("transform", zoomFips ? zoomTransform(zoomFips).toString() : null);

    vp.select("g.counties").selectAll("path.county").data(geo.features, f => f.id).join("path")
      .attr("class", f => "county" + (selected === f.id ? " sel" : "") + (zoomFips && f.id !== zoomFips ? " dim" : ""))
      .attr("d", path)
      .attr("fill", f => { const c = byFips.get(f.id); const v = c && cc.val(c); return v == null ? "url(#nodata)" : cc.color(v); })
      .on("mousemove", (evt, f) => { const c = byFips.get(f.id); if (c && f.id !== zoomFips) showTip(evt, `${c.name} County`, countyTipRows(c)); })
      .on("mouseleave", hideTip)
      .on("click", (evt, f) => { if (f.id !== zoomFips) zoomTo(f.id); });

    if (zoomFips && !opts.skipTransform) await drawPrecincts(false);
    if (zoomFips) renderSide();
  }

  async function drawPrecincts(animate) {
    const fips = zoomFips;
    if (!fips) return;
    let fc, data;
    try { [fc, data] = await Promise.all([precinctGeo(fips), precinctData(fips), loadR24()]); }
    catch (e) { document.getElementById("map-hint").textContent = "Precinct map not available for this county."; return; }
    if (fips !== zoomFips) return;
    const byP = new Map(data.rows.map(r => [r.p, r]));
    const pc = precinctColoring(data.rows);
    document.getElementById("map-hint").textContent = pc.hint;
    document.getElementById("map-legend").innerHTML = pc.legend +
      ` <span><i class="sw" style="background:${NODATA}"></i>No early ballots yet</span>` +
      `<span class="muted">· Boundaries: 2024 precincts (Texas Legislative Council)</span>`;
    const c = D.counties.find(x => x.fips === fips);
    const g = d3.select("#map svg g.vp g.precincts");
    if (animate) g.style("opacity", 0);
    g.selectAll("path.precinct").data(fc.features, f => f.properties.p).join("path")
      .attr("class", f => "precinct" + (f.properties.p === selPrecinct ? " psel" : ""))
      .attr("d", mapCtx.path)
      .attr("fill", f => { const r = byP.get(f.properties.p) || (pc.byP ? { p: f.properties.p, n: 0 } : null); const v = pc.val(r); return v == null ? "url(#nodata)" : pc.color(v); })
      .on("mousemove", (evt, f) => showTip(evt, `Precinct ${f.properties.p} · ${c ? c.name : ""} County`,
        precinctTipRows(byP.get(f.properties.p)).concat(results24Rows((R24[fips] || {})[f.properties.p], pBallots(byP.get(f.properties.p))))))
      .on("mouseleave", hideTip)
      .on("click", (evt, f) => { evt.stopPropagation(); selPrecinct = f.properties.p; hideTip();
        g.selectAll("path.precinct").classed("psel", d => d.properties.p === selPrecinct).filter(d => d.properties.p === selPrecinct).raise();
        renderSide(); });
    g.selectAll("path.psel").raise();
    if (animate) g.transition().duration(400).style("opacity", 1);
  }

  function precinctTipRows(r) {
    if (!r || !pBallots(r)) return [["Early ballots", "0 so far"]];
    return [
      ["Early ballots", fmt(pBallots(r))],
      ["In person / mail", `${fmt(r.ip)} / ${fmt(r.mail)}`],
      ["R-primary voters", r.n ? pct(100 * r.R / r.n) : "—"],
      ["D-primary voters", r.n ? pct(100 * r.D / r.n) : "—"],
      ["No 2026 primary", r.n ? pct(100 * r.N / r.n) : "—"],
    ];
  }

  document.querySelectorAll("#prec-mode button").forEach(b => b.addEventListener("click", () => {
    precMode = b.dataset.mode;
    document.querySelectorAll("#prec-mode button").forEach(x => x.classList.toggle("active", x === b));
    drawPrecincts(false);
  }));
  document.getElementById("map-back").addEventListener("click", zoomOut);

  // ---------------------------------------------------------------- right-side panel while zoomed
  async function renderSide() {
    const el = document.getElementById("map-side");
    const c = D.counties.find(x => x.fips === zoomFips);
    if (!c) return;
    let data = null, shapes = null;
    try { [data, shapes] = await Promise.all([precinctData(c.fips), precinctGeo(c.fips)]); } catch (e) {}
    if (c.fips !== zoomFips) return;
    const onMap = new Set(shapes ? shapes.features.map(f => f.properties.p) : []);
    const rows = data ? data.rows : [];
    if (selPrecinct) {
      const r = rows.find(x => x.p === selPrecinct);
      const n = pBallots(r);
      const rank = n ? rows.filter(x => pBallots(x) > n).length + 1 : null;
      const t = r ? r.R + r.D + r.X + r.N : 0;
      el.innerHTML = `<button class="btn" id="side-back">← ${c.name} County</button>
        <h2 style="margin-top:14px">${c.name} County</h2><div class="big">Precinct ${selPrecinct}</div>
        ${!r || !n ? `<div class="hint" style="margin-top:8px">No early ballots recorded in this precinct yet.</div>` : `
        <dl>
          <dt>Early ballots</dt><dd>${fmt(n)}</dd>
          <dt>In person</dt><dd>${fmt(r.ip)}</dd>
          <dt>Mail</dt><dd>${fmt(r.mail)}</dd>
          <dt>Share of county's early vote</dt><dd>${pct(share(n, c.total), 2)}</dd>
          <dt>Rank in county</dt><dd>#${rank} of ${rows.filter(x => pBallots(x) > 0).length}</dd>
        </dl>
        <h2 style="margin-top:16px">Primary history of early voters</h2>
        <div class="stack" style="margin-top:8px">${t ? CATS.map(k => { const p = 100 * r[k.k] / t; return `<div style="width:${p}%;background:${k.color()}">${p >= 9 ? pct(p, 0) : ""}</div>`; }).join("") : ""}</div>
        <dl>${CATS.map(k => `<dt><i class="sw" style="background:${k.color()};display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px"></i>${k.label}</dt><dd>${t ? fmt(r[k.k]) + " · " + pct(100 * r[k.k] / t) : "—"}</dd>`).join("")}</dl>
        ${r.oR || r.oD ? `<div class="caveat">Extended history (lower accuracy): of voters with no 2026 primary, ${fmt(r.oR)} last voted in a Republican and ${fmt(r.oD)} in a Democratic primary in 2020–24.</div>` : ""}
        ${r.county_n && r.county_n > r.n ? `<div class="caveat">Ballot count is from the county's own list (${fmt(r.county_n)}); primary history covers the ${fmt(r.n)} voters matched to state voter IDs.</div>` : ""}`}
        ${(R24[c.fips] || {})[selPrecinct] ? `<h2 style="margin-top:16px">2024 results in this precinct</h2><dl>${dlRows(results24Rows(R24[c.fips][selPrecinct], n))}
          <dt>2024 Senate votes cast</dt><dd>${fmt(senTot(R24[c.fips][selPrecinct]))}</dd></dl>` : ""}
        <div class="caveat">Registered voters per precinct aren't published, so turnout % isn't available at this level. "Early ballots vs 2024 Senate votes" compares this year's early vote with the precinct's total 2024 vote instead.</div>`;
      document.getElementById("side-back").addEventListener("click", () => {
        selPrecinct = null; d3.selectAll("#map path.precinct").classed("psel", false); renderSide();
      });
      return;
    }
    const unknown = rows.find(r => r.p === "?");
    const top = rows.filter(r => pBallots(r) > 0 && r.p !== "?").slice().sort((a, b) => pBallots(b) - pBallots(a)).slice(0, 12);
    const off = rows.filter(r => pBallots(r) > 0 && r.p !== "?" && !onMap.has(r.p));
    el.innerHTML = countySummaryHTML(c) + `
      <h2 style="margin-top:16px">Busiest precincts</h2><div class="hint">Click a precinct on the map or below</div>
      <ol class="plist">${top.map(r => `<li data-p="${r.p}"><span class="n">Precinct ${r.p}</span><b>${fmt(pBallots(r))}</b></li>`).join("") || "<li>No precinct data yet</li>"}</ol>
      ${unknown && pBallots(unknown) ? `<div class="caveat">${fmt(pBallots(unknown))} early voters have no precinct listed in the voter list the county or state published, so they can't be placed on the precinct map yet.</div>` : ""}
      ${off.length ? `<div class="caveat">${fmt(d3.sum(off, pBallots))} ballots are in ${off.length} precinct${off.length > 1 ? "s" : ""} not on the 2024 precinct map (new or renumbered since): ${off.slice(0, 12).map(r => r.p).join(", ")}${off.length > 12 ? "…" : ""}</div>` : ""}`;
    el.querySelectorAll(".plist li[data-p]").forEach(li => li.addEventListener("click", () => {
      selPrecinct = li.dataset.p;
      d3.selectAll("#map path.precinct").classed("psel", d => d.properties.p === selPrecinct).filter(d => d.properties.p === selPrecinct).raise();
      renderSide();
    }));
  }

  function rampLegend(stops, lo, hi) {
    return `<span>${lo}</span><span class="ramp" style="background:linear-gradient(90deg,${stops.join(",")})"></span><span>${hi}</span>`;
  }

  function countyTipRows(c) {
    if (c.awaiting) return [["Status", "Awaiting county report"], ["Registered voters", fmt(c.registered)]];
    const p = c.comp ? c.comp.R + c.comp.D + c.comp.X + c.comp.N : 0;
    return [
      ["Region", c.region],
      ["Total ballots", fmt(c.total)],
      ["In person / mail", `${fmt(c.in_person)} / ${fmt(c.mail)}`],
      ["Turnout", pct(c.turnout_pct)],
      [`In person ${D.data_through ? dayShort(D.data_through) : ""}`, c.incomplete ? fmt(c.in_person_day) + " (incomplete)" : c.reported_today ? fmt(c.in_person_day) : "not reported"],
      ["R-primary voters", p ? pct(share(c.comp.R, p)) : "—"],
      ["D-primary voters", p ? pct(share(c.comp.D, p)) : "—"],
      ["No 2026 primary", p ? pct(share(c.comp.N, p)) : "—"],
      ["Pace vs midterm avg", c.cmp && c.cmp.pace_vs_mid ? c.cmp.pace_vs_mid.toFixed(2) + "×" : "—"],
      ["Source", c.source === "county" ? "County website" : "State file"],
    ].concat(R24c[c.fips] ? [["2024 Senate margin", marginTxt(senMargin(R24c[c.fips]), "Cruz ", "Allred ")]] : []);
  }

  // Hide x-axis tick labels that would overlap the previous visible label (narrow screens).
  function thinTicks(g, gap = 6) {
    let lastRight = -Infinity;
    g.selectAll(".tick text").each(function () {
      const b = this.getBBox(), t = this.parentNode.transform.baseVal.consolidate();
      const left = (t ? t.matrix.e : 0) + b.x;
      if (left < lastRight + gap) this.style.display = "none"; else { this.style.display = ""; lastRight = left + b.width; }
    });
  }

  // ---------------------------------------------------------------- bar charts
  function barChart(elId, rows, series, opts = {}) {
    const el = document.getElementById(elId);
    const W = el.clientWidth || 500, H = opts.height || 220, m = { t: 18, r: 8, b: 26, l: 48 };
    const x = d3.scaleBand().domain(rows.map(r => r.date)).range([m.l, W - m.r]).padding(0.22);
    const max = d3.max(rows, r => d3.sum(series, s => r[s.key])) || 1;
    const y = d3.scaleLinear().domain([0, max * 1.12]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).selectAll("svg").data([0]).join("svg").attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(fmtK).tickSize(0)).call(g => g.select(".domain").remove());
    const partialDate = (rows.find(r => r.partial) || {}).date;
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickFormat(d => d === partialDate ? dayShort(d) + " · so far" : dayShort(d)).tickSize(0).tickPadding(8))
      .call(g => g.select(".domain").attr("stroke", "var(--axis)")).call(thinTicks);
    const bw = Math.min(x.bandwidth(), 64), bx = (r) => x(r.date) + (x.bandwidth() - bw) / 2;
    rows.forEach(r => {
      let y0 = 0;
      series.forEach((s, i) => {
        const v = r[s.key] || 0; if (!v) return;
        const top = i === series.length - 1 || !series.slice(i + 1).some(t => r[t.key]);
        svg.append("rect").attr("x", bx(r)).attr("width", bw)
          .attr("y", y(y0 + v)).attr("height", Math.max(0, y(y0) - y(y0 + v) - (y0 ? 2 : 0)))
          .attr("rx", top ? 3 : 0).attr("fill", s.color).attr("fill-opacity", r.partial ? 0.38 : 1)
          .attr("stroke", r.partial ? s.color : null).attr("stroke-dasharray", r.partial ? "4 3" : null);
        y0 += v;
      });
      if (opts.labels) svg.append("text").attr("class", "dlabel").attr("text-anchor", "middle")
        .attr("x", x(r.date) + x.bandwidth() / 2).attr("y", y(y0) - 5).text(fmtK(y0));
      svg.append("rect").attr("x", x(r.date) - x.step() * x.paddingInner() / 2).attr("width", Math.max(0, x.step())).attr("y", m.t).attr("height", H - m.t - m.b)
        .attr("fill", "transparent")
        .on("mousemove", evt => showTip(evt, dayLong(r.date) + (r.partial ? " · still coming in" : ""), series.map(s => [s.label, fmt(r[s.key] || 0)]).concat(series.length > 1 ? [["Total", fmt(d3.sum(series, s => r[s.key] || 0))]] : [])))
        .on("mouseleave", hideTip);
    });
  }

  function renderCum() {
    // Mail ballots start arriving before in-person voting opens; fold them into day 1 rather than
    // showing separate pre-voting days.
    const start = D.election.ev_in_person_start;
    const pre = D.daily.filter(r => r.date < start).slice(-1)[0];
    document.getElementById("cum-hint").textContent = "Statewide ballots by day of early voting, in-person and mail" +
      (pre ? ` · includes ${fmt(pre.total_cum)} mail ballots received before early voting opened ${dayShort(start)}` : "");
    barChart("chart-cum", D.daily.filter(r => r.date >= start), [
      { key: "in_person_cum", label: "In person", color: C.inperson },
      { key: "mail_cum", label: "Mail", color: C.mail },
    ], { labels: true, height: 210 });
  }

  function renderDaily() {
    const rows = D.daily.filter(r => r.date >= D.election.ev_in_person_start);
    barChart("chart-daily", rows, [{ key: "in_person_day", label: "In-person votes", color: C.inperson }], { labels: true, height: 170 });
  }

  // ---------------------------------------------------------------- composition
  const CATS = [
    { k: "R", label: "Republican primary", color: () => C.rep },
    { k: "D", label: "Democratic primary", color: () => C.dem },
    { k: "X", label: "Both primaries", color: () => C.both },
    { k: "N", label: "No 2026 primary", color: () => C.none },
  ];

  function renderComp() {
    const comp = D.statewide.comp, tot = D.statewide.roster_total;
    document.getElementById("comp-bar").innerHTML = tot ? CATS.map(c => {
      const p = share(comp[c.k], tot);
      return `<div style="width:${p}%;background:${c.color()}" title="${c.label}: ${fmt(comp[c.k])}">${p >= 6 ? pct(p, 0) : ""}</div>`;
    }).join("") : `<div style="width:100%;background:var(--surface-3);color:var(--text-muted)">Voter roster not loaded yet</div>`;
    document.getElementById("comp-legend").innerHTML = CATS.map(c => `
      <div class="item" style="border-left:4px solid ${c.color()}"><div class="k">${c.label}</div>
      <div class="v num">${tot ? pct(share(comp[c.k], tot)) : "—"}</div><div class="s num">≈ ${fmt(comp[c.k] || 0)} voters</div></div>`).join("")
      + (tot ? `<div class="comp-cov">Based on ${fmt(D.statewide.listed_total)} early voters on the state and county voter lists so far (${pct(share(D.statewide.listed_total, D.statewide.total), 0)} of ballots). Each county is weighted by its actual ballots, in person and mail separately, so counties whose lists are behind aren't under-counted.</div>` : "");
    const pool = D.primary_pool, voted = D.primary_voted;
    document.getElementById("pool").innerHTML = D.status.history_loaded ? `
      <div class="p" style="border-color:var(--rep)"><div class="v num">${pct(share(voted.R, pool.R))}</div>
        <div class="k">of 2026 Republican primary voters have voted early (${fmt(voted.R)} of ${fmt(pool.R)})</div></div>
      <div class="p" style="border-color:var(--dem)"><div class="v num">${pct(share(voted.D, pool.D))}</div>
        <div class="k">of 2026 Democratic primary voters have voted early (${fmt(voted.D)} of ${fmt(pool.D)})</div></div>`
      : `<div class="caveat">Primary history is still loading from the state…</div>`;
  }

  function renderCompDaily() {
    const el = document.getElementById("chart-comp-daily");
    // Pre-voting mail ballots are combined into one "mail before" point so the axis starts at early voting.
    const start = D.election.ev_in_person_start;
    const preRows = D.daily_comp.filter(r => r.date < start);
    const pre = preRows.reduce((a, r) => ({ date: "pre", R: a.R + r.R, D: a.D + r.D, X: a.X + r.X, N: a.N + r.N }), { date: "pre", R: 0, D: 0, X: 0, N: 0 });
    const rows = [...(preRows.length ? [pre] : []), ...D.daily_comp.filter(r => r.date >= start)]
      .map(r => ({ ...r, n: r.R + r.D + r.X + r.N })).filter(r => r.n >= 500);
    const series = CATS.slice(0, 2).concat([CATS[3]]);
    document.getElementById("comp-daily-legend").innerHTML = series.map(s => `<span><i class="sw" style="background:${s.color()}"></i>${s.label}</span>`).join("");
    const W = el.clientWidth || 500, H = 250, m = { t: 14, r: 120, b: 26, l: 40 };
    const svg = d3.select(el).selectAll("svg").data([0]).join("svg").attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();
    if (rows.length < 1) { svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle").attr("fill", "var(--text-muted)").text("Waiting for voter roster data"); return; }
    const x = d3.scalePoint().domain(rows.map(r => r.date)).range([m.l, W - m.r]).padding(0.5);
    const lbl = (d) => d === "pre" ? "Mail before" : dayShort(d);
    const y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d => d + "%").tickSize(0)).call(g => g.select(".domain").remove());
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat(lbl).tickSize(0).tickPadding(8)).call(g => g.select(".domain").attr("stroke", "var(--axis)")).call(thinTicks);
    const last = rows[rows.length - 1], ends = [];
    series.forEach(s => {
      const pts = rows.map(r => [x(r.date), y(100 * r[s.k] / r.n)]);
      svg.append("path").attr("d", d3.line()(pts)).attr("fill", "none").attr("stroke", s.color()).attr("stroke-width", 2);
      svg.selectAll(null).data(pts).join("circle").attr("cx", d => d[0]).attr("cy", d => d[1]).attr("r", 4).attr("fill", s.color()).attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
      ends.push({ y: pts[pts.length - 1][1], text: `${pct(100 * last[s.k] / last.n, 0)} ${s.k === "N" ? "No primary" : s.k === "R" ? "R-primary" : "D-primary"}`, color: s.color() });
    });
    // keep end labels from overlapping
    ends.sort((a, b) => a.y - b.y);
    ends.forEach((e, i) => { if (i && e.y - ends[i - 1].y < 15) e.y = ends[i - 1].y + 15; });
    ends.forEach(e => svg.append("text").attr("class", "dlabel").attr("x", W - m.r + 10).attr("y", e.y + 4).text(e.text));
    rows.forEach(r => svg.append("rect").attr("x", x(r.date) - Math.max(0, x.step()) / 2).attr("width", Math.max(0, x.step())).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", evt => showTip(evt, r.date === "pre" ? "Mail ballots received before early voting" : `New voters ${dayLong(r.date)}`, [["Voters added", fmt(r.n)]].concat(CATS.map(c => [c.label, pct(100 * r[c.k] / r.n)]))))
      .on("mouseleave", hideTip));
  }

  // ---------------------------------------------------------------- pace vs past elections
  document.querySelectorAll("#pace-basis button").forEach(b => b.addEventListener("click", () => {
    paceBasis = b.dataset.basis;
    document.querySelectorAll("#pace-basis button").forEach(x => x.classList.toggle("active", x === b));
    renderPace();
  }));
  const paceX = (x) => x == null ? "—" : `<span class="pace-x ${x >= 1 ? "up" : "down"}">${x.toFixed(2)}×</span>`;

  function renderPace() {
    const cmp = D.compare;
    const el = document.getElementById("chart-pace");
    if (!cmp) { el.innerHTML = `<div class="caveat">Past-election data is still loading…</div>`; return; }
    const S = cmp.summary[paceBasis], cv = cmp.curves[paceBasis], N = cmp.current_day;
    const years = paceBasis === "common" ? ["2014", "2016", "2018", "2020", "2022", "2024"] : ["2020", "2022", "2024"];
    const midYears = years.filter(y => ["2014", "2018", "2022"].includes(y)), presYears = years.filter(y => !midYears.includes(y));
    const actual = paceBasis === "common" ? null : D.statewide.total;
    document.getElementById("pace-stats").innerHTML = `
      <div class="pace-stat main"><div class="k">2026 after day ${N}</div><div class="v num">${pct(S.rate_2026, 2)}</div>
        <div class="s">of registered voters have voted early</div></div>
      <div class="pace-stat"><div class="k">Midterm average (${midYears.join(", ")})</div><div class="v num">${pct(S.mid_avg, 2)}</div>
        <div class="s">2026 is running ${paceX(S.pace_vs_mid)} the midterm pace${S.expected_mid ? ` · ${fmt(S.expected_mid)} ballots expected at that pace` : ""}</div></div>
      <div class="pace-stat"><div class="k">Presidential average (${presYears.join(", ")})</div><div class="v num">${pct(S.pres_avg, 2)}</div>
        <div class="s">2026 is running ${paceX(S.pace_vs_pres)} the presidential pace</div></div>
      <div class="pace-stat"><div class="k">Same day in each year</div>
        <div class="s">${years.map(y => `${y}: <b class="num">${pct(S.by_year[y], 2)}</b>`).join(" · ")}</div></div>`;
    document.getElementById("pace-caveat").textContent = paceBasis === "common"
      ? `Uses the 15 largest counties (${cmp.common_share_rv}% of today's registered voters), the only counties the state reported daily in every election since 2014. Each year is measured against that year's registered voters, which accounts for population growth. Averages give each election equal weight.`
      : `All 254 counties. The state only published every county's daily numbers starting in 2020, so the midterm average here is 2022 alone. 2020 had an extended 18-day early-voting period (COVID); it is aligned on the first day of voting.`;

    // chart
    const W = el.clientWidth || 700, H = W < 480 ? 260 : 300, m = { t: 14, r: W < 480 ? 96 : 110, b: 28, l: 40 };
    const svg = d3.select(el).selectAll("svg").data([0]).join("svg").attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();
    const days = d3.range(1, 13);
    const all = [...years, "mid_avg", "pres_avg", "2026"].flatMap(k => cv[k] || []).filter(v => v != null);
    const x = d3.scaleLinear().domain([1, 12]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, (d3.max(all) || 1) * 1.08]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d => d + "%").tickSize(0)).call(g => g.select(".domain").remove());
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(W < 480 ? [1, 3, 5, 7, 9, 11] : d3.range(1, 13)).tickFormat(d => W < 640 && d > 1 ? d : "Day " + d).tickSize(0).tickPadding(8)).call(g => g.select(".domain").attr("stroke", "var(--axis)")).call(thinTicks);
    const line = d3.line().defined(v => v != null).x((v, i) => x(i + 1)).y(v => y(v));
    const styles = [
      ...years.map(yr => ({ k: yr, color: midYears.includes(yr) ? C["past-mid"] : C["past-pres"], w: 1.25, dash: midYears.includes(yr) ? null : "3 3", label: yr })),
      { k: "mid_avg", color: C["avg-mid"], w: 2.5, dash: "7 4", label: "Midterm avg" },
      { k: "pres_avg", color: C["avg-pres"], w: 2.5, dash: "7 4", label: "Presidential avg" },
      { k: "2026", color: C.accent, w: 3.5, dash: null, label: "2026" },
    ];
    const ends = [];
    styles.forEach(st => {
      const vals = cv[st.k] || [];
      svg.append("path").attr("d", line(vals)).attr("fill", "none").attr("stroke", st.color).attr("stroke-width", st.w)
        .attr("stroke-dasharray", st.dash).attr("stroke-linecap", "round");
      const li = vals.reduce((a, v, i) => v != null ? i : a, -1);
      if (li >= 0) ends.push({ y: y(vals[li]), x: x(li + 1), text: st.label, color: st.k === "2026" || st.k.endsWith("avg") ? "var(--text-primary)" : "var(--text-muted)", k: st.k });
    });
    const v26 = cv["2026"] || [];
    v26.forEach((v, i) => { if (v != null) svg.append("circle").attr("cx", x(i + 1)).attr("cy", y(v)).attr("r", 5).attr("fill", C.accent).attr("stroke", "var(--surface-1)").attr("stroke-width", 2); });
    // end labels at right edge for full lines; 2026 labeled at its last point
    const right = ends.filter(e => e.k !== "2026").map(e => ({ ...e, y: y((cv[e.k] || [])[11] ?? 0) })).sort((a, b) => a.y - b.y);
    right.forEach((e, i) => { if (i && e.y - right[i - 1].y < 13) e.y = right[i - 1].y + 13; });
    right.forEach(e => svg.append("text").attr("class", "dlabel").attr("x", W - m.r + 8).attr("y", e.y + 4).attr("fill", e.color).style("fill", e.color).text(e.text));
    const e26 = ends.find(e => e.k === "2026");
    if (e26) svg.append("text").attr("class", "dlabel").attr("x", e26.x + 10).attr("y", e26.y - 8).style("fill", C.accent).style("font-weight", 800).text(`2026: ${pct(v26.filter(v => v != null).slice(-1)[0], 2)}`);
    // hover
    days.forEach(dn => svg.append("rect").attr("x", x(dn) - Math.max(0, x(2) - x(1)) / 2).attr("width", Math.max(0, x(2) - x(1))).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", evt => showTip(evt, `Day ${dn} of early voting`, styles.slice().reverse().map(st => [st.label, cv[st.k] && cv[st.k][dn - 1] != null ? pct(cv[st.k][dn - 1], 2) : "—"])))
      .on("mouseleave", hideTip));
    document.getElementById("pace-legend").innerHTML =
      `<span><i class="sw" style="background:${C.accent}"></i>2026</span><span><i class="sw" style="background:${C["avg-mid"]}"></i>Midterm average</span>` +
      `<span><i class="sw" style="background:${C["avg-pres"]}"></i>Presidential average</span><span><i class="sw" style="background:${C["past-mid"]}"></i>Individual midterms</span>` +
      `<span><i class="sw" style="background:repeating-linear-gradient(90deg,${C["past-pres"]} 0 3px,transparent 3px 6px)"></i>Individual presidentials</span>`;
  }

  // ---------------------------------------------------------------- sources check
  function renderSources() {
    const el = document.getElementById("sources");
    if (!D.sources) { el.innerHTML = ""; return; }
    const diff = (a, b) => a != null && b != null ? (b - a >= 0 ? "+" : "") + fmt(b - a) : "—";
    el.innerHTML = `<table><thead><tr><th>County</th><th>State: in person</th><th>County site: in person</th><th>Difference</th>
      <th>State: mail</th><th>County site: mail</th><th>Newest county day</th><th>County report time</th><th>County # last changed</th><th>State # last changed</th><th>Using</th><th>Feed status</th></tr></thead><tbody>
      ${D.sources.map(s => {
        const st = s.status || {};
        const status = !s.has_feed ? `<span class="muted">${s.pending_reason || "No county feed yet"}</span>`
          : st.ok ? `<span class="ok-txt">OK</span> <span class="muted">${st.checked ? ago(st.checked) : ""}</span>`
          : st.error ? `<span class="bad-txt" title="${(st.error || "").replace(/"/g, "'")}">Error</span>` : '<span class="muted">Not checked yet</span>';
        return `<tr><td><b>${s.county}</b></td><td>${s.state_in_person != null ? fmt(s.state_in_person) : "—"}</td>
          <td>${s.county_in_person != null ? fmt(s.county_in_person) : "—"}</td><td>${diff(s.state_in_person, s.county_in_person)}</td>
          <td>${s.state_mail != null ? fmt(s.state_mail) : "—"}</td><td>${s.county_mail != null ? fmt(s.county_mail) : "—"}</td>
          <td>${s.county_latest_date ? dayShort(s.county_latest_date) + (s.live_today ? ` · ${fmt(s.live_today)} so far today` : "") : "—"}</td>
          <td>${s.county_report_time ? shortCT(s.county_report_time) : '<span class="muted">not stated</span>'}</td>
          <td>${shortCT(s.county_changed)}</td><td>${shortCT(s.state_changed)}</td>
          <td>${s.used === "county" ? '<span class="src-badge">County site</span>' : '<span class="muted">State</span>'}</td><td>${status}</td></tr>`;
      }).join("")}</tbody></table>`;
  }

  // ---------------------------------------------------------------- regions
  function minibar(comp) {
    const t = comp ? comp.R + comp.D + comp.X + comp.N : 0;
    if (!t) return `<span class="minibar"></span>`;
    return `<span class="minibar">${CATS.map(c => `<i style="width:${100 * comp[c.k] / t}%;background:${c.color()}"></i>`).join("")}</span>`;
  }
  const compPct = (comp, k) => { const t = comp ? comp.R + comp.D + comp.X + comp.N : 0; return t ? pct(100 * comp[k] / t) : "—"; };

  function renderRegions() {
    document.getElementById("regions").innerHTML = `<table><thead><tr>
      <th>Region</th><th>Counties</th><th>Registered</th><th>Ballots</th><th>Share of state</th><th>Turnout</th><th>Primary mix</th><th>R-primary</th><th>D-primary</th><th>No primary</th></tr></thead><tbody>
      ${D.regions.map(r => `<tr><td><b>${r.name}</b></td><td>${r.counties}</td><td>${fmt(r.registered)}</td><td>${fmt(r.total)}</td>
        <td>${pct(r.share_of_state)}</td><td>${pct(r.turnout_pct)}</td><td>${minibar(r.comp)}</td>
        <td>${compPct(r.comp, "R")}</td><td>${compPct(r.comp, "D")}</td><td>${compPct(r.comp, "N")}</td></tr>`).join("")}
      </tbody></table>`;
  }

  // ---------------------------------------------------------------- leaderboards
  function renderLeaders() {
    const big = D.counties.filter(c => c.registered >= 25000);
    const boards = [
      { t: "Highest turnout", h: "Counties with 25K+ registered voters", list: [...big].sort((a, b) => b.turnout_pct - a.turnout_pct), v: c => pct(c.turnout_pct) },
      { t: "Most ballots", h: "Total early ballots", list: [...D.counties].sort((a, b) => b.total - a.total), v: c => fmt(c.total) },
      { t: "Biggest latest day", h: `In-person votes on ${D.data_through ? dayShort(D.data_through) : "—"}`, list: [...D.counties].sort((a, b) => b.in_person_day - a.in_person_day), v: c => fmt(c.in_person_day) },
      { t: "Missing or incomplete", h: `In-person votes for ${D.data_through ? dayShort(D.data_through) : "—"} not yet in the state file`, list: D.counties.filter(c => !c.reported_today).sort((a, b) => b.registered - a.registered), v: c => (c.incomplete ? "incomplete · " : "") + fmtK(c.registered) + " reg." },
    ];
    document.getElementById("leaders").innerHTML = boards.map(b => `
      <div class="card leader"><h2>${b.t}</h2><div class="hint">${b.h}</div>
      <ol>${b.list.slice(0, 10).map(c => `<li data-fips="${c.fips}"><span class="n">${c.name}</span><b>${b.v(c)}</b></li>`).join("") || `<li><span class="n">None</span></li>`}</ol></div>`).join("");
    document.querySelectorAll("#leaders li[data-fips]").forEach(li => li.addEventListener("click", () => zoomTo(li.dataset.fips)));
  }

  // ---------------------------------------------------------------- counties view
  const COLS = [
    { k: "name", t: "County", f: c => `<b>${c.name}</b>${c.source === "county" ? ' <span class="src-badge" title="Using the county website\'s numbers">county site</span>' : ""}${statusPill(c)}` },
    { k: "region", t: "Region", f: c => c.region },
    { k: "registered", t: "Registered", f: c => fmt(c.registered) },
    { k: "in_person", t: "In person", f: c => fmt(c.in_person) },
    { k: "mail", t: "Mail", f: c => fmt(c.mail) },
    { k: "total", t: "Total", f: c => `<b>${fmt(c.total)}</b>` },
    { k: "turnout_pct", t: "Turnout", f: c => c.awaiting ? "—" : pct(c.turnout_pct) },
    { k: "in_person_day", t: "Latest day", f: c => fmt(c.in_person_day) },
    { k: "upd", t: "Updated", f: c => { const t = [c.county_changed, c.state_changed].filter(Boolean).sort().slice(-1)[0];
        return t ? `<span title="State numbers last changed ${shortCT(c.state_changed)}${c.county_changed ? " · county site last changed " + shortCT(c.county_changed) : ""}${c.county_report_time ? " · county report stamped " + shortCT(c.county_report_time) : ""}">${shortCT(t)}</span>` : "—"; },
      s: c => [c.county_changed, c.state_changed].filter(Boolean).sort().slice(-1)[0] || "" },
    { k: "sen24", t: "2024 Sen", f: c => marginTxt(senMargin(R24c[c.fips])), s: c => senMargin(R24c[c.fips]) ?? -9 },
    { k: "pace", t: "vs Mid avg", f: c => c.cmp && c.cmp.pace_vs_mid ? paceX(c.cmp.pace_vs_mid) : "—", s: c => c.cmp && c.cmp.pace_vs_mid || -1 },
    { k: "r22", t: "2022 same day", f: c => c.cmp && c.cmp.rates["2022"] != null ? pct(c.cmp.rates["2022"]) : "—", s: c => c.cmp && c.cmp.rates["2022"] || -1 },
    { k: "mix", t: "Primary mix", f: c => minibar(c.comp), s: c => leanOf(c) ?? -9 },
    { k: "R", t: "R-prim.", f: c => compPct(c.comp, "R"), s: c => c.comp ? c.comp.R / (c.comp.R + c.comp.D + c.comp.X + c.comp.N || 1) : -1 },
    { k: "D", t: "D-prim.", f: c => compPct(c.comp, "D"), s: c => c.comp ? c.comp.D / (c.comp.R + c.comp.D + c.comp.X + c.comp.N || 1) : -1 },
  ];
  function statusPill(c) {
    if (c.awaiting) return ` <span class="pill warn" title="The state has almost no early-vote data for this county yet">awaiting report</span>`;
    if (c.incomplete) return ` <span class="pill warn" title="The state file has far fewer votes for this county than expected; the county's upload is probably late">incomplete</span>`;
    if (!c.reported_today) return ` <span class="pill warn" title="No in-person votes reported for the latest day">late</span>`;
    return "";
  }
  const regionSel = document.getElementById("county-region");
  document.getElementById("county-search").addEventListener("input", renderCounties);
  regionSel.addEventListener("change", renderCounties);

  function renderCounties() {
    if (!R24) { loadR24().then(renderCounties); return; }
    if (regionSel.options.length === 1) D.regions.forEach(r => regionSel.add(new Option(r.name, r.name)));
    const q = document.getElementById("county-search").value.trim().toLowerCase();
    const reg = regionSel.value;
    const col = COLS.find(c => c.k === sortKey);
    const sv = col.s || (c => c[sortKey]);
    const rows = D.counties.filter(c => (!q || c.name.toLowerCase().includes(q)) && (!reg || c.region === reg))
      .sort((a, b) => { const x = sv(a), y = sv(b); return (typeof x === "string" ? x.localeCompare(y) : (x ?? -1) - (y ?? -1)) * sortDir; });
    document.getElementById("county-count").textContent = `${rows.length} counties`;
    const tbl = document.getElementById("county-table");
    tbl.innerHTML = `<thead><tr>${COLS.map(c => `<th data-k="${c.k}" class="${c.k === sortKey ? "sorted" : ""}">${c.t}${c.k === sortKey ? (sortDir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(c => `<tr data-fips="${c.fips}" ${c.fips === selected ? 'style="background:var(--surface-3)"' : ""}>${COLS.map(col => `<td>${col.f(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    tbl.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      if (sortKey === th.dataset.k) sortDir *= -1; else { sortKey = th.dataset.k; sortDir = ["name", "region"].includes(sortKey) ? 1 : -1; }
      renderCounties();
    }));
    tbl.querySelectorAll("tbody tr").forEach(tr => tr.addEventListener("click", () => { selected = tr.dataset.fips; renderCounties(); }));
    renderDetail();
  }

  function renderDetail() {
    const el = document.getElementById("county-detail");
    const c = D.counties.find(x => x.fips === selected);
    if (!c) { el.innerHTML = `<h2>County detail</h2><div class="hint">Select a county from the table or the map</div>`; return; }
    el.innerHTML = countySummaryHTML(c) + `<button class="btn" id="open-map" style="margin-top:12px">Show precinct map</button>
      <h2 style="margin-top:16px">Precincts</h2><div id="precincts"><div class="caveat">Loading precincts…</div></div>`;
    document.getElementById("open-map").addEventListener("click", () => { switchView("ev"); setTimeout(() => zoomTo(c.fips), 50); });
    renderPrecincts(c);
  }

  const listedN = (c) => c.comp_listed ? c.comp_listed.R + c.comp_listed.D + c.comp_listed.X + c.comp_listed.N : 0;
  function countySummaryHTML(c) {
    const stateShare = share(c.total, D.statewide.total);
    const t = c.comp ? c.comp.R + c.comp.D + c.comp.X + c.comp.N : 0;
    if (c.awaiting) return `<h2>${c.region}</h2><div class="big">${c.name} County</div>
      <div class="banner" style="margin:12px 0"><b>Awaiting county report.</b> The state's files have only ${fmt(c.total)} early ${c.total === 1 ? "ballot" : "ballots"} for ${c.name} County (${fmt(c.registered)} registered voters), and the county doesn't publish its own turnout online. It will fill in once ${c.name} County uploads to the state.</div>
      <dl><dt>Registered voters</dt><dd>${fmt(c.registered)}</dd>
      ${R24c[c.fips] ? dlRows(results24Rows(R24c[c.fips])) : ""}</dl>`;
    return `<h2>${c.region}</h2><div class="big">${c.name} County</div>
      <dl>
        <dt>Total early ballots</dt><dd>${fmt(c.total)}</dd>
        <dt>In person</dt><dd>${fmt(c.in_person)}</dd>
        <dt>Mail</dt><dd>${fmt(c.mail)}</dd>
        <dt>Registered voters</dt><dd>${fmt(c.registered)}</dd>
        <dt>Turnout so far</dt><dd>${pct(c.turnout_pct)}</dd>
        <dt>Share of statewide vote</dt><dd>${pct(stateShare, 2)}</dd>
        <dt>In person on ${D.data_through ? dayShort(D.data_through) : "latest day"}</dt><dd>${c.incomplete ? fmt(c.in_person_day) + ' <span class="pill warn">incomplete</span>' : c.reported_today ? fmt(c.in_person_day) : '<span class="pill warn">not reported</span>'}</dd>
        <dt>Change ${sinceLabel()}</dt><dd>${c.prev_total != null ? "+" + fmt(c.total - c.prev_total) : "—"}</dd>
      </dl>
      ${c.cmp ? `<h2 style="margin-top:16px">Pace vs. past elections (day ${D.compare.current_day})</h2>
      <dl>${["2026", "2024", "2022", "2020", "2018", "2016", "2014"].filter(y => c.cmp.rates[y] != null).map(y => `<dt>${y}${y === "2026" ? " (now)" : ["2014", "2018", "2022"].includes(y) ? " · midterm" : " · presidential"}</dt><dd>${pct(c.cmp.rates[y], 2)}</dd>`).join("")}
        <dt>Midterm average (${c.cmp.mid_years.join(", ")})</dt><dd>${c.cmp.mid_avg != null ? pct(c.cmp.mid_avg, 2) : "—"} · ${paceX(c.cmp.pace_vs_mid)}</dd>
        <dt>Presidential average</dt><dd>${c.cmp.pres_avg != null ? pct(c.cmp.pres_avg, 2) : "—"} · ${paceX(c.cmp.pace_vs_pres)}</dd></dl>` : ""}
      ${c.source === "county" ? `<div class="caveat">Using the county website's numbers (state file shows ${fmt(c.state_total)} total).</div>` : ""}
      <div class="upd-line">State numbers last changed ${shortCT(c.state_changed)}${c.county_changed ? ` · county site last changed ${shortCT(c.county_changed)}` : ""}${c.county_report_time ? ` · county report stamped ${shortCT(c.county_report_time)}` : ""}</div>
      ${R24c[c.fips] ? `<h2 style="margin-top:16px">2024 results (for context)</h2><dl>${dlRows(results24Rows(R24c[c.fips], c.total))}
        <dt>2024 Senate votes cast</dt><dd>${fmt(senTot(R24c[c.fips]))}</dd></dl>` : ""}
      <h2 style="margin-top:16px">Primary history of early voters</h2>
      <div class="stack" style="margin-top:8px">${t ? CATS.map(k => { const p = 100 * c.comp[k.k] / t; return `<div style="width:${p}%;background:${k.color()}">${p >= 9 ? pct(p, 0) : ""}</div>`; }).join("") : ""}</div>
      <dl>${CATS.map(k => `<dt><i class="sw" style="background:${k.color()};display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px"></i>${k.label}</dt><dd>${t ? pct(100 * c.comp[k.k] / t) + (c.comp_listed ? ` · ${fmt(c.comp_listed[k.k])} listed` : "") : "—"}</dd>`).join("")}</dl>
      ${listedN(c) ? `<div class="caveat">${fmt(listedN(c))} of ${fmt(c.total)} early voters (${pct(share(listedN(c), c.total), 0)}) are on the voter lists so far; shares are weighted to all ballots, in person and mail separately.</div>` : ""}`;
  }

  // ---------------------------------------------------------------- precincts
  let precSort = "n", precDir = -1;
  const precCache = {};
  async function renderPrecincts(c) {
    const el = document.getElementById("precincts");
    if (!el) return;
    let data = precCache[c.fips];
    if (!data || data._for !== D.generated_at) {
      try { data = await (await fetch(`data/precincts/${c.fips}.json?t=${Date.now()}`, { cache: "no-store" })).json(); }
      catch (e) { el.innerHTML = `<div class="caveat">Precinct data not available yet.</div>`; return; }
      data._for = D.generated_at;
      precCache[c.fips] = data;
    }
    if (selected !== c.fips) return;
    const ballots = r => Math.max(r.n, r.county_n || 0);
    const rows = data.rows.slice().sort((a, b) => {
      const v = (r) => precSort === "p" ? (isNaN(+r.p) ? r.p : +r.p) : precSort === "n" ? ballots(r) : precSort === "R" || precSort === "D" || precSort === "N" ? (r.n ? r[precSort] / r.n : -1) : r[precSort];
      const x = v(a), y = v(b);
      return (typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y) * precDir;
    });
    const cols = [["p", "Precinct"], ["n", "Ballots"], ["ip", "In person"], ["mail", "Mail"], ["mix", "Primary mix"], ["R", "R-prim."], ["D", "D-prim."], ["N", "No prim."]];
    el.innerHTML = `<div class="hint">${data.rows.length} precincts · counted from voter lists${data.has_county_list ? " (state roster plus the county's own list)" : " (state roster)"}. Registered voters per precinct aren't published, so turnout % isn't shown.</div>
      <div class="table-scroll" style="max-height:420px"><table class="prec"><thead><tr>${cols.map(([k, t]) => `<th data-k="${k}" class="${k === precSort ? "sorted" : ""}">${t}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${r.p === "?" ? "No precinct listed" : r.p}</b></td><td>${fmt(ballots(r))}${r.county_n && r.county_n > r.n ? ' <span class="src-badge" title="Count from the county list; primary mix uses the voters matched to state IDs">county</span>' : ""}</td>
        <td>${fmt(r.ip)}</td><td>${fmt(r.mail)}</td><td>${minibar(r)}</td>
        <td>${r.n ? pct(100 * r.R / r.n, 0) : "—"}</td><td>${r.n ? pct(100 * r.D / r.n, 0) : "—"}</td><td>${r.n ? pct(100 * r.N / r.n, 0) : "—"}</td></tr>`).join("")}
      </tbody></table></div>`;
    el.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      if (th.dataset.k === "mix") return;
      if (precSort === th.dataset.k) precDir *= -1; else { precSort = th.dataset.k; precDir = th.dataset.k === "p" ? 1 : -1; }
      renderPrecincts(c);
    }));
  }

  // ---------------------------------------------------------------- extended primary history
  const EXT = [
    { k: "R", label: "R primary 2026", color: () => C.rep },
    { k: "oR", label: "R primary 2020–24 only", color: () => "#f29a9d" },
    { k: "X", label: "Both 2026", color: () => C.both }, { k: "oX", label: "Both 2020–24", color: () => "#c4bdf3" },
    { k: "oD", label: "D primary 2020–24 only", color: () => "#93bbf8" },
    { k: "D", label: "D primary 2026", color: () => C.dem },
    { k: "N", label: "No primary 2020–26", color: () => C.none },
  ];
  function renderExtended() {
    const el = document.getElementById("ext");
    const e = D.extended;
    if (!e || !e.available) {
      const pr = e && e.progress;
      el.innerHTML = `<div class="caveat">Downloading 2020–2024 primary voter lists from the state (${pr && pr.total ? `${fmt(pr.done)} of ${fmt(pr.total)} county files` : "starting"}). This runs once in the background.</div>`;
      return;
    }
    const s = e.statewide, tot = d3.sum(EXT, c => s[c.k] || 0);
    const pctOf = k => tot ? 100 * (s[k] || 0) / tot : 0;
    const r = pctOf("R") + pctOf("oR"), d = pctOf("D") + pctOf("oD"), n = pctOf("N"), n26 = pctOf("oR") + pctOf("oD") + pctOf("oX") + pctOf("N");
    el.innerHTML = `
      <div class="stack">${EXT.map(c => { const p = pctOf(c.k); return `<div style="width:${p}%;background:${c.color()}" title="${c.label}: ≈ ${fmt(s[c.k] || 0)}">${p >= 6 ? pct(p, 0) : ""}</div>`; }).join("")}</div>
      <div class="comp-legend" style="grid-template-columns:repeat(3,1fr)">
        <div class="item" style="border-left:4px solid var(--rep)"><div class="k">Republican primary history</div><div class="v num">${pct(r)}</div><div class="s">${pct(pctOf("R"))} from 2026 + ${pct(pctOf("oR"))} from 2020–24</div></div>
        <div class="item" style="border-left:4px solid var(--dem)"><div class="k">Democratic primary history</div><div class="v num">${pct(d)}</div><div class="s">${pct(pctOf("D"))} from 2026 + ${pct(pctOf("oD"))} from 2020–24</div></div>
        <div class="item" style="border-left:4px solid var(--none)"><div class="k">No primary since 2020</div><div class="v num">${pct(n)}</div><div class="s">down from ${pct(n26)} using 2026 alone</div></div>
      </div>
      <div class="legend">${EXT.map(c => `<span><i class="sw" style="background:${c.color()}"></i>${c.label}</span>`).join("")}</div>
      ${e.progress && e.progress.running ? `<div class="caveat">Still loading: ${fmt(e.progress.done)} of ${fmt(e.progress.total)} county files. Numbers will shift until it finishes.</div>` : ""}`;
  }

  // ================================================================ ELECTION DAY (live results)
  // Renders from data/results.json, which the desktop service rewrites from the state's results feed after
  // checking it (see collector/results.py). Shows only reported votes: no projections.
  let RES = null, raceKey = null, edayMode = "margin", edayAll = false, edayQuery = "";
  const REHEARSAL = new URLSearchParams(location.search).has("rehearsal");   // tools/rehearse.py output, local only
  try { raceKey = localStorage.getItem("race"); } catch (e) {}
  async function loadResults() {
    try {
      const r = await fetch((REHEARSAL ? "data/rehearsal-results.json" : "data/results.json") + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const changed = !RES || j.checked_at !== RES.checked_at || j.status !== RES.status;
      RES = j;
      if (changed && document.getElementById("view-eday").classList.contains("active")) renderEday();
    } catch (e) {
      if (!RES) RES = { status: "unreachable" };
    }
  }
  const titleCase = s => (s || "").toLowerCase().replace(/(^|[\s\-'"(.])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bIii\b/, "III").replace(/\(i\)/i, "(I)");
  const candShort = c => titleCase(c.last || c.name);
  const candFull = c => titleCase(c.name).replace(/\s*\(I\)$/, "") + (/\(I\)\s*$/.test(c.name) ? " (inc.)" : "");
  const partyLabel = p => ({ REP: "Republican", DEM: "Democrat", LIB: "Libertarian", GRE: "Green", IND: "Independent", W: "Write-in" })[p] || p || "";
  const partyColor = p => p === "REP" ? C.rep : p === "DEM" ? C.dem : C.none;
  const raceList = () => (RES && RES.races) || [];
  const currentRace = () => { const rs = raceList(); return rs.find(r => r.key === raceKey && r.found) || rs.find(r => r.found) || null; };
  // The two candidates the race is about: the top two by votes once votes exist, else the REP and DEM nominees.
  function mainPair(r) {
    const cs = r.candidates.map((c, i) => ({ ...c, i }));
    return r.total ? [...cs].sort((a, b) => b.votes - a.votes).slice(0, 2) : cs.slice(0, 2);
  }
  // Republican-minus-Democrat margin in a county (share of all votes), for map colors.
  // In a race without both a Republican and a Democrat (a primary runoff, say), the top two stand in.
  const repDemIdx = r => {
    const ri = r.candidates.findIndex(c => c.party === "REP"), di = r.candidates.findIndex(c => c.party === "DEM");
    if (ri >= 0 && di >= 0) return [ri, di];
    const [a, b] = mainPair(r); return [a.i, b.i];
  };
  const cMargin = (r, v, [ri, di]) => v && v.t && ri >= 0 && di >= 0 ? (v.v[ri] - v.v[di]) / v.t : null;
  const call = key => (RES && RES.calls && RES.calls[key]) || null;
  const callWinner = (r, cl) => cl ? r.candidates.find(c => c.id === String(cl.winner_id) || c.name === cl.winner || (c.last && c.last === (cl.winner || "").toUpperCase())) : null;

  function renderEday() {
    renderEdayStatus();
    const r = currentRace();
    renderRacePicker(r);
    if (!r) {
      document.getElementById("race-main").innerHTML = `<h2>Results</h2><div class="hint">${RES && RES.status === "unreachable" ? "The results file can't be loaded right now. Retrying every minute." : "Waiting for the first check of the state's results feed."}</div>`;
      document.getElementById("eday-map").innerHTML = ""; document.getElementById("eday-table").innerHTML = "";
      return;
    }
    renderRaceMain(r);
    renderEdayMap(r);
    renderEdayTable(r);
  }

  function renderEdayStatus() {
    const el = document.getElementById("eday-status");
    if (!RES || RES.status === "unreachable") { el.innerHTML = `<span class="st bad"><i></i>Can't load results</span><span class="st-parts">Retrying every minute.</span>`; return; }
    const any = raceList().some(r => r.found && r.total > 0);
    const st = RES.status;
    const pill = st === "held" ? `<span class="st warn"><i></i>Holding last good numbers</span>`
      : st === "error" ? `<span class="st bad"><i></i>State feed not responding</span>`
      : !any ? `<span class="st idle"><i></i>No votes reported yet</span>`
      : RES.live ? `<span class="st ok live"><i></i>Live</span>` : `<span class="st ok"><i></i>Unofficial results</span>`;
    const [cr, ct] = RES.counties_reporting || [], [pr, pt] = RES.polling_reporting || [];
    const parts = [];
    if (RES.state_updated && any) parts.push(`State updated <b>${dateTimeCT(RES.state_updated)}</b>`);
    if (ct) parts.push(`Counties reporting <b>${fmt(cr || 0)} of ${fmt(ct)}</b>`);
    if (pt) parts.push(`Polling places <b>${fmt(pr || 0)} of ${fmt(pt)}</b>`);
    if (RES.checked_at) parts.push(`Checked ${ago(RES.checked_at)}`);
    let note = "";
    if (st === "held" && RES.hold) note = `<div class="st-note">The newest data from the state didn't pass a consistency check (${RES.hold.problems[0]}), so the page is showing the last numbers that did. This usually clears on the next update.</div>`;
    else if (st === "error") note = `<div class="st-note">The last attempt to reach the state's results failed; showing the last good numbers${RES.fetched_at ? " from " + dateTimeCT(RES.fetched_at) : ""}. Retrying automatically.</div>`;
    else if (RES.accepted_note) note = `<div class="st-note">${RES.accepted_note}</div>`;
    else if (!any) note = `<div class="st-note">Polls close at 7 PM Central (8 PM Central in El Paso and Hudspeth counties). Early-vote totals usually post first, within the hour.</div>`;
    el.innerHTML = (RES.rehearsal ? `<span class="st rehearsal">${RES.rehearsal}</span>` : "") + pill + `<span class="st-parts">${parts.join(" · ")}</span>` + note;
  }

  function renderRacePicker(cur) {
    const el = document.getElementById("race-picker");
    el.innerHTML = raceList().map(r => {
      if (!r.found) return `<button class="race-pick" disabled><span class="rp-t">${r.title}</span><span class="rp-s">Not on this ballot</span></button>`;
      const [a, b] = mainPair(r);
      const w = callWinner(r, call(r.key));
      const sub = r.total ? `${candShort(a)} ${pct(share(a.votes, r.total))} · ${candShort(b)} ${pct(share(b.votes, r.total))}` : `${candShort(a)} vs. ${candShort(b)}`;
      return `<button class="race-pick${cur && r.key === cur.key ? " active" : ""}" data-key="${r.key}" role="tab" aria-selected="${cur && r.key === cur.key}">
        <span class="rp-t">${r.title}${w ? ` <span class="rp-call" style="background:${partyColor(w.party)}">${candShort(w)} wins</span>` : ""}</span>
        <span class="rp-s">${sub}</span></button>`;
    }).join("");
    el.querySelectorAll(".race-pick[data-key]").forEach(b => b.addEventListener("click", () => {
      raceKey = b.dataset.key; try { localStorage.setItem("race", raceKey); } catch (e) {}
      renderEday();
    }));
  }

  function renderRaceMain(r) {
    const el = document.getElementById("race-main");
    const [a, b] = mainPair(r);
    const cl = call(r.key), winner = callWinner(r, cl);
    const others = r.candidates.filter(c => c.id !== a.id && c.id !== b.id);
    const oVotes = d3.sum(others, c => c.votes);
    const row = c => `
      <div class="cand${winner && winner.id === c.id ? " won" : ""}">
        <i class="cbar" style="background:${partyColor(c.party)}"></i>
        <div class="cn"><div class="cname">${candFull(c)}${winner && winner.id === c.id ? ' <span class="check" aria-label="Winner">✓</span>' : ""}</div><div class="cparty">${partyLabel(c.party)}</div></div>
        <div class="cv"><div class="cpct num">${r.total ? pct(share(c.votes, r.total)) : "—"}</div><div class="cvotes num">${fmt(c.votes)} votes</div></div>
      </div>`;
    const lead = r.total && a.votes !== b.votes ? (a.votes > b.votes ? a : b) : null;
    const diff = Math.abs(a.votes - b.votes);
    const stackHTML = r.total ? `<div class="stack race-stack">${[a, b, ...others].map(c => { const p = share(c.votes, r.total); return `<div style="width:${p}%;background:${partyColor(c.party)}" title="${candFull(c)}: ${pct(p)}">${p >= 7 ? pct(p, 1) : ""}</div>`; }).join("")}</div>` : "";
    // Early & mail votes post first; Election Day votes follow through the night.
    let split = "";
    if (r.total) {
      const ev = c => c.early, ed = c => c.votes - c.early;
      const evT = d3.sum(r.candidates, ev), edT = d3.sum(r.candidates, ed);
      const cell = (f, t, c) => t ? pct(share(f(c), t)) : "—";
      split = `<table class="split"><thead><tr><th></th><th>${candShort(a)}</th><th>${candShort(b)}</th><th>Votes</th></tr></thead><tbody>
        <tr><td>Early &amp; mail</td><td class="num">${cell(ev, evT, a)}</td><td class="num">${cell(ev, evT, b)}</td><td class="num">${fmt(evT)}</td></tr>
        <tr><td>Election Day</td><td class="num">${cell(ed, edT, a)}</td><td class="num">${cell(ed, edT, b)}</td><td class="num">${fmt(edT)}</td></tr></tbody></table>`;
    }
    el.innerHTML = `
      <div class="race-head"><h2>${r.title}</h2>${winner ? `<span class="call-badge" style="border-color:${partyColor(winner.party)}">✓ ${candShort(winner)} wins · called by ${cl.by || "—"}${cl.at ? " at " + timeCT(cl.at) + " CT" : ""}</span>` : ""}</div>
      ${row(a)}${row(b)}
      ${stackHTML}
      <div class="race-meta">
        ${lead ? `<div><b>${candShort(lead)}</b> leads by <b class="num">${pct(share(diff, r.total))}</b> (${fmt(diff)} votes)</div>` : r.total ? `<div>Tied</div>` : `<div class="muted">No votes reported yet.</div>`}
        ${others.length ? `<div class="muted">Other candidates: ${r.total ? pct(share(oVotes, r.total)) : "—"} (${others.map(candShort).join(", ")})</div>` : ""}
        <div class="muted">${fmt(r.total)} votes counted · ${fmt(r.counties_with_votes)} of ${fmt(r.counties_in_race)} counties with results</div>
      </div>
      ${split}
      ${isLocal && !REHEARSAL ? callPanel(r, a, b, winner) : ""}`;
    wireCallPanel(r);
  }

  // Desktop app only: mark a race as called once AP or Decision Desk HQ calls it. The call is saved by the
  // local service (POST /api/call) and goes out to the website with the next publish.
  function callPanel(r, a, b, winner) {
    if (winner) return `<div class="call-panel"><span>Called for <b>${candShort(winner)}</b> by ${call(r.key).by}.</span>
      <button class="btn" data-undo>Undo call</button></div>`;
    return `<div class="call-panel"><span class="cp-t">Race call <span class="muted">(desktop app only)</span></span>
      <select id="call-by" aria-label="Called by"><option value="AP">AP</option><option value="Decision Desk HQ">Decision Desk HQ</option><option value="NBC News">NBC News</option><option value="Fox News">Fox News</option></select>
      <button class="btn" data-win="${a.id}">Call for ${candShort(a)}</button><button class="btn" data-win="${b.id}">Call for ${candShort(b)}</button></div>`;
  }
  function wireCallPanel(r) {
    const el = document.getElementById("race-main");
    const send = async body => {
      try {
        const res = await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await res.json();
        if (!j.ok) alert("Couldn't save the call: " + j.error);
      } catch (e) { alert("Couldn't reach the tracker service."); }
      loadResults();
    };
    el.querySelectorAll("[data-win]").forEach(btn => btn.addEventListener("click", () => {
      const c = r.candidates.find(x => x.id === btn.dataset.win), by = document.getElementById("call-by").value;
      if (confirm(`Mark the ${r.title} race as called for ${candFull(c)} by ${by}?

This shows on the public website within about a minute.`))
        send({ race: r.key, winner_id: c.id, by });
    }));
    const undo = el.querySelector("[data-undo]");
    if (undo) undo.addEventListener("click", () => { if (confirm(`Remove the call for the ${r.title} race?`)) send({ race: r.key, clear: true }); });
  }

  function renderEdayMap(r) {
    const el = document.getElementById("eday-map");
    if (!geo) { fetch("data/tx-counties.geojson").then(x => x.json()).then(g => { geo = g; renderEdayMap(r); }); return; }
    if (!Object.keys(R24c).length && !R24) { loadR24().then(() => { renderEdayMap(r); renderEdayTable(r); }); return; }
    const wholeState = r.counties_in_race >= 254;
    if (edayMode === "shift" && !wholeState) edayMode = "margin";
    document.querySelectorAll("#eday-map-mode button").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === edayMode);
      b.disabled = b.dataset.mode === "shift" && !wholeState;
      b.title = b.disabled ? "Not available for district races: counties split between districts can't be compared with countywide 2024 results" : "";
    });
    const fipsOf = f => f.properties.fips || f.properties.FIPS || f.id;
    const feats = geo.features.filter(f => r.counties[fipsOf(f)]);
    const fc = { type: "FeatureCollection", features: feats.length ? feats : geo.features };
    const W = el.clientWidth || 600, H = Math.round(W * (wholeState ? 0.92 : 0.75));
    const proj = d3.geoConicConformal().parallels([27.5, 35]).rotate([100, 0]).fitSize([W, H], fc);
    const path = d3.geoPath(proj);
    const idx = repDemIdx(r);
    const dCol = d3.scaleLinear().domain([-0.5, 0, 0.5]).range([C.dem, C.mid, C.rep]).clamp(true).interpolate(d3.interpolateRgb);
    const sCol = d3.scaleLinear().domain([-0.15, 0, 0.15]).range([C.dem, C.mid, C.rep]).clamp(true).interpolate(d3.interpolateRgb);
    const ramp = seqRamp();
    const rCol = d3.scaleQuantize().domain([0, 1]).range(ramp);
    const fill = f => {
      const fips = fipsOf(f), v = r.counties[fips];
      if (!v) return "var(--surface-2)";
      if (edayMode === "reporting") return v.tp ? rCol(Math.min(1, (v.pr || 0) / v.tp)) : "url(#eday-hatch)";
      const m = cMargin(r, v, idx);
      if (m == null) return "url(#eday-hatch)";
      if (edayMode === "shift") { const m24 = senMargin(R24c[fips]); return m24 == null ? "url(#eday-hatch)" : sCol(m - m24); }
      return dCol(m);
    };
    const svg = d3.select(el).selectAll("svg").data([0]).join("svg").attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();
    svg.append("defs").append("pattern").attr("id", "eday-hatch").attr("width", 6).attr("height", 6).attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)")
      .call(p => { p.append("rect").attr("width", 6).attr("height", 6).style("fill", "var(--nodata-a)"); p.append("rect").attr("width", 3).attr("height", 6).style("fill", "var(--nodata-b)"); });
    svg.append("g").selectAll("path").data(fc.features).join("path").attr("d", path)
      .attr("fill", fill).attr("stroke", "var(--map-stroke)").attr("stroke-width", 0.5)
      .on("mousemove", (evt, f) => {
        const fips = fipsOf(f), v = r.counties[fips];
        if (!v) return hideTip();
        const rows = v.t ? mainPair(r).map(c => [candShort(c), `${pct(share(v.v[c.i], v.t))} · ${fmt(v.v[c.i])}`]) : [["Votes", "none reported yet"]];
        if (v.tp) rows.push(["Precincts reporting", `${fmt(v.pr || 0)} of ${fmt(v.tp)}`]);
        rows.push(["Votes counted", fmt(v.t)]);
        const m24 = senMargin(R24c[fips]), m = cMargin(r, v, idx);
        if (wholeState && m24 != null) rows.push(["2024 Senate", marginTxt(m24, "Cruz +", "Allred +")]);
        if (wholeState && m != null && m24 != null) rows.push(["Shift from 2024", marginTxt(m - m24)]);
        showTip(evt, `${v.name} County`, rows);
      })
      .on("mouseleave", hideTip);
    const leg = document.getElementById("eday-legend");
    const rN = candShort(r.candidates[idx[0]] || {}), dN = candShort(r.candidates[idx[1]] || {});
    const hatch = `<span><i class="sw" style="background:${NODATA}"></i>No votes yet</span>`;
    if (edayMode === "reporting") leg.innerHTML = `<span>Precincts reporting: 0%</span><span class="ramp" style="background:linear-gradient(90deg,${ramp.join(",")})"></span><span>100%</span>${hatch}`;
    else if (edayMode === "shift") leg.innerHTML = `<span>Toward ${dN}</span><span class="ramp" style="background:linear-gradient(90deg,${C.dem},${C.mid},${C.rep})"></span><span>Toward ${rN}</span><span>(15+ pts)</span>${hatch}`;
    else leg.innerHTML = `<span>${dN} +50</span><span class="ramp" style="background:linear-gradient(90deg,${C.dem},${C.mid},${C.rep})"></span><span>${rN} +50</span>${hatch}`;
    document.getElementById("eday-map-title").textContent = `${r.title} by county`;
    document.getElementById("eday-map-hint").textContent = edayMode === "shift" ? "Change in the Republican-minus-Democratic margin since the 2024 Senate race (Cruz vs. Allred)"
      : edayMode === "reporting" ? "Share of each county's precincts that have reported" : wholeState ? "Republican-minus-Democratic margin in each county"
      : "Counties in the district. Counties split between districts show only the part inside it.";
  }

  function renderEdayTable(r) {
    const [a, b] = mainPair(r);
    const idx = repDemIdx(r), wholeState = r.counties_in_race >= 254;
    let rows = Object.entries(r.counties).map(([fips, v]) => {
      const m = cMargin(r, v, idx), m24 = wholeState ? senMargin(R24c[fips]) : null;
      return { fips, ...v, m, m24, shift: m != null && m24 != null ? m - m24 : null, w24: senTot(R24c[fips]) };
    });
    rows.sort((x, y) => (y.t - x.t) || (y.w24 - x.w24));
    if (edayQuery) rows = rows.filter(x => x.name.toLowerCase().includes(edayQuery));
    const shown = edayAll || edayQuery ? rows : rows.slice(0, 25);
    document.getElementById("eday-more").hidden = edayAll || !!edayQuery || rows.length <= 25;
    document.getElementById("eday-table-hint").textContent = r.total ? "Largest counties by votes counted" : "Largest counties by 2024 Senate vote";
    document.getElementById("eday-table").innerHTML = `<thead><tr><th>County</th><th>Precincts in</th><th>${candShort(a)}</th><th>${candShort(b)}</th><th>Margin</th>${wholeState ? "<th>2024 Senate</th><th>Shift</th>" : ""}<th>Votes</th></tr></thead><tbody>
      ${shown.map(x => `<tr><td><b>${x.name}</b></td><td class="num">${x.tp ? `${fmt(x.pr || 0)} / ${fmt(x.tp)}` : "—"}</td>
        <td class="num">${x.t ? pct(share(x.v[a.i], x.t)) : "—"}</td><td class="num">${x.t ? pct(share(x.v[b.i], x.t)) : "—"}</td>
        <td class="num">${marginTxt(x.m)}</td>${wholeState ? `<td class="num">${marginTxt(x.m24)}</td><td class="num">${marginTxt(x.shift)}</td>` : ""}<td class="num">${fmt(x.t)}</td></tr>`).join("")}</tbody>`;
  }

  document.querySelectorAll("#eday-map-mode button").forEach(b => b.addEventListener("click", () => {
    if (b.disabled) return;
    edayMode = b.dataset.mode;
    const r = currentRace(); if (r) renderEdayMap(r);
  }));
  document.getElementById("eday-more").addEventListener("click", () => { edayAll = true; const r = currentRace(); if (r) renderEdayTable(r); });
  document.getElementById("eday-search").addEventListener("input", e => { edayQuery = e.target.value.trim().toLowerCase(); const r = currentRace(); if (r) renderEdayTable(r); });

  window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => D && render(), 150); });
  load(); loadResults();
  setInterval(() => { load(); loadResults(); }, POLL_MS);
})();
