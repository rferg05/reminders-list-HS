#!/usr/bin/env bash
# Installs Radicale on the Raspberry Pi that runs Home Screens, as the shared
# home for a reminders list the family edits in the iPhone Reminders app.
#   - one "family" account that every iPhone signs in to, so a list made on
#     any phone shows up on all of them
#   - one read-only "display" account for the Reminders List module
#   - a list called Household, ready to use
#   - LAN only: HTTPS on port 5443 for the phones (current iOS won't send a
#     CalDAV password over plain HTTP), plain HTTP on 5232 for the dashboard
#   - a certificate authority of its own, which phones install once to trust
#     the Pi's HTTPS certificate
#   - radicale-lists, a small helper on port 5233 that lets the module find
#     every list in the family account (see the note at its section)
#
# Usage (on the Pi):
#   sudo bash install-radicale.sh
#   sudo bash install-radicale.sh --list "Groceries"     # name of the starter list
#   sudo bash install-radicale.sh --reset-passwords      # pick new passwords
#
# Re-running is safe: it keeps existing passwords, lists and the certificate
# authority, renews the Pi's certificate when it's due, and rewrites only
# Radicale's config and rights files (backing up the old ones first) and the
# helper.

set -euo pipefail

PORT=5232
HTTPS_PORT=5443
HELPER_PORT=$((PORT + 1))   # the module looks for it on Radicale's port plus one
HELPER_DIR="/opt/radicale-lists"
CONF_DIR="/etc/radicale"
TLS_DIR="$CONF_DIR/tls"
USERS_FILE="$CONF_DIR/users"
RIGHTS_FILE="$CONF_DIR/rights"
STORAGE="/var/lib/radicale/collections"
NOTES="$CONF_DIR/NEXT-STEPS.txt"
FAMILY_USER="family"
DISPLAY_USER="display"

LIST_NAME="Household"
RESET=0

# ── Output ───────────────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Arguments ────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) LIST_NAME="${2:?--list needs a name}"; shift 2 ;;
    --reset-passwords) RESET=1; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"

# The folder name in the list's address: "Household" -> household
LIST_SLUG="$(printf '%s' "$LIST_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')"
[[ -n "$LIST_SLUG" ]] || LIST_SLUG="list"

# The address phones and the module use. The first LAN address the Pi has.
PI_IP="$(hostname -I | awk '{print $1}')"
[[ -n "$PI_IP" ]] || die "Couldn't find the Pi's network address (hostname -I printed nothing)."

# ── Packages ─────────────────────────────────────────────────────────────────

step "Installing Radicale"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq radicale apache2-utils python3-bcrypt curl openssl >/dev/null
bold "$(radicale --version 2>/dev/null | tail -n1 | sed 's/^/Radicale /')"

# ── Accounts ─────────────────────────────────────────────────────────────────

