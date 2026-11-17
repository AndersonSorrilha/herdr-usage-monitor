// usage-bridge: publishes what `$.session.usage()` knows about the account's
// rate-limit windows to a small JSON file, so a program outside Claude Code
// (the Herdr usage-monitor mod) can show it. Local file only, no network.
import type { EngineInterface, Register } from 'claude-code'

const RELATIVE = '.claude/usage-monitor/rate-limits.json'

async function publish($: EngineInterface, event: string): Promise<void> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return
  const path = `${home.replace(/[\\/]+$/, '')}/${RELATIVE}`
  const usage = await $.session.usage()
  // Before the first response of a session there is no reading: keep the
  // last good file rather than blanking it, but create one so the monitor
  // can tell the bridge is installed.
  if (usage.rateLimits.length === 0 && (await $.fs.exists(path))) return
  const now = await $.clock.now()
  const body = {
    source: 'claude-code/usage-bridge',
    event,
    updatedAt: new Date(now).toISOString(),
    sessionStartedAt: new Date(usage.startedAt).toISOString(),
    rateLimits: usage.rateLimits,
    context: {
      tokens: usage.context.tokens ?? null,
      window: usage.context.window,
      percent: usage.context.percent ?? null,
    },
    cost: usage.cost ?? null,
  }
  await $.fs.write(path, JSON.stringify(body, null, 2) + '\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void publish($, 'session.start').catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    void publish($, 'session.measure').catch(() => undefined)
    return next(e)
  })
}
