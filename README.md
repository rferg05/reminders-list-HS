# Reminders List

Home Screens module: shared to-do lists that everyone edits in the **iPhone Reminders app**, shown on the wall large enough to read across the room.

The lists live in **Radicale**, a small CalDAV server on the same Pi as Home Screens. Each iPhone adds it as a Reminders account, so the shared lists sit next to everyone's own: add "Milk" with Siri or check something off in the store, and the wall shows it within a minute. A list someone makes on their phone under Home shows up on the wall by itself.

```
 iPhones ──(Reminders app, CalDAV, home Wi-Fi)──▶ Radicale on the Pi :5232
                                                       │
 Home Screens display ◀──(read-only account)───────────┘
```

- **Home Wi-Fi only.** Radicale listens on the LAN, not the internet. Changes made away from home wait on the phone and sync the next time it's on the home Wi-Fi.
- **Display only.** The module shows the list; the phones do all the editing. Its account can read lists but not change them.
- **Finding lists.** Listing an account's lists takes a CalDAV PROPFIND. Home Screens' proxy only passes GET, POST, PUT and PATCH, and its pages may not call Radicale's address directly. So the installer adds **radicale-lists**, a small Python helper on port 5233 (Radicale's port plus one) that answers a GET on `/family/` by asking Radicale on the module's behalf. It holds no passwords: the module's own login is passed on. Each list is then read through the proxy with a plain GET.
- **Light.** Radicale is one Python process using about 30 MB of memory, with the list kept as plain files in `/var/lib/radicale/collections`.

## What it shows

- **Every list under Home**, in the phones' order, each with its own heading in the color it has on the phones. Or just the lists you name, in your order, or one list on its own.
- **Each reminder** with a ring in the *Accent color*, its title (up to two lines), and under it the due date: *Today 5p*, *Tomorrow*, *Fri*, *Nov 20*. Overdue ones are red, and so is something due at a time today that has passed. Things due today are in the accent color.
- **Priority** as the Reminders app marks it: `!`, `!!`, `!!!`.
- **Subtasks** indented under their parent, when the phone sends them.
- **Order:** the order items are dragged into on the phones (the default), or due soonest first with undated ones last.
- **Checked-off items** disappear at once, or stay at the bottom crossed out for up to 48 hours (*Keep checked-off items for*), so everyone can see what got done.
- **Fitting:** text is sized from the Style panel's Text size, times *Text size*. Lists flow down a column and on into the next. With *Columns* on Auto, a second or third column is used only when one column won't hold everything. Whatever still doesn't fit is cut from the longest list first, each ending "+3 more", so one long list can't push the others off. A list's heading never sits alone at the bottom of a column.
- **Headings:** each list's name and how many are left to do. Empty lists say *All done*, or can be hidden.
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

**Installed before 1.2.0?** Download the installer again and re-run it to add radicale-lists, which the module needs to find every list. Your passwords and lists stay as they are.

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
| Address | `http://192.168.1.14:5232/family/` |
| User name | `display` |
| Password | the display password the installer printed |

The family account's address shows every list under Home. To show only some, put their names in **Only these lists**, like `Household, Groceries`. For one list on its own, use its address instead, like `http://192.168.1.14:5232/family/household/`. Lists made on a phone have a random folder name, shown on Radicale's web page, `http://192.168.1.14:5232/.web/` (sign in as `family`).

Use the Pi's network address, not `localhost`: Home Screens doesn't let plugins reach the Pi itself by `localhost`.

## What syncs from the Reminders app

CalDAV carries the basics: titles, notes, due dates and times, priority, completion, and order. **Flags, tags, sections, images, location reminders and URLs are iCloud-only** and stay on the phone that set them. Some iOS versions don't send subtasks over CalDAV either; they then show as ordinary items.

## Settings

| Setting | Default | |
|---|---|---|
| Address | | The family account's address for every list, or one or more list addresses separated by commas. |
| User name / Password | `display` / | The read-only account. Stored in the module's settings like any other field, which is why it can't change anything. |
| Only these lists | | With the account address: names, comma-separated, in the order to show them. Empty shows all, in the phones' order. |
| Check for changes every | 60 s | 15 s to 15 min. Radicale answers in milliseconds. |
| Heading / Show heading | list's name / on | One list: replaces its name. Several: a heading above them all. |
| Each list's color from the phones | on | Its heading rule, rings and priority marks. Off uses the Accent color. |
| Hide empty lists | off | With several lists. |
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
| Can't ask ... for its lists | radicale-lists isn't answering on port 5233. Installed before 1.2.0: re-run the installer. Otherwise `sudo systemctl status radicale-lists`. |
| Home Screens blocked the request | The address is `localhost` or `127.0.0.1`; use the Pi's network address. |
| Turned down the user name or password | Re-run the installer with `--reset-passwords`, then update the module. |
| This account can't read that list | The list belongs to an account other than `family`. |
| Nothing at that address | Check the address; the family account's is `http://<pi>:5232/family/`. |
| None of those lists were found | The names in *Only these lists* don't match the phones'. |

If a phone stops syncing: **Settings > Apps > Reminders > Reminders Accounts > Home**, and check the account is on and the password is current.

**Back up** `/var/lib/radicale/collections` with the rest of the Pi; it's plain files. `/etc/radicale/users` holds the password hashes.

## Development

```bash
npm install
npm test             # parsing recorded Radicale output, finding lists, order, due labels, addresses
npm run preview      # module against a fake list at http://localhost:5183
npm run build        # dist/bundle.js
```

The preview shows three fake lists. It takes `?w=&h=` for the module size, `fs=` for text size, `tz=`, `fail=1` to start with Radicale unreachable, `nohelper=1` for a Pi without radicale-lists, and any config key (`onlyLists=Groceries`, `sortBy=due`, `keepDoneHours=6`, or one list's own `listUrl=`). Its buttons add and check off items the way a phone would.

The fixtures are real Radicale 3.9 answers: `radicale-household.ics` is a GET on a list holding what the Reminders app writes, and `radicale-propfind-family.xml` a Depth 1 PROPFIND on the family account. To record new ones, run Radicale locally with the installer's config, add lists and items over CalDAV, and save what a GET on `/family/<list>/` and a PROPFIND on `/family/` return (the PROPFIND radicale-lists sends is in the installer).

Release tarball:

```bash
mkdir -p release/pkg/reminders-list/dist
cp manifest.json release/pkg/reminders-list/
cp dist/bundle.js dist/bundle.js.map release/pkg/reminders-list/dist/
tar -czf release/reminders-list-<version>.tar.gz -C release/pkg reminders-list
cp release/reminders-list-<version>.tar.gz release/reminders-list.tar.gz
gh release create v<version> release/reminders-list-<version>.tar.gz release/reminders-list.tar.gz --title v<version>
```