ask_password() {
  local who="$1" a b
  while true; do
    read -r -s -p "Password for the $who account: " a; echo
    [[ ${#a} -ge 8 ]] || { warn "Use at least 8 characters."; continue; }
    read -r -s -p "Again: " b; echo
    [[ "$a" == "$b" ]] && break
    warn "They didn't match. Try again."
  done
  printf '%s' "$a"
}

has_user() { [[ -f "$USERS_FILE" ]] && grep -q "^$1:" "$USERS_FILE"; }

step "Setting up accounts"
touch "$USERS_FILE"
FAMILY_PASSWORD=""
if ! has_user "$FAMILY_USER" || [[ $RESET -eq 1 ]]; then
  echo "Everyone signs in to the '$FAMILY_USER' account on their iPhone, so pick"
  echo "something you're happy to type on each phone."
  FAMILY_PASSWORD="$(ask_password "$FAMILY_USER")"
  # -i reads the password from stdin, keeping it out of the process list.
  printf '%s' "$FAMILY_PASSWORD" | htpasswd -B -i "$USERS_FILE" "$FAMILY_USER" >/dev/null 2>&1
else
  echo "Keeping the existing '$FAMILY_USER' password (--reset-passwords to change it)."
fi

DISPLAY_PASSWORD=""
if ! has_user "$DISPLAY_USER" || [[ $RESET -eq 1 ]]; then
  DISPLAY_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
  printf '%s' "$DISPLAY_PASSWORD" | htpasswd -B -i "$USERS_FILE" "$DISPLAY_USER" >/dev/null 2>&1
  echo "Made the read-only '$DISPLAY_USER' account for the dashboard."
else
  echo "Keeping the existing '$DISPLAY_USER' password."
fi
chown root:radicale "$USERS_FILE"
chmod 640 "$USERS_FILE"

# ── Config ───────────────────────────────────────────────────────────────────

backup() { [[ -f "$1" ]] && cp -a "$1" "$1.bak.$(date +%Y%m%d-%H%M%S)" || true; }

step "Writing $CONF_DIR/config and rights"
# Phones capitalize the first letter of a user name ("Family"). Radicale can
# lowercase names before checking them, if this version has the option.
LC_USERNAME=""
if python3 -c 'import sys, radicale.config as c; sys.exit(0 if "lc_username" in dict(c.DEFAULT_CONFIG_SCHEMA["auth"]) else 1)' 2>/dev/null; then
  LC_USERNAME="lc_username = True"
else
  warn "This Radicale can't ignore case in user names: type them in lowercase."
fi
backup "$CONF_DIR/config"
cat > "$CONF_DIR/config" <<EOF
# Written by install-radicale.sh. LAN only: phones and the Home Screens
# module reach it at http://$PI_IP:$PORT/
[server]
hosts = 0.0.0.0:$PORT, [::]:$PORT

[auth]
type = htpasswd
htpasswd_filename = $USERS_FILE
htpasswd_encryption = bcrypt
# Slow down password guessing from the LAN.
delay = 1
# "Family" and "family" are the same user.
$LC_USERNAME

[rights]
type = from_file
file = $RIGHTS_FILE

[storage]
filesystem_folder = $STORAGE

[web]
type = internal
EOF

backup "$RIGHTS_FILE"
cat > "$RIGHTS_FILE" <<EOF
# Written by install-radicale.sh. The first section that matches wins.

# The dashboard's account reads the family's lists and can't change anything.
[display-root]
user: $DISPLAY_USER
collection:
permissions: R

[display-family]
user: $DISPLAY_USER
collection: $FAMILY_USER
permissions: R

[display-family-lists]
user: $DISPLAY_USER
collection: $FAMILY_USER/[^/]+
permissions: r

# Everyone else: their own lists only (Radicale's usual owner_only rules).
[root]
user: .+
collection:
permissions: R

[principal]
user: .+
collection: {user}
permissions: RW

[lists]
user: .+
collection: {user}/[^/]+
permissions: rw
EOF
chown root:radicale "$CONF_DIR/config" "$RIGHTS_FILE"
chmod 640 "$CONF_DIR/config" "$RIGHTS_FILE"

mkdir -p "$STORAGE"
chown -R radicale:radicale "$(dirname "$STORAGE")"

# ── Service ──────────────────────────────────────────────────────────────────

step "Starting Radicale"
# Debian's package ships a unit; write one only if this build didn't.
if ! systemctl cat radicale >/dev/null 2>&1; then
  cat > /etc/systemd/system/radicale.service <<EOF
[Unit]
Description=Radicale CalDAV server for the Home Screens reminders list
After=network-online.target
Wants=network-online.target

[Service]
User=radicale
Group=radicale
ExecStart=/usr/bin/python3 -m radicale --config $CONF_DIR/config
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
fi
systemctl enable radicale >/dev/null 2>&1
systemctl restart radicale
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || die "Radicale didn't start. See: sudo journalctl -u radicale -n 50"

# ── The list finder ──────────────────────────────────────────────────────────
# Finding the family account's lists takes a CalDAV PROPFIND. Home Screens'
# plugin proxy only passes GET, POST, PUT and PATCH, and its pages may not
# call Radicale's plain-HTTP address directly. So radicale-lists answers a GET
# on /family/ (port 5233) by sending Radicale that PROPFIND from the Pi. It
# holds no passwords: the module's own login is passed on, and Radicale
# decides what it may see.

step "Installing the list finder (radicale-lists)"
mkdir -p "$HELPER_DIR"
cat > "$HELPER_DIR/radicale-lists.py" <<'PYEOF'
#!/usr/bin/env python3
"""Lists the reminders lists in a Radicale account, for the Reminders List
Home Screens module. Installed by install-radicale.sh; see its notes."""

import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RADICALE = os.environ.get("RADICALE_URL", "http://127.0.0.1:5232").rstrip("/")
HOST = os.environ.get("LISTS_HOST", "0.0.0.0")
PORT = int(os.environ.get("LISTS_PORT", "5233"))
# The Pi's certificate authority, for phones to install (public, no key).
CA_CERT = os.environ.get("CA_CERT", "/etc/radicale/tls/ca.crt")

BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">'
    "<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>"
    "<a:calendar-color/><a:calendar-order/></d:prop></d:propfind>"
).encode()

# One account folder: /family/
ACCOUNT = re.compile(r"^/[A-Za-z0-9._@-]+/$")


class Handler(BaseHTTPRequestHandler):
    server_version = "radicale-lists"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/ca.crt":
            try:
                with open(CA_CERT, "rb") as f:
                    return self.reply(200, f.read(), "application/x-x509-ca-cert")
            except OSError:
                return self.reply(404, b"No certificate yet: re-run install-radicale.sh\n", "text/plain")
        if not ACCOUNT.match(path):
            return self.reply(404, b"Ask for an account, like /family/\n", "text/plain")
        headers = {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"}
        if self.headers.get("Authorization"):
            headers["Authorization"] = self.headers["Authorization"]
        request = urllib.request.Request(RADICALE + path, data=BODY, headers=headers, method="PROPFIND")
        try:
            with urllib.request.urlopen(request, timeout=10) as answer:
                status, body = answer.status, answer.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
        except OSError as e:
            return self.reply(502, f"Radicale unreachable: {e}\n".encode(), "text/plain")
        self.reply(status, body, "application/xml; charset=utf-8")

    def reply(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # Every minute from each display; nothing worth keeping.


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
PYEOF
chmod 755 "$HELPER_DIR/radicale-lists.py"

cat > /etc/systemd/system/radicale-lists.service <<EOF
[Unit]
Description=Finds Radicale reminders lists for the Home Screens Reminders List module
After=network-online.target radicale.service
Wants=network-online.target

[Service]
Environment=RADICALE_URL=http://127.0.0.1:$PORT
Environment=LISTS_PORT=$HELPER_PORT
Environment=CA_CERT=$TLS_DIR/ca.crt
ExecStart=/usr/bin/python3 $HELPER_DIR/radicale-lists.py
Restart=always
RestartSec=5
DynamicUser=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable radicale-lists >/dev/null 2>&1
systemctl restart radicale-lists
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$HELPER_PORT/" && break
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:$HELPER_PORT/" || die "radicale-lists didn't start. See: sudo journalctl -u radicale-lists -n 50"
echo "Listening on port $HELPER_PORT."

# ── HTTPS for the phones ─────────────────────────────────────────────────────
# Current iOS won't send a CalDAV password over plain HTTP, so phones use a
# second Radicale process on port 5443 with TLS. It reads the same config and
# lists (Radicale locks its storage, so two processes can share it); only the
# port and the certificate differ. The dashboard keeps plain HTTP on 5232,
# inside the Pi.
#
# The certificate is signed by a certificate authority made here, once. A
# phone installs that authority (downloaded from the helper at /ca.crt) and
# from then on trusts the Pi. The Pi's own certificate lasts 825 days, the
# longest iOS accepts; re-running renews it, under the same authority, so the
# phones don't need to do anything again.

step "Setting up HTTPS for the phones"
HOST_NAME="$(hostname)"
mkdir -p "$TLS_DIR"
chmod 755 "$TLS_DIR"
NEW_CA=0
if [[ ! -s "$TLS_DIR/ca.key" || ! -s "$TLS_DIR/ca.crt" ]]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
    -subj "/CN=Home Screens Radicale ($HOST_NAME)" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null \
    || die "Couldn't make the certificate authority (openssl failed)."
  NEW_CA=1
  echo "Made a certificate authority for this Pi."
fi
chmod 600 "$TLS_DIR/ca.key"
chmod 644 "$TLS_DIR/ca.crt"

# A new certificate when there's none, it expires within 30 days, the Pi's
# address changed, or the authority is new.
cert_ok() {
  [[ -s "$TLS_DIR/server.crt" && -s "$TLS_DIR/server.key" ]] || return 1
  openssl x509 -checkend $((30 * 86400)) -noout -in "$TLS_DIR/server.crt" >/dev/null 2>&1 || return 1
  openssl x509 -noout -text -in "$TLS_DIR/server.crt" 2>/dev/null | grep -Eq "IP Address:${PI_IP//./\\.}(,|$)" || return 1
  openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt" >/dev/null 2>&1 || return 1
}
if [[ $NEW_CA -eq 1 ]] || ! cert_ok; then
  WORK="$(mktemp -d)"
  cat > "$WORK/ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$PI_IP,DNS:$HOST_NAME,DNS:$HOST_NAME.local
EOF
  openssl req -new -nodes -newkey rsa:2048 -keyout "$TLS_DIR/server.key" -out "$WORK/csr" \
    -subj "/CN=$PI_IP" 2>/dev/null \
    && openssl x509 -req -in "$WORK/csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
      -CAcreateserial -CAserial "$TLS_DIR/ca.srl" -out "$TLS_DIR/server.crt" \
      -days 825 -sha256 -extfile "$WORK/ext" 2>/dev/null \
    || die "Couldn't make the Pi's certificate (openssl failed)."
  rm -rf "$WORK"
  echo "Made a certificate for $PI_IP, good for 825 days."
else
  echo "The Pi's certificate is current."
fi
chown root:radicale "$TLS_DIR/server.key"
chmod 640 "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/server.crt"

cat > "$CONF_DIR/config-https" <<EOF
# Written by install-radicale.sh. Read after $CONF_DIR/config by
# radicale-https: the same Radicale and lists, over HTTPS for the phones.
[server]
hosts = 0.0.0.0:$HTTPS_PORT, [::]:$HTTPS_PORT
ssl = True
certificate = $TLS_DIR/server.crt
key = $TLS_DIR/server.key
EOF
chown root:radicale "$CONF_DIR/config-https"
chmod 640 "$CONF_DIR/config-https"

cat > /etc/systemd/system/radicale-https.service <<EOF
[Unit]
Description=Radicale over HTTPS for the iPhones (Home Screens reminders)
After=network-online.target radicale.service
Wants=network-online.target

[Service]
User=radicale
Group=radicale
ExecStart=/usr/bin/python3 -m radicale --config $CONF_DIR/config:$CONF_DIR/config-https
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable radicale-https >/dev/null 2>&1
systemctl restart radicale-https
for _ in $(seq 1 20); do
  curl -s -o /dev/null --cacert "$TLS_DIR/ca.crt" "https://$PI_IP:$HTTPS_PORT/" && break
  sleep 0.5
done
curl -s -o /dev/null --cacert "$TLS_DIR/ca.crt" "https://$PI_IP:$HTTPS_PORT/" \
  || die "Radicale over HTTPS didn't answer on port $HTTPS_PORT. See: sudo journalctl -u radicale-https -n 50"
echo "Listening on port $HTTPS_PORT, with a certificate the phones can check."

# ── The starter list ─────────────────────────────────────────────────────────

LIST_URL="http://$PI_IP:$PORT/$FAMILY_USER/$LIST_SLUG/"
ACCOUNT_URL="http://$PI_IP:$PORT/$FAMILY_USER/"
LOCAL_LIST="http://127.0.0.1:$PORT/$FAMILY_USER/$LIST_SLUG/"

step "Creating the $LIST_NAME list"
if [[ -d "$STORAGE/collection-root/$FAMILY_USER/$LIST_SLUG" ]]; then
  echo "It's already there."
else
  if [[ -z "$FAMILY_PASSWORD" ]]; then
    read -r -s -p "Password for the $FAMILY_USER account (to create the list): " FAMILY_PASSWORD; echo
  fi
  # The family account's own folder first, as signing in from a phone would.
  curl -s -o /dev/null -u "$FAMILY_USER:$FAMILY_PASSWORD" -X PROPFIND -H 'Depth: 0' "http://127.0.0.1:$PORT/$FAMILY_USER/" || true
  NAME_XML="$(printf '%s' "$LIST_NAME" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' -u "$FAMILY_USER:$FAMILY_PASSWORD" -X MKCALENDAR \
    -H 'Content-Type: application/xml' "$LOCAL_LIST" --data-binary @- <<EOF
<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:displayname>$NAME_XML</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</C:mkcalendar>
EOF
)"
  case "$STATUS" in
    201) echo "Created $LIST_URL" ;;
    401) die "Radicale turned down the $FAMILY_USER password. Re-run with --reset-passwords to set a new one." ;;
    *) die "Radicale answered $STATUS when creating the list. See: sudo journalctl -u radicale -n 50" ;;
  esac
