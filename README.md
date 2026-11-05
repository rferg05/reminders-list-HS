# Reminders List

Home Screens module: a shared to-do list that everyone edits in the **iPhone Reminders app**, shown on the wall large enough to read across the room.

The list lives in **Radicale**, a small CalDAV server on the same Pi as Home Screens. Each iPhone adds it as a Reminders account, so it sits next to everyone's own lists: add "Milk" with Siri or check something off in the store, and the wall shows it within a minute.

```
 iPhones ──(Reminders app, CalDAV, home Wi-Fi)──▶ Radicale on the Pi :5232
                                                       │
 Home Screens display ◀──(read-only account)───────────┘
```

- **Home Wi-Fi only.** Radicale listens on the LAN, not the internet. Changes made away from home wait on the phone and sync the next time it's on the home Wi-Fi.
- **Display only.** The module shows the list; the phones do all the editing. Its account can read lists but not change them.
- **Light.** Radicale is one Python process using about 30 MB of memory, with the list kept as plain files in `/var/lib/radicale/collections`.

## What it shows

- **Each reminder** with a ring in the *Accent color*, its title (up to two lines), and under it the due date: *Today 5p*, *Tomorrow*, *Fri*, *Nov 20*. Overdue ones are red, and so is something due at a time today that has passed. Things due today are in the accent color.
- **Priority** as the Reminders app marks it: `!`, `!!`, `!!!`.
- **Subtasks** indented under their parent, when the phone sends them.
- **Order:** the order items are dragged into on the phones (the default), or due soonest first with undated ones last.
- **Checked-off items** disappear at once, or stay at the bottom crossed out for up to 48 hours (*Keep checked-off items for*), so everyone can see what got done.
- **Fitting:** text is sized from the Style panel's Text size, times *Text size*. With *Columns* on Auto, a long list in a wide module flows into a second or third column only when one column won't hold it. Whatever still doesn't fit ends with "+3 more".
- **The heading** is the list's name from the phones (or your own), with how many are left to do.
- **Offline:** if Radicale stops answering, the last copy stays up with "Not updated since 3:42p" beside the heading. It survives a page reload.

## Setup

### 1. Install Radicale on the Pi

Over SSH or in the Pi's terminal:

```bash
curl -fsSLO https://raw.githubusercontent.com/rferg05/reminders-list-HS/main/install/install-radicale.sh
```

```bash
sudo bash install-radicale.sh
```

It asks for a password for the **family** account, the one every iPhone signs in to. Then it installs Radicale from Raspberry Pi OS's own packages, makes a read-only **display** account for the dashboard, creates a list called **Household**, and starts Radicale on port **5232**. At the end it prints what to enter on the phones and in the module, and saves that to `/etc/radicale/NEXT-STEPS.txt`.

`--list "Groceries"` names the starter list something else. Re-running is safe: it keeps the passwords and lists. `--reset-passwords` picks new ones.

Give the Pi a fixed address in your router's DHCP settings (a "reservation") so the phones keep finding it. The examples here use `192.168.1.14`.

### 2. Add the list to each iPhone

On the home Wi-Fi: **Settings > Apps > Reminders > Reminders Accounts > Add Account > Other > Add CalDAV Account**.

| Field | Value |
|---|---|
| Server | `192.168.1.14:5232` |
| User Name | `family` |
| Password | the family password |
| Description | `Home` |

Tap **Next**. When it says it can't connect using SSL, tap **Continue**. If it still fails, open **Advanced Settings**: turn **Use SSL** off, set **Port** to `5232` and **Account URL** to `http://192.168.1.14:5232/family/`. On the last page turn **Reminders** on and **Calendars** off.

The Household list shows up in Reminders under **Home**. Lists anyone makes under Home are shared with every phone too. To make Siri use the shared list, name it: "Add milk to the Household list".

### 3. Add the module

In the Home Screens editor, open the Plugin Store, choose **Install from URL**, and paste:

```
https://github.com/rferg05/reminders-list-HS/releases/latest/download/reminders-list.tar.gz
```

Add **Reminders List** to a screen (Information category) and fill in its **List** settings from what the installer printed:

| Setting | Value |
|---|---|
| List address | `http://192.168.1.14:5232/family/household/` |
| User name | `display` |
| Password | the display password the installer printed |

Use the Pi's network address, not `localhost`: Home Screens doesn't let plugins reach the Pi itself by `localhost`. To show another list, find its address on Radicale's web page, `http://192.168.1.14:5232/.web/` (sign in as `family`), and add a second module.

## What syncs from the Reminders app

CalDAV carries the basics: titles, notes, due dates and times, priority, completion, and order. **Flags, tags, sections, images, location reminders and URLs are iCloud-only** and stay on the phone that set them. Some iOS versions don't send subtasks over CalDAV either; they then show as ordinary items.

## Settings

| Setting | Default | |
|---|---|---|
| List address | | The list's Radicale address, ending in `/`. |
| User name / Password | `display` / | The read-only account. Stored in the module's settings like any other field, which is why it can't change anything. |
| Check for changes every | 60 s | 15 s to 15 min. Radicale answers in milliseconds. |
| Heading / Show heading | list's name / on | |
| Order | Same as on the phones | Or due soonest first. |
| Columns | Auto | Or 1, 2 or 3. |
| Due dates / Priority marks / First line of notes | on / on / off | |
| Keep checked-off items for | 0 hours | Up to 48. |
| When the list is empty, show | All done | |
| Text size | 1× | 0.5–2.5×, on top of the Style panel's Text size. |
| Accent color | amber | Rings, heading underline, priority marks, due today. |
| Clock times | Household setting | Or 12-hour (5p, 5:30p) or 24-hour. |

## Troubleshooting

| The module says | |
|---|---|
| Can't reach Radicale | `sudo systemctl status radicale`, and check the address. `sudo journalctl -u radicale -n 50` shows why it stopped. |
| Home Screens blocked the request | The address is `localhost` or `127.0.0.1`; use the Pi's network address. |
| Turned down the user name or password | Re-run the installer with `--reset-passwords`, then update the module. |
| This account can't read that list | The list belongs to an account other than `family`. |
| No list at that address | Copy the address from `http://<pi>:5232/.web/`. |

If a phone stops syncing: **Settings > Apps > Reminders > Reminders Accounts > Home**, and check the account is on and the password is current.

**Back up** `/var/lib/radicale/collections` with the rest of the Pi; it's plain files. `/etc/radicale/users` holds the password hashes.

## Development

```bash
npm install
npm test             # parsing recorded Radicale output, order, due labels, addresses
npm run preview      # module against a fake list at http://localhost:5183
npm run build        # dist/bundle.js
```

The preview takes `?w=&h=` for the module size, `fs=` for text size, `tz=`, `fail=1` to start with Radicale unreachable, and any config key (`sortBy=due`, `keepDoneHours=6`). Its buttons add and check off items the way a phone would.

`src/fixtures/radicale-household.ics` is a real GET from Radicale 3.9, holding what the Reminders app writes. To record a new one, run Radicale locally, add items over CalDAV, and save `curl -u display:… http://127.0.0.1:5232/family/<list>/`.

Release tarball:

```bash
mkdir -p release/pkg/reminders-list/dist
cp manifest.json release/pkg/reminders-list/
cp dist/bundle.js dist/bundle.js.map release/pkg/reminders-list/dist/
tar -czf release/reminders-list-<version>.tar.gz -C release/pkg reminders-list
cp release/reminders-list-<version>.tar.gz release/reminders-list.tar.gz
gh release create v<version> release/reminders-list-<version>.tar.gz release/reminders-list.tar.gz --title v<version>
```
