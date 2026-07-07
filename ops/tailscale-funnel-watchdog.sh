#!/bin/bash
# Keep the Tailscale tunnel + Funnel up AND actually serving HTTPS to the public.
# Runs every ~60s via a user LaunchAgent. No sudo required.
#
# This is the CANONICAL, versioned copy. The launchd agent
# (com.seasonarts.tailscale-funnel-watchdog) should point at this file in the
# live release, e.g. ProgramArguments = /bin/bash $HOME/paperclip/current/ops/tailscale-funnel-watchdog.sh
# so it travels with the code and needs no device-specific loose file.
#
# Beyond checking that funnel is "on", it fetches the PUBLIC https URL through
# Tailscale's public ingress — NOT the local tailnet path, which resolves the
# name to the 100.x tailnet IP and hides funnel-TLS breakage.
#
# DESIGN NOTES (rev 2):
#   * Detection is CONFIRMED with retries. A single curl to a DERP-relayed
#     public ingress IP can time out transiently even when the funnel is fine;
#     acting on one failed probe caused needless churn. We now require several
#     failed probes, across both ingress IPs, before declaring the funnel down.
#   * Remediation is LIGHTWEIGHT: restart the funnel (off + --bg). We do NOT
#     re-provision the TLS cert on every failure — the funnel cert is a normal
#     90-day Let's Encrypt cert that the daemon auto-renews, and hammering
#     `tailscale cert` hits Let's Encrypt duplicate-cert rate limits (~5/week
#     per host), which makes the command FAIL and prolongs the outage.
#   * The cert is only re-provisioned as a safety net when it is genuinely
#     near expiry (< CERT_MIN_DAYS days).
#
# Portable: the public hostname is derived from `tailscale status` at runtime, so
# this same file works unchanged on any Mac. Override with PAPERCLIP_TS_HOST if
# the daemon can't report it.
#
# Limits: a user agent only runs while logged in, and nothing runs during sleep.
# It recovers within ~60s of wake — it can't help if the Mac is logged out or
# asleep. For true always-on, move off the laptop.

# Locate the tailscale CLI (Homebrew symlink or the macOS app bundle).
TS=""
for c in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale "/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
  [ -x "$c" ] && TS="$c" && break
done
PORT="${PAPERCLIP_PORT:-3100}"
CERT_MIN_DAYS=10          # re-provision only if the cert expires within this many days
PROBE_ATTEMPTS=4          # confirm failure across this many probes...
PROBE_GAP=3               # ...spaced this many seconds apart
LOG="$HOME/Library/Logs/tailscale-funnel-watchdog.log"
ts() { date '+%F %T'; }
[ -z "$TS" ] && { echo "$(ts) tailscale CLI not found" >>"$LOG"; exit 0; }

# 1. Bring the tailnet up if the backend isn't Running.
if "$TS" status 2>&1 | grep -qiE "stopped|NeedsLogin|logged out"; then
  echo "$(ts) tailnet down -> tailscale up" >>"$LOG"
  "$TS" up >>"$LOG" 2>&1
fi

# 2. Ensure the Funnel is configured to proxy the Paperclip port.
if ! "$TS" funnel status 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then
  echo "$(ts) funnel not on :${PORT} -> re-enabling" >>"$LOG"
  "$TS" funnel --bg "$PORT" >>"$LOG" 2>&1
fi

# 3. Verify the PUBLIC HTTPS path. Derive this node's public ts.net name
#    dynamically (so this file is portable across Macs), then resolve its ingress
#    IP via a PUBLIC resolver to bypass MagicDNS.
HOST="${PAPERCLIP_TS_HOST:-}"
[ -z "$HOST" ] && HOST="$("$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import sys,json
try: print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))
except Exception: pass' 2>/dev/null)"
# No device-specific fallback: if we cannot derive the hostname, funnel-status
# (step 2) already ran; just skip the public probe this cycle.
[ -z "$HOST" ] && { echo "$(ts) could not derive tailnet hostname; skipped public probe" >>"$LOG"; exit 0; }

# Collect ingress IPs from public DNS (try Cloudflare then Google).
IPS="$(dig @1.1.1.1 +short "$HOST" A 2>/dev/null | grep -E '^[0-9]')"
[ -z "$IPS" ] && IPS="$(dig @8.8.8.8 +short "$HOST" A 2>/dev/null | grep -E '^[0-9]')"

# One probe = a health fetch forced through a given public ingress IP.
probe() { curl -fsS -m 10 --resolve "${HOST}:443:$1" "https://${HOST}/api/health" >/dev/null 2>&1; }

# Confirm the public path is actually down: every attempt must fail on every IP.
public_is_down() {
  [ -z "$IPS" ] && return 1              # no public DNS answer -> don't act (likely our own resolver blip)
  local attempt ip
  for attempt in $(seq 1 "$PROBE_ATTEMPTS"); do
    for ip in $IPS; do
      probe "$ip" && return 1            # any success -> path is up
    done
    [ "$attempt" -lt "$PROBE_ATTEMPTS" ] && sleep "$PROBE_GAP"
  done
  return 0                               # all attempts on all IPs failed
}

# Days until the live funnel cert expires (as served on the public path). Empty on error.
cert_days_left() {
  local ip end end_epoch now_epoch
  ip="$(echo "$IPS" | head -1)"
  [ -z "$ip" ] && return
  end="$(echo | openssl s_client -connect "${ip}:443" -servername "$HOST" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
  [ -z "$end" ] && return
  end_epoch="$(date -j -f '%b %e %T %Y %Z' "$end" '+%s' 2>/dev/null)"
  [ -z "$end_epoch" ] && return
  now_epoch="$(date '+%s')"
  echo $(( (end_epoch - now_epoch) / 86400 ))
}

if public_is_down; then
  echo "$(ts) PUBLIC https DOWN for ${HOST} (confirmed ${PROBE_ATTEMPTS}x) -> restarting funnel" >>"$LOG"

  # Only re-provision the cert if it is genuinely near expiry (avoids the
  # Let's Encrypt duplicate-cert rate limit that made cert churn self-defeating).
  DAYS="$(cert_days_left)"
  if [ -n "$DAYS" ] && [ "$DAYS" -lt "$CERT_MIN_DAYS" ]; then
    echo "$(ts) cert expires in ${DAYS}d (< ${CERT_MIN_DAYS}) -> re-provisioning" >>"$LOG"
    TMP="$(mktemp -d)"
    ( cd "$TMP" && "$TS" cert "$HOST" >>"$LOG" 2>&1 )   # throwaway dir; key deleted below
    rm -rf "$TMP"
  fi

  # Lightweight remediation: bounce the funnel listener.
  "$TS" funnel --https=443 off >>"$LOG" 2>&1
  "$TS" funnel --bg "$PORT" >>"$LOG" 2>&1

  # Verify the bounce actually restored the public path; log the outcome.
  sleep 4
  if public_is_down; then
    echo "$(ts) funnel restart did NOT restore public path (still down)" >>"$LOG"
  else
    echo "$(ts) funnel restarted; public path restored" >>"$LOG"
  fi
fi
