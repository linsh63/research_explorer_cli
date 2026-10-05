#!/usr/bin/env bash
set -euo pipefail

install_core=1
install_cli=1
prefix="${RESEARCH_EXPLORER_PREFIX:-${HOME}/.local}"
core_ref="${RESEARCH_CORE_REF:-main}"
cli_ref="${RESEARCH_EXPLORER_REF:-main}"
core_version="${RESEARCH_CORE_VERSION:-latest}"
cli_version="${RESEARCH_EXPLORER_VERSION:-latest}"
install_source="${RESEARCH_EXPLORER_INSTALL_SOURCE:-npm}"

while (($#)); do
  case "$1" in
    --core-only) install_cli=0 ;;
    --cli-only) install_core=0 ;;
    --prefix)
      shift
      [[ $# -gt 0 ]] || { echo "--prefix requires a path" >&2; exit 2; }
      prefix="$1"
      ;;
    --git) install_source="git" ;;
    --help)
      cat <<'EOF'
Usage: install-user.sh [--core-only|--cli-only] [--prefix PATH] [--git]

Environment:
  RESEARCH_EXPLORER_PREFIX  User installation prefix (default: ~/.local)
  RESEARCH_CORE_REF         Core Git ref (default: main)
  RESEARCH_EXPLORER_REF     CLI Git ref (default: main)
  RESEARCH_CORE_VERSION     Core npm version/tag (default: latest)
  RESEARCH_EXPLORER_VERSION CLI npm version/tag (default: latest)
  RESEARCH_EXPLORER_INSTALL_SOURCE npm or git (default: npm)
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]);if(major<22){console.error("Node.js 22.19 or newer is required");process.exit(1)}'

mkdir -p "$prefix"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/research-explorer-install.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT

install_repository() {
  local name="$1"
  local url="$2"
  local ref="$3"
  local source="$work_root/$name"
  local pack_dir="$work_root/$name-pack"
  echo "Installing $name from $url#$ref"
  git clone --quiet --filter=blob:none "$url" "$source"
  git -C "$source" checkout --quiet "$ref"
  npm ci --prefix "$source" --no-audit --no-fund
  mkdir -p "$pack_dir"
  (cd "$source" && npm pack --silent --pack-destination "$pack_dir" >/dev/null)
  local tarball
  tarball="$(find "$pack_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
  [[ -n "$tarball" ]] || { echo "Failed to build $name package" >&2; exit 1; }
  npm install -g --prefix "$prefix" --no-audit --no-fund "$tarball"
}

if [[ "$install_source" == "npm" ]]; then
  if [[ $install_core -eq 1 ]]; then npm install -g --prefix "$prefix" --no-audit --no-fund "research-explorer-core@${core_version}"; fi
  if [[ $install_cli -eq 1 ]]; then npm install -g --prefix "$prefix" --no-audit --no-fund "research-explorer-cli@${cli_version}"; fi
elif [[ "$install_source" == "git" ]]; then
  if [[ $install_core -eq 1 ]]; then install_repository "research-explorer-core" "https://github.com/linsh63/research_explorer_core.git" "$core_ref"; fi
  if [[ $install_cli -eq 1 ]]; then install_repository "research-explorer-cli" "https://github.com/linsh63/research_explorer_cli.git" "$cli_ref"; fi
else
  echo "RESEARCH_EXPLORER_INSTALL_SOURCE must be npm or git" >&2
  exit 2
fi

if [[ ":${PATH}:" != *":${prefix}/bin:"* ]]; then
  echo
  echo "Add Research Explorer to PATH:"
  echo "  export PATH=\"${prefix}/bin:\$PATH\""
fi
if [[ $install_cli -eq 1 ]]; then
  PATH="${prefix}/bin:${PATH}" rexplore --version >/dev/null
fi
echo "Installed successfully under ${prefix}."
