#!/usr/bin/env sh
# Runs Radinus live on paper (the `live` verb) on the run folder runs/essai, from wherever it is called.
# Ctrl+C stops it; the open positions stay in runs/essai/etat.json and the next run resumes them.
# The data module is --source, else $RADINUS_SOURCE, else lighter. Extra arguments are passed through: ./direct.sh --port 0
cd "$(dirname "$0")" || exit 1
exec node dist/radinus.mjs live --out runs/essai "$@"
