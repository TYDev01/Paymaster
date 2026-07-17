#!/usr/bin/env bash
#
# Fetches the rundler binary used by the bundler integration test.
#
# Rundler is Alchemy's ERC-4337 bundler, open source under Apache-2.0/MIT. td2.md prohibits the
# Alchemy *hosted* bundler service; running the open-source binary on our own infrastructure is
# what td2.md calls "acceptable and preferred". No request leaves our infrastructure.
#
# Not vendored: it is a 56MB per-platform release artifact. The version and checksum are pinned
# here so CI and every developer run the same bytes.
set -euo pipefail

RUNDLER_VERSION="v0.11.0"
# sha256 of the x86_64-unknown-linux-gnu tarball for the pinned version. If this check fails, do
# not "fix" it by updating the hash: verify what changed first.
RUNDLER_SHA256_X86_64_LINUX="b9d9baf7ee145976aab5c392e3e6de16d6aae2e9126a0b20b10a0acab3d75240"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HERE}/../.bundler"
BIN="${DEST}/rundler"

if [ -x "${BIN}" ]; then
  echo "rundler already present at ${BIN}"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu";  EXPECTED_SHA="${RUNDLER_SHA256_X86_64_LINUX}" ;;
  Linux-aarch64) TARGET="aarch64-unknown-linux-gnu"; EXPECTED_SHA="" ;;
  Darwin-x86_64) TARGET="x86_64-apple-darwin";       EXPECTED_SHA="" ;;
  Darwin-arm64)  TARGET="aarch64-apple-darwin";      EXPECTED_SHA="" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

URL="https://github.com/alchemyplatform/rundler/releases/download/${RUNDLER_VERSION}/rundler-${RUNDLER_VERSION}-${TARGET}.tar.gz"

mkdir -p "${DEST}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "fetching rundler ${RUNDLER_VERSION} (${TARGET})..."
curl -fsSL -o "${TMP}/rundler.tar.gz" "${URL}"

ACTUAL_SHA="$(sha256sum "${TMP}/rundler.tar.gz" | cut -d' ' -f1)"
if [ -n "${EXPECTED_SHA}" ]; then
  if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
    echo "checksum mismatch for ${URL}" >&2
    echo "  expected ${EXPECTED_SHA}" >&2
    echo "  actual   ${ACTUAL_SHA}" >&2
    exit 1
  fi
  echo "checksum verified: ${ACTUAL_SHA}"
else
  # Only x86_64 linux is pinned because it is the only platform this has been verified on. Other
  # platforms print the hash so it can be pinned deliberately rather than trusted silently.
  echo "WARNING: no pinned checksum for ${TARGET}; got ${ACTUAL_SHA}"
fi

tar xzf "${TMP}/rundler.tar.gz" -C "${DEST}"
chmod +x "${BIN}"
echo "rundler installed at ${BIN}"
