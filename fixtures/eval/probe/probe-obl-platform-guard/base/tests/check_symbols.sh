#!/bin/sh
# Fails when the library exports a symbol that geo.map does not list.
set -eu
lib="$1"
found=$(nm -D --defined-only "$lib" | awk '$2 == "T" { print $3 }' | sort)
expected=$(printf 'geo_bearing\ngeo_distance\n')
[ "$found" = "$expected" ] || { echo "Unexpected exports: $found"; exit 1; }
