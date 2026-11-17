// Readers for the usage monitor. Everything here reads local files only:
//   Claude limits  ~/.claude/usage-monitor/rate-limits.json (written by the usage-bridge Claude Code mod)
//   Claude tokens  ~/.claude/projects/*/*.jsonl (the transcripts Claude Code keeps)
//   Codex limits   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (the transcripts Codex keeps)
import * as fs from "fs/promises";
import { home, shared, setShared } from "herdr";

export const KEY = "usage-monitor.data";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;

const join = (...parts) => parts.join("/");

async function readText(path) {
  try { return await fs.readFile(path, "utf8"); } catch { return null; }
}

async function listDir(path) {
  try { return await fs.readdir(path, { withFileTypes: true }); } catch { return []; }
}

async function exists(path) {
  try { return await fs.exists(path); } catch { return false; }
}

const namesDesc = (entries, dirs) => entries
  .filter((e) => (dirs ? e.isDirectory() : !e.isDirectory()))
  .map((e) => e.name)
  .sort()
  .reverse();

// ---- Claude: rate limits published by the usage-bridge mod -------------------

export async function readClaudeLimits() {
  const path = join(home(), ".claude", "usage-monitor", "rate-limits.json");
  const text = await readText(path);
  if (text === null) return { ok: false, reason: "no-file" };
  try {
    const d = JSON.parse(text);
    const at = Date.parse(d.updatedAt);
    const limits = Array.isArray(d.rateLimits) ? d.rateLimits : [];
    const find = (kind) => limits.find((l) => l.kind === kind) ?? null;
    const norm = (l) => (l ? { percentUsed: Number(l.percentUsed), resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : null } : null);
    const started = Date.parse(d.sessionStartedAt);
    return {
      ok: true,
      at: Number.isFinite(at) ? at : null,
      sessionStartedAt: Number.isFinite(started) ? started : null,
      fiveHour: norm(find("five_hour")),
      sevenDay: norm(find("seven_day")),
      other: limits.filter((l) => l.kind !== "five_hour" && l.kind !== "seven_day").map((l) => ({ kind: l.kind, ...norm(l) })),
      // The last session the bridge saw: its context window and cost.
      context: d.context && Number.isFinite(Number(d.context.window))
        ? { tokens: d.context.tokens == null ? null : Number(d.context.tokens), window: Number(d.context.window), percent: d.context.percent == null ? null : Number(d.context.percent) }
        : null,
      cost: d.cost && Number.isFinite(Number(d.cost.usd)) ? { usd: Number(d.cost.usd) } : null,
    };
  } catch {
    return { ok: false, reason: "bad-file" };
  }
}

// ---- Claude: token counts from the local transcripts ------------------------

// Per file: the rows parsed last time, keyed by the text length seen then.
const logCache = new Map();

function parseRows(text, since) {
  const rows = [];
  let from = 0;
  while (from < text.length) {
    let to = text.indexOf("\n", from);
    if (to < 0) to = text.length;
    const line = text.slice(from, to);
    from = to + 1;
    if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "assistant") continue;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts) || ts < since) continue;
    const m = o.message ?? {};
    const u = m.usage;
    if (!u || !m.id) continue;
    rows.push({
      id: m.id,
      ts,
      model: m.model ?? "",
      input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
    });
  }
  return rows;
}

function lastTimestamp(text) {
  const i = text.lastIndexOf('"timestamp":"');
  if (i < 0) return null;
  const ts = Date.parse(text.slice(i + 13, i + 13 + 24));
  return Number.isFinite(ts) ? ts : null;
}

