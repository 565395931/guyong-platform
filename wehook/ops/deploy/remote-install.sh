#!/usr/bin/env bash
set -euo pipefail

source_dir=/tmp/lw-control-plane-deploy-20260924
target_dir=/opt/lonely-warrior/control-plane
env_file=/etc/lonely-warrior/control-plane.env

if [[ "$(readlink -f "$target_dir")" != "/opt/lonely-warrior/control-plane" ]]; then
  echo "unexpected deployment target" >&2
  exit 1
fi

cp -a "$source_dir"/. "$target_dir"/
chown -R root:root "$target_dir"
find "$target_dir" -type d -exec chmod 0755 {} +
find "$target_dir" -type f -exec chmod 0644 {} +

session_secret="$(openssl rand -hex 32)"
umask 027
printf '%s\n' \
  'CONTROL_PLANE_HOST=127.0.0.1' \
  'CONTROL_PLANE_PORT=8790' \
  'CONTROL_PLANE_STORE_PATH=/var/lib/lonely-warrior/control-plane.json' \
  'CONTROL_PLANE_ADMIN_USERNAME=admin' \
  'CONTROL_PLANE_ADMIN_PASSWORD=admin123' \
  "CONTROL_PLANE_SESSION_SECRET=$session_secret" > "$env_file"
chown root:lonelywarrior "$env_file"
chmod 0640 "$env_file"

install -m 0644 "$source_dir/lonely-warrior-control-plane.service" /etc/systemd/system/lonely-warrior-control-plane.service
systemctl daemon-reload
systemctl enable --now lonely-warrior-control-plane.service

sleep 1
systemctl --no-pager --full status lonely-warrior-control-plane.service | sed -n '1,18p'
curl -fsS http://127.0.0.1:8790/healthz
printf '\n'
curl -fsS -H 'Host: admin.lonely-warrior.online' http://127.0.0.1:8790/ | grep -o '<title>[^<]*'
