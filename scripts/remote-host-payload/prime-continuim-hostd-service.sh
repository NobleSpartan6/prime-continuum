#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Prime Continuim service launcher accepts no arguments.' >&2
  exit 64
fi

case "${HOME-}" in
  /*) ;;
  *)
    printf '%s\n' 'Prime Continuim service launcher requires an absolute HOME.' >&2
    exit 78
    ;;
esac

root="${HOME}/.local/lib/prime-continuim/remote-host/v1"
state="${HOME}/.local/state/prime-agent/hostd"

unset NODE_OPTIONS NODE_PATH
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE GLIBC_TUNABLES
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_ENABLE_LOGGING ELECTRON_ENABLE_STACK_DUMPING
unset PRIME_AGENT_DATA_DIR PRIME_CONTINUIM_PACKAGE_SMOKE
unset PRIME_AGENT_BUILD_ID PRIME_AGENT_LAUNCHER_PATH

export ELECTRON_RUN_AS_NODE=1

exec "${root}/electron/electron" \
  "${root}/hostd.cjs" serve \
  --data-dir "${state}" \
  --runtime-seed "${root}/runtime-seed"
