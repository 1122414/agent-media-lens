#!/bin/sh
set -eu
cd "$(dirname "$0")"
rev=d44264e96cae55a6df341ed4a0b81b3e2d1fbcaf
if [ ! -d .upstream ]; then
  git clone --no-checkout https://github.com/Evil0ctal/Douyin_TikTok_Download_API.git .upstream
  git -C .upstream checkout --detach "$rev"
fi
test "$(git -C .upstream rev-parse HEAD)" = "$rev" || { echo 'Unexpected upstream revision' >&2; exit 1; }
if [ ! -e .upstream/.env ]; then
  (umask 077; python3 - <<'PY'
from pathlib import Path
import secrets
root = Path('.upstream')
values = {'DTK_SECRET_KEY': secrets.token_hex(48), 'POSTGRES_PASSWORD':secrets.token_hex(32), 'REDIS_PASSWORD':secrets.token_hex(32)}
lines = (root/'.env.example').read_text().splitlines()
with (root/'.env').open('x') as f:
    for line in lines:
        key, _, _ = line.partition('=')
        print(key+'='+values[key] if key in values else line, file=f)
PY
  )
fi
echo 'Provider files ready. Review the pinned upstream deployment and start the default services with Compose.'
