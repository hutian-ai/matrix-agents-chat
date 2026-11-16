#!/usr/bin/env bash
set -eu

# 安装器生成十六进制应用密码；管理员与 Synapse 使用不同角色和凭据。
case "${POSTGRES_APP_PASSWORD:-}" in
  ''|*[!0-9a-f]*) printf '%s\n' 'Invalid application database password' >&2; exit 1 ;;
esac

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<SQL
CREATE ROLE matrix_chat LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE matrix_chat OWNER matrix_chat ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
SQL
