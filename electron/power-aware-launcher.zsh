#!/bin/zsh
# launchd invokes this once a minute. The full Electron data collector runs at
# that cadence only on AC power; battery operation is throttled to 15 minutes.

set -u

app_executable="$1"
state_directory="$HOME/Library/Application Support/codexu-local"
state_file="$state_directory/background-power-refresh.txt"
now="$(/bin/date +%s)"

if /usr/bin/pmset -g batt 2>/dev/null | /usr/bin/grep -q "AC Power"; then
  exec "$app_executable" --background-sync
fi

/bin/mkdir -p "$state_directory"
last_refresh=0
if [[ -r "$state_file" ]]; then
  last_refresh="$(/bin/cat "$state_file" 2>/dev/null)"
fi
case "$last_refresh" in
  (''|*[!0-9]*) last_refresh=0 ;;
esac

if (( now - last_refresh >= 15 * 60 )); then
  print -r -- "$now" > "$state_file"
  exec "$app_executable" --background-sync
fi
