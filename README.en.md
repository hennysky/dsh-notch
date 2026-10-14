# DSHNotch

**Keep an eye on your DeepSeek Harness balance, right on your Mac.**

[中文](README.md) · [Download](https://github.com/hennysky/dsh-notch/releases) · [Engineering notes](docs/engineering-notes.md)

Click the notch (or the menu bar item) to see your balance. When it drops below a threshold,
or when a single top-up burn is unusually large, DSHNotch pops up to tell you.

| MacBook with a notch | Any other Mac (Mac mini / iMac / external display) |
|---|---|
| ![Notch mode](preview/balance.png) | ![Menu bar mode](preview/menubar.png) |
| Click the notch to expand the card | Balance shown right in the menu bar; click to open the card |

---

## What this is for

Your DSH balance is only visible inside the DSH app. While a long task is running,
you have no idea how much has been spent until you go look — and by then it is often nearly gone.

DSHNotch puts the balance somewhere you already look, and speaks up when something is wrong.

The scope is deliberately narrow: **read-only balance. No top-up flow, no billing history,
no access to your account beyond what DSH already stores.**

---

## Installation

### Requirements

| | |
|---|---|
| Hardware | Apple Silicon Mac (every MacBook with a notch is Apple Silicon) |
| OS | macOS 14.0 or later |
| Prerequisite | DeepSeek Harness installed and signed in — the balance comes from its stored credentials |

### Download

[GitHub Releases](https://github.com/hennysky/dsh-notch/releases) ·
[Gitee releases](https://gitee.com/hennysky/dsh-notch/releases) (faster from mainland China)

The packages on both platforms are byte-for-byte identical. Either one works.

### One-line install

```bash
# GitHub
curl -fL -o /tmp/DSHNotch.zip \
  https://github.com/hennysky/dsh-notch/releases/download/v1.0.2/DSHNotch-1.0.2.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

```bash
# Gitee
curl -fL -o /tmp/DSHNotch.zip \
  https://gitee.com/hennysky/dsh-notch/releases/download/v1.0.2/DSHNotch-1.0.2.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

### Manual install

1. Download `DSHNotch-1.0.2.zip`
2. Unzip it and drag `DSHNotch.app` into `/Applications`
3. **The first launch must be right-click → Open** (see below)

### Why right-click → Open on first launch

The app is not signed with an Apple Developer ID and is not notarized (that costs $99/year).
Gatekeeper blocks unsigned apps, so a double-click just says "cannot be opened".
Right-click → Open is a one-time override; you will not be asked again.

If you prefer, drop the quarantine flag instead:

```bash
xattr -dr com.apple.quarantine /Applications/DSHNotch.app
```

That command removes the "downloaded from the internet" flag. The app never downloads anything:
it reads the credentials DSH already stored on this machine and calls DeepSeek's balance endpoint.

---

## Usage

### Two modes, chosen automatically

**There is nothing to pick during installation, and you do not need to know whether your Mac
has a notch.** The app decides at runtime and re-decides whenever your displays change:

| Situation | Mode |
|---|---|
| MacBook with a notch | **Notch mode** — click the notch to expand the card |
| Mac mini / iMac / external display only | **Menu bar mode** — balance in the menu bar, click to open the card |
| MacBook in clamshell with an external display | Switches to menu bar mode automatically; **nothing is lost** |

You can also pin one mode in Settings: Auto / Notch only / Menu bar only.

### What the card shows

```
● DeepSeek Harness                    ⚙  ↻
¥20.75
Recharge wallet balance
────────────────────────────────
Bonus wallet                    ¥0.00
Total spent                    ¥555.11
Spent today                     ¥2.63
────────────────────────────────
Updated 15:23:57            [ Top up ↗ ]
```

- **Top up ↗** opens the platform's top-up page in your browser, using the browser's own
  session. The link carries no token.
- **↻** forces a refresh
- **⚙** opens Settings

### When the balance refreshes

| Trigger | Behaviour |
|---|---|
| **Opening the card / menu bar item** | **Refreshes immediately — what you see is current** |
| Background polling | Every 5 minutes |
| Clicking ↻ | Immediate, no throttle |

Opening the card is throttled to at most once every 30 seconds — otherwise clicking repeatedly
would hit the platform's rate limit.

### Balance alerts

The balance is hidden behind the notch, so there are two rules that speak up on their own:

| Rule | Default | Behaviour |
|---|---|---|
| **Balance below** | ¥10 | Fires once, at the moment it crosses the line |
| **Single burn above** | ¥2 | Fires when the drop between two polls is large |

- Set a threshold to **0 to disable that rule**
- When both fire, the low-balance one wins
- **Notch mode**: the card pops out by itself and retracts after a few seconds
- **Menu bar mode**: the menu bar title turns into the alert (`¥5.74 → ⚠ ¥5.74`) —
  it will not interrupt what you are doing
- Any click from you takes over immediately

> Why does "balance below" fire only once? Because polling runs every 5 minutes; alerting on
> "is currently low" would mean a popup every 5 minutes. Recharging above the threshold re-arms it.

### Settings

Click the slider icon in the card header. Three pages:

| Page | Contents |
|---|---|
| **Alerts** | Low-balance threshold, single-burn threshold, how long alerts stay up |
| **Animation** | Expand/collapse duration and easing curve |
| **General** | Presentation mode, launch at login |

Changes take effect immediately and are remembered.

### Quit / uninstall

| | |
|---|---|
| **Quit** | Click the notch → slider icon → "Quit" |
| **Launch at login** | Settings → General → Launch at login |
| **Uninstall** | Delete `DSHNotch.app`. Preferences live in the UserDefaults domain `local.dsh.notch`; delete that too for a clean removal |

---

## Where the data comes from

```
~/.dsh/.credentials.yaml          ← the platform grant DSH stored on this machine
        ↓
GET {platform}/api/v0/users/get_user_summary
Header: x-dsh-auth-token: <token>
        ↓
normal_wallets / bonus_wallets / total_costs
```

- **Your credentials are never modified or uploaded.** The token is sent only as a header to
  DeepSeek's own balance endpoint.
- The top-up link is derived from the same credential, and **carries no token**
- On a failed query the app **keeps the last successful data** and labels it — it never
  manufactures a ¥0.00
- Amount fields accept both shapes the platform uses (decimal strings and JSON numbers)

### How "spent today" is computed

The platform API **has no per-day dimension** — it only exposes cumulative spend (`total_costs`).
So "spent today" is reconstructed locally: record the cumulative value at the start of the day,
and take the difference.

When the day's starting point is unknown (first run, or the app was closed for days),
the app does **not** show ¥0.00 — that would disguise "unknown" as "nothing spent":

| Baseline | Shown | Meaning |
|---|---|---|
| Reliable | `¥2.63` | Exact |
| Unreliable, no increase yet | `统计中` (counting) | Waiting for the first increase |
| Unreliable, some increase | `≥¥2.63` | At least this much |

It becomes exact from the next day onward.

---

## FAQ

**Clicking the notch does nothing.**
Make sure you are actually hitting the notch region (the top edge of the screen, roughly the
middle 193pt). If it stays unresponsive, run the self-checks below and attach
`/tmp/dsh-notch.log` to an issue (start the app with `DSH_NOTCH_DEBUG=1` first).

**Why does "spent today" say `统计中`?**
See the section above. It is the honest display when no reliable baseline exists yet.

**Does it send my token anywhere?**
No. There are exactly two network operations: the balance query (to DeepSeek's platform) and
opening the top-up page (handed to your browser; the link contains no token). Nothing is reported
anywhere else.

**Does it work on Intel Macs?**
No — arm64 only. Every MacBook with a notch is Apple Silicon.

**There is no icon in my menu bar.**
Settings → General → Presentation mode. If it is pinned to "Notch only" but the current screen
has no notch, the app falls back to menu bar mode and logs a line.

---

## Self-checks

The project ships 8 self-checks, **none of which require eyes** — the development environment
has no screen-recording permission, so every claim has to be verifiable by command:

```bash
BIN=/Applications/DSHNotch.app/Contents/MacOS/DSHNotch

$BIN --selftest        # credentials + API call + parsing
$BIN --modecheck       # mode resolution: notch / menu bar / clamshell / forced
$BIN --refreshcheck    # refresh policy: the 30-second throttle boundary
$BIN --alertcheck      # alert rules: 8 threshold scenarios
$BIN --costcheck       # "spent today": day rollover, gaps, bad values
$BIN --settingscheck   # settings persistence
$BIN --panelcheck      # window placement + layer above the menu bar
$BIN --clicktest       # click path + hit testing + content pixels + mid-animation sampling
```

Two extra switches for debugging display issues:

```bash
DSH_NOTCH_DEBUG=1 $BIN      # log state changes, actual window frames, window-server layers
DSH_NOTCH_TEST_ALERT=3 $BIN # simulate an alert 3 seconds after launch
```

---

## Known limitations

1. **Not signed or notarized.** First launch needs right-click → Open.
2. **The API is rate limited.** HTTP 429 was hit during development; that is why opening the
   card is throttled to once per 30 seconds.
3. **Launch at login is not verified on a real machine.** macOS may refuse to register a login
   item for an unsigned app; if it fails the setting reverts to the actual system state.
   You can always add it manually in System Settings → General → Login Items.
4. **Window layering in full-screen and multi-display setups has not been visually verified.**
5. **"Spent today" is reconstructed locally** — the platform has no per-day data.
6. **arm64 only.**
7. **The credentials come from a DSH-internal file** whose format may change between DSH
   versions. A parse failure produces a clear error rather than a silently wrong number.

---

## Development

```bash
git clone https://github.com/hennysky/dsh-notch.git
cd dsh-notch
./build.sh      # → build/DSHNotch.app
./release.sh    # → dist/DSHNotch-x.y.zip
```

A Swift toolchain is required. **The deployment target must be set explicitly** — without it the
build inherits the toolchain default and stamps `LC_BUILD_VERSION` with the current OS version,
producing a package nobody can run. `toolchain.sh` pins it.

Architecture and the reasoning behind implementation choices are in the
[engineering notes](docs/engineering-notes.md) (Chinese).

---

## License

[MIT](LICENSE)
