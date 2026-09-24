#!/usr/bin/env bash
set -euo pipefail

DOMAIN="wecom.thelonelybrave.cn"
TUNNEL_USER="wecom-tunnel"
PROBE_USER="wecom-probe"
TUNNEL_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL4ShLvFEnWFih3vVAU0FkLJdZBD5JtUpw1KuZL4PFG7 rag-wecom-tunnel-2026-08-09"
PROBE_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBRFoYQz+EYOzkp5edAAkolDeZ22Nsluxdbxv+2EOxmw rag-wecom-probe-2026-08-09"

if [[ "${TUNNEL_PUBKEY}" != ssh-ed25519\ * ]]; then
  echo '{"ok":false,"error":"INVALID_TUNNEL_PUBLIC_KEY"}'
  exit 1
fi

if [[ "${PROBE_PUBKEY}" != ssh-ed25519\ * ]]; then
  echo '{"ok":false,"error":"INVALID_PROBE_PUBLIC_KEY"}'
  exit 1
fi

install_packages() {
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx curl openssh-server certbot python3-certbot-nginx || dnf install -y nginx curl openssh-server certbot
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y nginx curl openssh-server certbot python3-certbot-nginx || yum install -y nginx curl openssh-server certbot
    return
  fi

  echo '{"ok":false,"error":"UNSUPPORTED_PACKAGE_MANAGER"}'
  exit 1
}

ensure_user() {
  local name="$1"
  local shell_path="$2"
  if id -u "${name}" >/dev/null 2>&1; then
    usermod -s "${shell_path}" "${name}"
    return
  fi
  useradd --system --create-home --home-dir "/home/${name}" --shell "${shell_path}" "${name}"
}

install_authorized_key() {
  local name="$1"
  local line="$2"
  local home_dir="/home/${name}"
  install -d -m 0700 -o "${name}" -g "${name}" "${home_dir}/.ssh"
  printf '%s\n' "${line}" > "${home_dir}/.ssh/authorized_keys"
  chown "${name}:${name}" "${home_dir}/.ssh/authorized_keys"
  chmod 0600 "${home_dir}/.ssh/authorized_keys"
}

install_sshd_policy() {
  local include_dir="/etc/ssh/sshd_config.d"
  install -d -m 0755 "${include_dir}"
  cat > "${include_dir}/99-wecom-callback.conf" <<'SSHD_CONF'
Match User wecom-tunnel
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PubkeyAuthentication yes
  AllowTcpForwarding remote
  GatewayPorts no
  PermitTTY no
  X11Forwarding no
  AllowAgentForwarding no

Match User wecom-probe
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PubkeyAuthentication yes
  AllowTcpForwarding no
  PermitTTY no
  X11Forwarding no
  AllowAgentForwarding no
SSHD_CONF

  if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    cp /etc/ssh/sshd_config "/etc/ssh/sshd_config.wecom-backup.$(date +%Y%m%d%H%M%S)"
    sed -i '1iInclude /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
  fi

  sshd -t
  systemctl reload sshd || systemctl reload ssh
}

install_nginx_configs() {
  install -d -m 0755 /var/www/certbot
  cat > /etc/nginx/conf.d/wecom-bootstrap.conf <<'NGINX_BOOTSTRAP'
server {
    listen 80;
    server_name wecom.thelonelybrave.cn;
    access_log off;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
    }

    location / { return 404; }
}
NGINX_BOOTSTRAP

  rm -f /etc/nginx/conf.d/wecom.conf
  nginx -t
  systemctl enable --now nginx
}

issue_certificate_if_possible() {
  if ! command -v certbot >/dev/null 2>&1; then
    echo '{"certificate":"skipped","reason":"CERTBOT_NOT_INSTALLED"}'
    return
  fi

  if certbot certonly --webroot -w /var/www/certbot -d "${DOMAIN}" --agree-tos --non-interactive --register-unsafely-without-email; then
    cat > /etc/nginx/conf.d/wecom.conf <<'NGINX_FINAL'
log_format wecom_callback '$remote_addr [$time_local] $request_method $uri $status $body_bytes_sent $request_time';
limit_req_zone $binary_remote_addr zone=wecom_callback:10m rate=120r/m;

server {
    listen 80;
    server_name wecom.thelonelybrave.cn;
    access_log off;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name wecom.thelonelybrave.cn;

    ssl_certificate /etc/letsencrypt/live/wecom.thelonelybrave.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wecom.thelonelybrave.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;

    access_log /var/log/nginx/wecom-callback.access.log wecom_callback;
    error_log /var/log/nginx/wecom-callback.error.log warn;
    client_max_body_size 1m;

    location ^~ /webhooks/wecom/ {
        limit_req zone=wecom_callback burst=30 nodelay;
        limit_except GET POST { deny all; }
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
        proxy_pass http://127.0.0.1:18788;
    }

    location / { return 404; }
}
NGINX_FINAL
    rm -f /etc/nginx/conf.d/wecom-bootstrap.conf
    nginx -t
    systemctl reload nginx
    echo '{"certificate":"issued"}'
    return
  fi

  echo '{"certificate":"pending","reason":"CERTBOT_FAILED_KEEPING_BOOTSTRAP"}'
}

install_packages
ensure_user "${TUNNEL_USER}" /sbin/nologin
ensure_user "${PROBE_USER}" /bin/sh
install_authorized_key "${TUNNEL_USER}" "restrict,port-forwarding,permitlisten=\"127.0.0.1:18788\" ${TUNNEL_PUBKEY}"
install_authorized_key "${PROBE_USER}" "restrict,command=\"/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:18788/healthz\" ${PROBE_PUBKEY}"
install_sshd_policy
install_nginx_configs
issue_certificate_if_possible

echo '{"ok":true,"users":["wecom-tunnel","wecom-probe"],"nginx":"configured","ports":"80/443 only"}'
