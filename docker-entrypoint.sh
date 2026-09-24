#!/bin/sh
set -e
# SUNO_COOKIE is injected at runtime (env_file); nothing secret is baked into the
# image. Warn here instead of at build time when it was not provided.
if [ -z "${SUNO_COOKIE:-}" ]; then
  echo "Warning: SUNO_COOKIE is not set. You will have to set the cookies in the Cookie header of your requests." >&2
fi
# Headless shell advertises HeadlessChrome in sec-ch-ua. Default is headed
# Chromium under Xvfb so /api/c/check does not see a bot client-hint.
headless=$(printf '%s' "${BROWSER_HEADLESS:-false}" | tr '[:upper:]' '[:lower:]')
case "$headless" in
  true|1|yes|y) ;;
  *)
    if [ -z "$DISPLAY" ]; then
      export DISPLAY=:99
      Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
      sleep 0.4
    fi
    ;;
esac
exec "$@"
