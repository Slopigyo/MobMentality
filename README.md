# MobMentality

A party's music adapts to the people who show up: the host supplies the listening session, and the crowd influences what plays next.

## Status

**The first read-only host console is implemented; crowd-adaptive playback is not.** Connect to Beefweb with your own credentials, test read access, refresh playlists, and select a source in temporary app memory. Nothing changes foobar2000's active playlist, queue, playback, files, tags, or configuration.

The application uses **Node.js 24+ and plain browser HTML/CSS/JavaScript**, with no third-party packages, build step, database, or deployment. Simulated attendees and adjustable policies are proposed next steps, described in [EXPERIMENT.md](EXPERIMENT.md); they are not implemented yet.

## Run the host console

Prerequisites: Node.js **24 or newer**, plus an existing foobar2000 installation with [Beefweb](https://www.foobar2000.org/components/view/foo_beefweb). No `npm install` is needed.

```sh
npm start
```

Open **http://127.0.0.1:3210**. Use the printed loopback address: the console does not listen on the LAN or accept arbitrary Host headers. If the port is occupied, run `npm start -- --port 3211`. Stop with **Ctrl+C**.

1. Leave foobar2000 and Beefweb running. Enter your Beefweb base address, username, and password. The form starts with Beefweb's documented default, `http://127.0.0.1:8880`; change it to your configured address. No account details are built in.
2. Choose **Test connection** to read player identity and playlist metadata.
3. Choose a non-empty playlist and press **Select source**. This records an app-local reference; it does not activate that playlist in foobar2000.
4. Use **Refresh playlists** for an updated snapshot. A removed or newly empty source is cleared from the app's selection.
5. Use **Disconnect** to release the session and credentials. The player is left alone.

## Privacy and connection boundaries

- The only Beefweb calls implemented are **`GET /api/player` and `GET /api/playlists`**. Local POST routes establish/end sessions or select an app-local source; they are never forwarded to Beefweb.
- Credentials and catalog data are not saved to files, cookies, local storage, or session storage. Each tab's session token exists only in memory. Sessions expire after **30 minutes of inactivity**; expired access is rejected immediately and abandoned session references are swept at least once per minute. Disconnect and service shutdown dispose sessions. Reloading/closing a tab loses its token but does not guarantee immediate server-side deletion; disconnect first when possible.
- Beefweb addresses may use HTTP or HTTPS with a root or `/api` base path. Only loopback/private LAN addresses and hostnames resolving exclusively to permitted private addresses are accepted. Public, unspecified and link-local targets, embedded credentials, query strings, fragments, redirects, and arbitrary proxy paths are rejected. HTTPS certificate validation is not disabled.
- Prefer loopback when both programs run on the same machine. **HTTP Basic authentication over plain HTTP is not encrypted.** Use only a trusted network and do not expose the control API publicly.
- Authentication failures, permission refusals, unavailable servers, timeouts, and invalid responses are distinguished. There is no background polling or automatic retry. This is a local experiment, not a hardened multi-user hosting service; other programs on the host are outside its trust boundary.

## Validation

For relevant code, test, dependency, or configuration changes:

```sh
npm test
npm run check
```

The fixture-based tests cover authenticated reads, address/redirect restrictions, response limits, session disposal/expiry, source selection/invalidation, sanitized errors, origin/Host checks, and the absence of upstream write requests. They use generated fictional credentials, not a real player or library.

For browser behavior changes, an optional smoke check uses an **already installed Firefox** executable. For a standard Windows installation:

```sh
npm run test:browser -- "C:\Program Files\Mozilla Firefox\firefox.exe"
```

Supply your actual executable path if different. The bounded check uses temporary fixture/app servers and an isolated profile, then cleans up its resources. It does not download a browser or touch the real player. Normal console use is not restricted to Firefox.

**Validate changes, not conversation turns.** Reuse recent results when the tested inputs have not changed; do not rerun suites merely because work resumes, files are copied, or publication is being prepared. For prose-only changes, check accuracy, links, and the diff. Start with focused checks for changed behavior, and use broader/browser checks only when warranted. Report what actually ran and what remains unverified; do not keep routine pass reports.

[The Checks workflow](.github/workflows/checks.yml) defines `Node 24 checks` on GitHub-hosted Windows for PRs targeting `master`, pushes to `master`, and manual dispatch. It uses read-only permissions and fixtures, not real player credentials. Branch protection is a separate maintainer-approved setting.

## Working together

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for focused branches, cohesive commits, PR review, upstream checks, and publication approval. Routine read-only upstream checks are approved during active development; integration, publication, and repository-setting changes require authorization. There is no unattended contribution monitor.

Read the public project documents before proposing changes. The approved scope is the read-only console, not playback control, persistent attendee profiles, new integrations, or the whole historical feature set. Private transcripts, local inspection notes, and preservation archives are not part of this public delivery and are not prerequisites for contributors.

## Historical concept

The project dates to 2013. [MM_Outline.pptx](MM_Outline.pptx) is the original four-slide design, not an implemented specification:

| Slide | Ideas explored |
|---|---|
| High-level outline | Participants, hosts, proximity-based membership, passive influence, active requests, and music output. |
| Passive influence/preference | Seed tastes, evolving weights, and a shared subset of private preferences. |
| Active demands | Shout-Out requests to a group and Shove requests to a person. |
| New session | Combine host preferences with crowd influence and requests. |

[Preference Ideas](Preference%20Ideas), `map.png`, `Hmmm`, and the inherited artifacts remain preserved. Their old API names, algorithms, links, and platform assumptions are historical context, not verified modern requirements. AI-assisted development does not require an AI model in the product. The current direction is a shared party-host session, not separate listening streams for nearby strangers.

## Project structure

| Path | Purpose |
|---|---|
| `src/server.js` | Loopback service, in-memory sessions, and app-local source selection. |
| `src/beefweb.js` | Bounded, read-only Beefweb adapter. |
| `web/` | Host connection form and source picker. |
| `test/` | Node tests with synthetic fixtures. |
| `scripts/browser-smoke.js` | Optional installed-Firefox check. |
| `EXPERIMENT.md` | Implemented scope and proposed next steps. |
| `CONTRIBUTING.md` | Collaboration and publication practices. |
| `AGENTS.md` | Coding-agent guidance. |
| `.github/` | PR template and CI definition. |

## Attribution and rights

Original concept: SLP and friends. Historical documents and attribution remain preserved; revival documentation does not reassign their authorship.

Documentation: SLP and Alder.

No license has been selected. Public availability is not a blanket reuse or redistribution license. Do not assume rights to third-party music, artwork, data, or code, and do not choose a project license without ownership review and approval.