export async function readClaudeLogs(now) {
  const root = join(home(), ".claude", "projects");
  const since = now - DAY;
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  const seen = new Set();
  const sum = () => ({ input: 0, output: 0, requests: 0 });
  const today = sum();
  const fiveHours = sum();
  const models = {};
  let files = 0;
  for (const project of await listDir(root)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of await listDir(dir)) {
      if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      const text = await readText(path);
      if (text === null) continue;
      files += 1;
      let rows;
      const cached = logCache.get(path);
      if (cached && cached.length === text.length) {
        rows = cached.rows;
      } else {
        const last = lastTimestamp(text);
        rows = last !== null && last < since ? [] : parseRows(text, since);
        logCache.set(path, { length: text.length, rows });
      }
      for (const r of rows) {
        if (r.ts < since || seen.has(r.id)) continue;
        seen.add(r.id);
        const add = (s) => { s.input += r.input; s.output += r.output; s.requests += 1; };
        if (r.ts >= dayStart) {
          add(today);
          models[r.model] = (models[r.model] ?? 0) + r.input + r.output;
        }
        if (now - r.ts <= FIVE_HOURS) add(fiveHours);
      }
    }
  }
  for (const path of [...logCache.keys()]) if (!(await exists(path))) logCache.delete(path);
  return { ok: files > 0, at: now, files, today, fiveHours, models };
}

// ---- Codex: the newest rate_limits event in its session transcripts ----------

export async function readCodex(now) {
  const codexHome = join(home(), ".codex");
  const root = join(codexHome, "sessions");
  if (!(await exists(codexHome))) return { ok: false, reason: "not-installed" };
  const files = [];
  outer: for (const y of namesDesc(await listDir(root), true)) {
    for (const m of namesDesc(await listDir(join(root, y)), true)) {
      for (const d of namesDesc(await listDir(join(root, y, m)), true)) {
        for (const f of namesDesc(await listDir(join(root, y, m, d)), false)) {
          if (!f.endsWith(".jsonl")) continue;
          files.push(join(root, y, m, d, f));
          if (files.length >= 8) break outer;
        }
      }
    }
  }
  if (files.length === 0) return { ok: false, reason: "no-sessions" };
  for (const path of files) {
    const text = await readText(path);
    if (text === null) continue;
    let end = text.length;
    while (end > 0) {
      const start = text.lastIndexOf("\n", end - 1) + 1;
      const line = text.slice(start, end);
      end = start - 1;
      if (line.indexOf('"rate_limits"') < 0) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const rl = o?.payload?.rate_limits ?? o?.rate_limits;
      if (!rl || typeof rl !== "object") continue;
      const at = Date.parse(o.timestamp ?? o.payload?.timestamp) || now;
      const norm = (w) => {
        if (!w || typeof w !== "object") return null;
        let resetsAt = null;
        if (w.resets_at != null) resetsAt = Number(w.resets_at) * (Number(w.resets_at) < 1e12 ? 1000 : 1);
        else if (w.resets_in_seconds != null) resetsAt = at + Number(w.resets_in_seconds) * 1000;
        return { percentUsed: Number(w.used_percent ?? 0), windowMinutes: w.window_minutes ?? null, resetsAt };
      };
      // Which window is "primary" depends on the plan: a plan with only a
      // weekly limit reports it as primary with secondary null. Match by
      // window length, and keep any other window as a row of its own.
      const windows = [norm(rl.primary), norm(rl.secondary)].filter(Boolean);
      const fiveHour = windows.find((w) => w.windowMinutes === 300) ?? null;
      const weekly = windows.find((w) => w.windowMinutes === 10080) ?? null;
      const other = windows.filter((w) => w !== fiveHour && w !== weekly);
      return { ok: true, at, fiveHour, weekly, other, plan: rl.plan_type ?? null, file: path };
    }
  }
  return { ok: false, reason: "no-reading" };
}

// ---- Refresh: one in-flight read, result shared with every copy ---------------

let inflight = null;

export function refresh({ logs = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const now = Date.now();
    const prev = shared(KEY) ?? {};
    const [claude, codex, logData] = await Promise.all([
      readClaudeLimits().catch((e) => ({ ok: false, reason: String(e) })),
      readCodex(now).catch((e) => ({ ok: false, reason: String(e) })),
      logs || !prev.logs
        ? readClaudeLogs(now).catch((e) => ({ ok: false, reason: String(e) }))
        : Promise.resolve(prev.logs),
    ]);
    const next = { at: now, claude, codex, logs: logData };
    if (JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 })) setShared(KEY, next);
    return next;
  })().finally(() => { inflight = null; });
  return inflight;
}