fi

# ── Check: the display account can read it ──────────────────────────────────

if [[ -n "$DISPLAY_PASSWORD" ]]; then
  step "Checking the dashboard can read the list"
  if curl -s -u "$DISPLAY_USER:$DISPLAY_PASSWORD" "$LOCAL_LIST" | grep -q 'BEGIN:VCALENDAR'; then
    echo "It can."
  else
    warn "The $DISPLAY_USER account couldn't read $LOCAL_LIST. See: sudo journalctl -u radicale -n 50"
  fi
  if curl -s -u "$DISPLAY_USER:$DISPLAY_PASSWORD" "http://127.0.0.1:$HELPER_PORT/$FAMILY_USER/" | grep -q 'multistatus'; then
    echo "And it can find the family account's lists."
  else
    warn "radicale-lists couldn't list the $FAMILY_USER account. See: sudo journalctl -u radicale-lists -n 50"
  fi
fi

# ── Next steps ───────────────────────────────────────────────────────────────

DISPLAY_LINE="Password:     ${DISPLAY_PASSWORD:-(unchanged; see the earlier copy of this file, or re-run with --reset-passwords)}"
cat > "$NOTES" <<EOF
Radicale is running at https://$PI_IP:$HTTPS_PORT/ for the phones
(web page: https://$PI_IP:$HTTPS_PORT/.web/) and http://$PI_IP:$PORT/ for the dashboard.

1. On each iPhone (on the home Wi-Fi), once: trust the Pi's certificate
   a. In Safari, open  http://$PI_IP:$HELPER_PORT/ca.crt  and tap Allow.
   b. Settings > General > VPN & Device Management > "Home Screens Radicale
      ($HOST_NAME)" > Install, and enter the phone's passcode.
   c. Settings > General > About > Certificate Trust Settings: turn on
      "Home Screens Radicale ($HOST_NAME)".

2. On each iPhone, add the account
   Settings > Apps > Reminders > Reminders Accounts > Add Account > Other
   > Add CalDAV Account
     Server:       $PI_IP:$HTTPS_PORT
     User Name:    $FAMILY_USER
     Password:     the family password you chose
     Description:  Home
   Tap Next (leave Use SSL on). On the next page turn Reminders on (and
   Calendars off). The "$LIST_NAME" list appears in Reminders under "Home".
   An old Home account on port $PORT: delete it first.

3. In the Home Screens editor, add a Reminders List module and set
     Address:      $ACCOUNT_URL   (every list under Home)
                   or $LIST_URL   (just $LIST_NAME)
     User name:    $DISPLAY_USER
     $DISPLAY_LINE

Lists made on a phone under "Home" are shared too, and show up on the
dashboard by themselves when the module uses the account address.
EOF
chmod 600 "$NOTES"

step "Done"
cat "$NOTES"
echo
bold "Saved to $NOTES (readable by root only)."
if [[ "$PI_IP" != 192.168.* && "$PI_IP" != 10.* && "$PI_IP" != 172.* ]]; then
  warn "$PI_IP doesn't look like a home-network address. Check hostname -I."
fi
echo "Give the Pi a fixed address in your router (a DHCP reservation) so the phones keep finding it."
