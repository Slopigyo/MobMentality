# First experiment: local policy listening lab

## Direction and approved scope

MobMentality explores one host's shared music session adapting to the people present. The first experiment uses a local foobar2000 library, with simulated attendees initially and a path to real participation later. Adjustable policies such as Democracy and Diplomacy should make it possible to compare different balances rather than prematurely select a fixed recommendation formula.

**Implemented and approved:** a local, read-only Beefweb connection screen, connection test, source-playlist picker, refresh, and disconnect. The implementation uses Node.js 24+ built-ins and plain browser HTML/CSS/JavaScript, without third-party packages.

This does **not** authorize player/network configuration changes, playback control, persistent attendee profiles, external AI, or the remainder of the policy lab. No scoring formula, numerical policy defaults, or persistent data model has been chosen.

## Current behavior

- The host supplies their own Beefweb address and credentials. There is no built-in account.
- The adapter reads only player identity and playlist metadata. Selecting a source changes MobMentality's temporary session, never the player's active playlist or queue.
- The source is rechecked when selected or refreshed. Missing/empty sources are rejected or cleared, and connection/authentication/permission errors are distinguished.
- There is no database, catalog export, metadata import, background polling, guest interface, policy simulator, recommendation engine, or playback control.
- Credentials and per-tab session tokens are memory-only. Sessions expire after 30 idle minutes; disconnect and service shutdown dispose them. Closing a tab is not a reliable server-side disconnect signal.

See [README.md](README.md) for setup, security boundaries, and validation commands. Tests use a fake Beefweb service and fictional credentials. Private installation details, catalog observations, transcripts, and local preservation records are deliberately excluded from this brief.

## Proposed next steps — approval required

1. **Establish a representative source.** The host selects a source playlist and treats it as read-only. Investigate tag coverage and unavailable/missing metadata without committing real paths or catalog exports.
2. **Build session and selection logic in preview mode.** Keep attendance/preferences, track selection, and player communication separate. Simulated guests use join, preference-update, and leave actions that real guests could later use. Handle unmatched preferences explicitly; longer preference lists and duplicate catalog entries should not automatically grant extra influence.
3. **Add a policy dashboard and repeatable scenarios.** Display attendance, settings, proposed tracks, and reasons for selection. Compare the same scenario and candidate catalog under different settings; use a fixed seed if selection is randomized.
4. **Consider opt-in live control separately.** Only after approval, test a dedicated output playlist, current-track preservation, playback-order settings, the separate explicit playback queue, manual intervention, and recovery. Do not clear existing user playlists or queues. Provide an obvious way to relinquish control.
5. **Consider real guests once the lab is useful.** Reuse session actions, but decide access, consent, expiry, retention, deletion, and unwanted-influence controls before opening guest participation.

## Proposed policy controls

These controls are design proposals, not implemented algorithms or measured defaults:

| Control | Intended effect |
|---|---|
| Host versus crowd influence | How strongly the host's preferences anchor selections. |
| Majority versus broader satisfaction | Whether concentrated tastes dominate or less-represented attendees receive more consideration. |
| Responsiveness | How quickly upcoming selections react to attendance changes. |
| Variety | How strongly recently played tracks and artists are discouraged. |

Democracy and Diplomacy should be understandable presets over visible settings. Define behavior before choosing weights. Responsiveness is a timing/queue rule, not necessarily another score weight; an influence percentage must not promise an exact share of songs unless the algorithm enforces it.

Proposed guardrails remain separate from sliders: do not interrupt the current track because attendance changes, respect explicit host actions, never edit music files/tags, and pause automation visibly when player state cannot be reconciled safely.

## Acceptance scenarios for future work

- An initial crowd establishes a direction; contrasting groups arrive, a much larger group arrives, and groups leave. Compare the same sequence under different policies.
- Arrivals/departures affect future choices, and departing guests stop contributing. Changes should be audible and explainable, not merely different scores.
- Missing tags, unmatched tastes, repeated tracks, and unavailable candidates have explicit outcomes.
- If live control is approved, attendance changes preserve the current track; manual actions and failures do not trigger duplicate additions or unwanted restarts.
- The selection logic is testable without a real player, and guests never receive direct Beefweb access or credentials.

## Boundaries and references

Use loopback when the application and player share a machine. HTTP Basic authentication over plain HTTP is not encrypted; keep player control away from untrusted/public networks. Network/configuration changes and deployment require separate approval. Local playback capability does not settle music-use rights for public or commercial events.

Historical proximity detection, active requests, persistent profiles, streaming integrations, external AI, and cloud infrastructure remain deferred. Follow [CONTRIBUTING.md](CONTRIBUTING.md) before publishing or integrating contributions.

- [Beefweb component listing](https://www.foobar2000.org/components/view/foo_beefweb)
- [Beefweb 0.10 API specification](https://github.com/hyperblast/beefweb/blob/v0.10/docs/player-api.yml)
- [Beefweb 0.10 configuration guide](https://github.com/hyperblast/beefweb/blob/v0.10/docs/advanced-config.md)

Documentation: SLP and Alder.
