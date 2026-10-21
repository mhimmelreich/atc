#!/bin/sh
# Entpackt die Little-NavMap-Navdata von Navigraph (lnm_XXXX.zip oder .exe)
# nach data/navdata/. Benötigt unzip und innoextract (apt install innoextract).
# Die Daten sind lizenziert: data/navdata/ steht in .gitignore und darf nicht committet werden.
set -eu

src="${1:?Aufruf: scripts/extract-navdata.sh <lnm_XXXX.zip|lnm_XXXX.exe>}"
dest="$(dirname "$0")/../data/navdata"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

case "$src" in
  *.zip) unzip -q -o "$src" -d "$tmp"; exe="$(find "$tmp" -name '*.exe' | head -n 1)" ;;
  *) exe="$src" ;;
esac

innoextract -q -d "$tmp/out" "$exe"
db="$(find "$tmp/out" -name 'little_navmap_navigraph.sqlite' | head -n 1)"
[ -n "$db" ] || { echo "little_navmap_navigraph.sqlite nicht gefunden" >&2; exit 1; }

mkdir -p "$dest"
cp "$db" "$dest/"
cat "$(dirname "$db")/cycle_info.txt" 2>/dev/null | head -n 3 || true
echo "Navdata installiert: $dest/little_navmap_navigraph.sqlite"
