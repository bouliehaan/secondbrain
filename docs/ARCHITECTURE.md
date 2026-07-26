# Architecture

## The whole system in one picture

```
   Gmail IMAP ─┐
  Proton Bridge ┼─► lib/sources.js ──► node_helper.js ──socket──► MMM-SecondBrain.js
  Transmission ─┘      (polling,          (schedule,               (render)
                        parsing,           sanitise)
                        merging)
                           │
                           ▼
              /var/lib/magicmirror-secondbrain/
                    package_state.json
```

MagicMirror splits every module in two. `node_helper.js` runs in the server
process and may touch the network and disk. `MMM-SecondBrain.js` runs in the
kiosk browser and may not. They talk over socket notifications.

## The poll cycle

1. The browser sends `SECOND_BRAIN_CONFIG` on load, retrying every 10s until the
   backend answers.
2. `node_helper` clamps the interval to a **60s floor** and starts its timer. It
   owns the schedule — a `SECOND_BRAIN_REFRESH` from the browser is a hint that
   gets ignored if the last poll was recent.
3. Each tick calls `pollAll(configDir, options, log)`, which runs the three
   sources concurrently under `Promise.allSettled` — one dead source cannot take
   down the others.
4. Package results are merged with persisted state, stale ones pruned.
5. Items are sorted by priority, then recency, and capped **per category** so a
   busy inbox cannot crowd out a shipment or a download.
6. `SECOND_BRAIN_UPDATE` goes to the browser, which diffs against the last
   payload and skips the DOM update when nothing changed. Without that the wall
   visibly flashes on every poll.

### Why the 60s floor exists

Every poll opens a fresh IMAP session per account: connect, list, search, fetch,
logout. The config previously asked for 3000ms *and* the frontend ran its own
timer on top, giving roughly a poll every 1.5s. That is a reliable way to get an
account throttled or temporarily locked. The floor is enforced in
`node_helper.js`, not trusted to config.

## Priorities

Higher wins. Ties break toward the more recent item.

| Priority | Kind | Source |
|---|---|---|
| 100 | `voice` | Google Voice — calls, texts, voicemail |
| 95 | `package` | shipments |
| 90 | `warning` | Transmission errors |
| 78 | `email` | Proton unread |
| 75 | `email` | Gmail important mailbox |
| 45 | `download` | active torrents |
| 35 | `download` | recently finished |

Each category has its own display limit (`maxItems`, `maxPackageItems`,
`maxDownloadItems`), so these priorities order *within* a section rather than
competing for one shared list.

## Sources

**Gmail** (`pollGmail`) — three separate scans per account: unread mail in a
dedicated label (default `Wall-Display`), Google Voice notifications in the
inbox, and package mail in All Mail. Mailboxes are resolved by IMAP special-use
where possible, since Gmail localises visible folder names.

**Proton** (`pollProton`) — talks to the local Proton Mail Bridge on
`127.0.0.1:1143`, not to Proton directly. The bridge must be running.

**Transmission** (`pollTransmission`) — RPC, including the 409 session-id
handshake the protocol requires on first contact.

All mailboxes are opened `readOnly: true`. Without it, fetching sets `\Seen` and
the mirror marks real mail as read merely by displaying it.

### Gmail's SEARCH problem

Gmail has been observed returning no UIDs for a time-based `SEARCH` even when
matching messages plainly exist. `fetchRecentSummaries` works around it by
scanning a bounded window of the newest sequence numbers and filtering by
timestamp locally. This also bounds the work per poll, which an open-ended
search does not.

## Package tracking

The part with the most subtlety, because retail email is adversarial by
accident.

**Finding candidates.** `fetchPackageEmails` scans the newest slice of All Mail
and keeps messages whose sender or subject suggests an order. Envelope-only at
first; bodies are fetched for survivors only.

**Parsing.** `extractPackageInfo` tries three shapes in order — storefront order
mail, Amazon, then a bare carrier notification — and returns `null` for refunds,
cancellations and digital receipts.

**Tracking numbers are matched twice, never against raw MIME.** Matching the raw
source means matching base64 attachment payloads, which will happily yield a
UPS-shaped string that appears nowhere a human can see. So both passes run over
the *decoded* body:

- a **strict** pass over readable text, requiring punctuation or a string edge
  on both sides
- a **relaxed** pass over the whitespace-stripped copy, which is the only way to
  catch a number the sending client wrapped across two lines — guarded so it
  cannot match inside a longer digit run

A bare 12- or 15-digit run is only treated as FedEx if the message actually says
"FedEx". Account numbers are the same shape.

**Identity must be stable.** A message with no order number is keyed by a digest
of sender, subject and date. Keying it randomly — as an earlier version did —
mints a new id every poll, which means duplicate cards and a state file that
grows forever.

**Merging.** One shipment is announced several times (ordered → shipped → out
for delivery), often under different identifiers. `deduplicate` collapses them
by id, tracking number, or order number, keeping the newest status while
inheriting the best title and any identifiers the other messages carried.

**Persistence.** Retailers stop mentioning a shipment once delivered, so state
outlives the mail. `package_state.json` lives in `stateDir`
(`/var/lib/magicmirror-secondbrain`) — *not* beside the module, which the
service user cannot write. Delivered items are kept 48h. An unwritable directory
degrades to in-memory with one warning rather than one per poll.

## Configuration

| Where | What |
|---|---|
| `config/config.js` | dashboard layout, module list — deployed whole |
| `config/secondbrain/*.example.json` | credential templates |
| `/etc/magicmirror-secondbrain/` | the real credentials, on the mirror only |
| `/var/lib/magicmirror-secondbrain/` | runtime state, owned by `calendar-display` |

Real credentials are gitignored and never leave the mirror.

## Other modules

`MMM-SolarTheme` switches light/dark on sun position. `MMM-CalendarLiveHeader`
renders the greeting header. `MMM-CalendarExt3` and `MMM-CalendarExt3Agenda` are
upstream, pinned in `config/third-party-modules.json` and installed by
`scripts/bootstrap.sh`.

`MMT-CalmCurrentWeather` is referenced by `config.js` as a weather `themeDir` but
has no source here — it exists only on the mirror. `scripts/pull-from-pi.sh`
recovers it.
