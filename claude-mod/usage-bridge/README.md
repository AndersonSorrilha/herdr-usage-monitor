# usage-bridge

A Claude Code plugin of function hooks that publishes the account's rate-limit
windows to a local file, so a program outside Claude Code can show them. It
was written for the Herdr `usage-monitor` mod (in `../../mods/usage-monitor`),
which draws the 5-hour and weekly windows in Herdr's status bar.

## What it does

After the session starts and after every measurement Claude Code makes (the
`session.measure` event, raised after each turn and whenever a rate-limit
window moves a whole point), it calls `$.session.usage()` and writes:

```
~/.claude/usage-monitor/rate-limits.json
```

```json
{
  "source": "claude-code/usage-bridge",
  "event": "session.measure",
  "updatedAt": "2026-11-17T21:10:00.000Z",
  "sessionStartedAt": "2026-11-17T20:30:00.000Z",
  "rateLimits": [
    { "kind": "five_hour", "percentUsed": 36, "resetsAt": "2026-11-17T23:00:00.000Z" },
    { "kind": "seven_day", "percentUsed": 57, "resetsAt": "2026-11-20T15:00:00.000Z" }
  ],
  "context": { "tokens": 80000, "window": 200000, "percent": 40 },
  "cost": { "usd": 1.23 }
}
```

`rateLimits` is empty off a subscription or before the session's first
response; in that case an existing file is left as it is. The plugin reads
`USERPROFILE` or `HOME` to find the file, writes nothing else, and never
touches the network.

## Install

From this folder's own marketplace (the `.claude-plugin/marketplace.json` at
the root of this repository), at the prompt of a terminal session:

```
/plugin install usage-bridge --marketplace AndersonSorrilha/herdr-usage-monitor
```

or, from a checkout on this machine, at a shell in the repository's root
(the source has to be written as `./path`, not a bare or Windows path):

```
claude plugin install usage-bridge --marketplace ./ --scope user
```

Answer `y` to add the marketplace if asked: the hooks run in every session
started after. A plugin installed from a folder is read from that folder
itself (`claude plugin list` shows it under "Read from"), so an edit here
reaches a session with `/reload-plugins`, with no reinstall.

For one session only, with nothing installed:

```
claude --plugin-dir /path/to/herdr/claude-mod/usage-bridge
```

Check it with `claude plugin validate /path/to/herdr/claude-mod/usage-bridge`.

## What the file shows

`rateLimits` holds only the windows the last response reported: an account
may report `seven_day` alone, and `five_hour` appears once the API sends it.
The Herdr mod shows a missing window as "no reading" and never guesses it.
