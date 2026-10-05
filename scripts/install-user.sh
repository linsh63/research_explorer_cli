#!/usr/bin/env bash
set -euo pipefail

install_core=1
install_cli=1
prefix="${RESEARCH_EXPLORER_PREFIX:-${HOME}/.local}"
core_ref="${RESEARCH_CORE_REF:-main}"
cli_ref="${RESEARCH_EXPLORER_REF:-main}"

while (($#)); do
  case "$1" in
    --core-only) install_cli=0 ;;
    --cli-only) install_core=0 ;;
    --prefix)
      shift
      [[ $# -gt 0 ]] || { echo "--prefix requires a path" >&2; exit 2; }
      prefix="$1"
      ;;
    --help)
      cat <<'EOF'
Usage: install-user.sh [--core-only|--cli-only] [--prefix PATH]

Environment:
  RESEARCH_EXPLORER_PREFIX  User installation prefix (default: ~/.local)
  RESEARCH_CORE_REF         Core Git ref (default: main)
  RESEARCH_EXPLORER_REF     CLI Git ref (default: main)
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
if [[ $install_core -eq 1 ]]; then
  npm install -g --prefix "$prefix" "git+https://github.com/linsh63/auto_research_agent.git#${core_ref}"
fi
if [[ $install_cli -eq 1 ]]; then
  npm install -g --prefix "$prefix" "git+https://github.com/linsh63/research_explorer_cli.git#${cli_ref}"
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
