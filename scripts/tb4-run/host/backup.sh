#!/bin/bash
# Second copy of the results off the controller: R2 (S3-compatible).
# backup.sh [attempt-id]   (no arg: whole results dir + journal; run by tb4-backup.timer)
set -euo pipefail
set -a; . /opt/tb4/backup.env; set +a
run=${TB4_RUN_DIR:-/opt/tb4/run}   # a pipeline trial uses its own run dir   # R2_BUCKET R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY (R2 keys)
src=$run/results${1:+/$1}
dst=s3://$R2_BUCKET/tb4/$(cat $run/run-id)/results${1:+/$1}
aws s3 sync --only-show-errors --endpoint-url "$R2_ENDPOINT" "$src" "$dst"
aws s3 cp --only-show-errors --endpoint-url "$R2_ENDPOINT" $run/journal.jsonl "s3://$R2_BUCKET/tb4/$(cat $run/run-id)/journal.jsonl"
date -u +%FT%TZ > $run/last-backup
