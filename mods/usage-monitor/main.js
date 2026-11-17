// Usage monitor: a slim bar with the Claude and Codex readouts, and a popup
// with the 5-hour and weekly limits of each, opened by clicking the bar.
// Data comes from usage.js, which reads local files only.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, shared, openOverlay, checking, spaces, agents, run, window, keys } from "herdr";
import { KEY, refresh } from "./usage.js";

const AMBER_FROM = 70;
const RED_FROM = 90;
const STALE = { claude: 30 * 60e3, codex: 6 * 3600e3 };
const MINUTE = 60e3;
// Keep in step with mod.json's overlay, which mod.open uses.
const POPUP = { width: 400, height: 630 };

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pct(v) {
  return v == null || !Number.isFinite(v) ? "–" : `${Math.round(v)}%`;
}

function tokens(n) {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function usd(n) {
  if (!Number.isFinite(n)) return "–";
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function clock(at) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ago(at, now) {
  if (!at) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function resetText(at, now) {
  if (!at) return "";
  if (at <= now) return "resets soon";
  const d = new Date(at);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `resets ${sameDay ? "at " + clock : DAYS[d.getDay()] + " " + clock}`;
}

// The palette hint as the shipped status bar draws it: the key as bound.
function paletteHint() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
  return key ? `${key}  commands` : "commands";
}

function barColor(t, v) {
  if (v == null) return t.dim;
  if (v >= RED_FROM) return t.ansi1;
  if (v >= AMBER_FROM) return t.ansi3;
  return t.accent;
}

export default class UsageMonitor extends View {
  init(_props, cx) {
    this.busy = false;
    this.error = null;
    this.now = Date.now();
    this.popup = Boolean(props()?.overlay);
    this.ticks = 0;
    if (checking()) return;
    // The popup re-reads everything when it opens; the bar keeps the shared
    // readings fresh: limits every minute, the transcripts every five.
    this.reload(cx, { logs: this.popup });
    cx.timer.every(MINUTE, (cx) => {
      this.ticks += 1;
      this.now = Date.now();
      if (this.popup) cx.notify();
      else this.reload(cx, { logs: this.ticks % 5 === 0 });
    });
  }

  reload(cx, opts = {}) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try { await refresh(opts); }
      catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      this.now = Date.now();
      cx.notify();
    });
  }

  open() {
    openOverlay({ mod: "usage-monitor", kind: "popup", width: POPUP.width, height: POPUP.height, props: { popup: true } });
  }

  render(cx) {
    const t = theme();
    return this.popup ? this.renderPopup(t, cx) : this.renderBar(t);
  }

  // ---- the bar: the status bar's own items, then the readouts -------------------

  renderBar(t) {
    const d = shared(KEY) ?? {};
    const claude = d.claude?.ok ? d.claude : null;
    const codex = d.codex?.ok ? d.codex : null;
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const readout = (id, icon, name, five, week, hint) => h_flex().id(id).h_full().px(7).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => this.open())
      .child(svg(icon).size(13).text_color(t.muted))
      .child(div().text_color(t.foreground).child(name))
      .when(five == null && week == null, (el) => el.child(div().text_color(t.dim).child(hint)))
      .when(five != null || week != null, (el) => el
        .child(this.mini(t, five, "5h"))
        .child(this.mini(t, week, "wk")));
    return h_flex().id("usage-bar").size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(h_flex().gap(2).items_center().h_full()
        .child(readout("claude", "icons/claude.svg", "Claude", claude?.fiveHour?.percentUsed, claude?.sevenDay?.percentUsed,
          d.claude?.reason === "no-file" ? "no bridge" : "no reading"))
        .child(readout("codex", "icons/codex.svg", "Codex", codex?.fiveHour?.percentUsed, codex?.weekly?.percentUsed,
          d.codex?.reason === "not-installed" ? "not found" : "no reading")))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(paletteHint()));
  }

  mini(t, v, label) {
    const c = barColor(t, v);
    return h_flex().gap(4).items_center()
      .child(div().text_color(t.dim).child(label))
      .child(div().w(36).h(5).rounded(3).bg(t.raised).overflow_hidden()
        .child(div().h_full().w(`${Math.max(0, Math.min(100, v ?? 0))}%`).rounded(3).bg(c)))
      .child(div().text_color(v == null ? t.dim : c).child(pct(v)));
  }

  // ---- the popup -------------------------------------------------------------

  renderPopup(t, cx) {
    const d = shared(KEY) ?? {};
    const now = this.now;
    const header = h_flex().items_center().justify_between().pb(4)
      .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Usage"))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).text_color(t.dim).child(d.at ? `updated ${ago(d.at, now)}` : ""))
        .child(div().id("refresh").px(9).py(3).rounded(5).bg(t.raised).text_size(11.5).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.reload(cx, { logs: true }))
          .child(this.busy ? "Refreshing…" : "Refresh")));
    // A popup is sized by its content, so the root states its height and the
    // body scrolls inside it (a flex_1 chain with no height draws nothing).
    return v_flex().id("usage-popup").w_full().h(POPUP.height - 2).bg(t.popover).p(14).gap(12).text_size(12.5).text_color(t.foreground)
      .child(header)
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(v_flex().flex_1().min_h(0).gap(12).overflow_y_scrollbar()
        .child(this.claudeSection(t, d, now))
        .child(this.codexSection(t, d, now)));
  }

  section(t, icon, title, stamp, stale, body) {
    return v_flex().gap(8).p(10).rounded(8).bg(t.surface)
      .child(h_flex().items_center().justify_between()
        .child(h_flex().gap(7).items_center()
          .child(svg(icon).size(14).text_color(t.foreground))
          .child(div().font_semibold().child(title)))
        .child(div().text_size(11).text_color(stale ? t.ansi3 : t.dim).child(stamp)))
      .children(body);
  }

  limitRow(t, label, w, now) {
    const v = w?.percentUsed;
    const c = barColor(t, v);
    const fill = Math.max(0, Math.min(100, v ?? 0));
    return v_flex().gap(4)
      .child(h_flex().justify_between()
        .child(div().child(label))
        .child(div().text_color(v == null ? t.dim : c).child(v == null ? "no reading" : `${pct(v)} used`)))
      .child(div().w_full().h(7).rounded(4).bg(t.raised).overflow_hidden()
        .child(div().h_full().w(`${fill}%`).rounded(4).bg(c)))
      .child(h_flex().justify_between().text_size(11).text_color(t.dim)
        .child(v == null ? "" : `${pct(100 - v)} left`)
        .child(resetText(w?.resetsAt, now)));
  }

  note(t, text) {
    return div().text_size(11).text_color(t.dim).child(text);
  }

  claudeSection(t, d, now) {
    const c = d.claude;
    const logs = d.logs;
    const body = [];
    if (!c?.ok) {
      body.push(this.note(t, c?.reason === "bad-file"
        ? "The bridge file could not be read (~/.claude/usage-monitor/rate-limits.json)."
        : "No reading yet. Run Claude Code with the usage-bridge mod loaded: it writes ~/.claude/usage-monitor/rate-limits.json after every turn."));
    } else {
      body.push(this.limitRow(t, "Current session (5-hour)", c.fiveHour, now));
      body.push(this.limitRow(t, "Weekly limit (all models)", c.sevenDay, now));
      for (const o of c.other ?? []) body.push(this.limitRow(t, o.kind.replace(/_/g, " "), o, now));
      if (!c.fiveHour && !c.sevenDay && (c.other ?? []).length === 0) body.push(this.note(t, "The bridge has not seen a rate-limit reading yet: it arrives with the first response of a subscription session."));
    }
    const stat = (label, s, text) => h_flex().justify_between().text_size(11.5)
      .child(div().text_color(t.muted).child(label))
      .child(div().child(text ?? (s ? `${tokens(s.input + s.output)} tokens · ${tokens(s.output)} out · ${s.requests} req` : "–")));
    // The last session the bridge saw: how full its context window was and
    // what it cost. Another session than the one in front of you, possibly.
    if (c?.ok && (c.context || c.cost)) {
      body.push(div().h(1).bg(t.border));
      const when = c.sessionStartedAt ? `started ${clock(c.sessionStartedAt)}` : "";
      body.push(h_flex().justify_between().text_size(11)
        .child(div().text_color(t.muted).child("Last session"))
        .child(div().text_color(t.dim).child(when)));
      if (c.context) {
        const ctx = c.context;
        const fill = ctx.percent ?? (ctx.tokens != null && ctx.window > 0 ? (ctx.tokens / ctx.window) * 100 : null);
        body.push(stat("Context", null, ctx.tokens == null
          ? `– / ${tokens(ctx.window)}`
          : `${tokens(ctx.tokens)} / ${tokens(ctx.window)} · ${pct(fill)} full`));
      }
      if (c.cost) body.push(stat("Cost", null, usd(c.cost.usd)));
    }
    body.push(div().h(1).bg(t.border));
    if (logs?.ok) {
      body.push(stat("Today", logs.today));
      body.push(stat("Last 5 hours", logs.fiveHours));
      body.push(this.note(t, `Token counts from local transcripts (${logs.files} files). Not a limit.`));
    } else {
      body.push(this.note(t, logs?.reason ? `Transcripts: ${logs.reason}` : "No transcripts under ~/.claude/projects yet."));
    }
    const stamp = c?.ok ? `reading ${ago(c.at, now)}` : "";
    return this.section(t, "icons/claude.svg", "Claude", stamp, c?.ok && c.at && now - c.at > STALE.claude, body);
  }

  codexSection(t, d, now) {
    const c = d.codex;
    const body = [];
    if (!c?.ok) {
      const why = { "not-installed": "Codex not found (no ~/.codex folder).", "no-sessions": "No Codex sessions yet.", "no-reading": "No rate-limit reading in the latest Codex sessions." };
      body.push(this.note(t, why[c?.reason] ?? `Codex: ${c?.reason ?? "no data"}`));
    } else {
      body.push(this.limitRow(t, "5-hour usage limit", c.fiveHour, now));
      body.push(this.limitRow(t, "Weekly usage limit", c.weekly, now));
      for (const w of c.other ?? []) {
        const m = w.windowMinutes ?? 0;
        const span = m >= 1440 ? `${Math.round(m / 1440)}-day` : m >= 60 ? `${Math.round(m / 60)}-hour` : `${m}-minute`;
        body.push(this.limitRow(t, `${span} usage limit`, w, now));
      }
      body.push(this.note(t, `Codex has no daily figure; readings come from its session transcripts${c.plan ? ` (plan: ${c.plan})` : ""}.`));
    }
    const stamp = c?.ok ? `reading ${ago(c.at, now)}` : "";
    return this.section(t, "icons/codex.svg", "Codex", stamp, c?.ok && c.at && now - c.at > STALE.codex, body);
  }
}
