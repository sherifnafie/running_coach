#!/bin/bash
# OpenCoach local sandbox entry script (SPEC [SEC-1]/[SEC-2], ADR 0004).
#
# Runs INSIDE fresh user + mount + net + pid + ipc + uts namespaces (created by `unshare`, see
# packages/sandbox/src/local.ts) as namespace-root. It builds a private root filesystem, pivots into it,
# drops every capability and execs the command. Nothing here ever touches the host's mount table:
# all mounts live and die with this mount namespace.
#
# Usage:   bash enter.sh <virtual-cwd> <command> [NAME=VALUE ...]
#   <virtual-cwd>   absolute path inside the sandbox (validated by the provider)
#   <command>       shell command line, passed as a single argument to `bash -c` (never interpolated here)
#   NAME=VALUE ...  the complete environment of the command (the script does not inherit any other)
#
# Configuration (environment; paths and options only, never secrets):
#   OC_ROOT       empty host directory; a tmpfs is mounted on it and becomes the new root
#   OC_HOST_DIRS  newline-separated absolute host dirs exposed read-only
#   OC_HOST_LINKS newline-separated `path<TAB>target` symlinks recreated in the new root (merged-/usr: /bin -> usr/bin)
#   OC_WORKSPACE  host dir -> /workspace (rw)
#   OC_RAW        host dir -> /raw (ro)
#   OC_HISTORY    host dir -> /history (ro)
#   OC_SYSTEM     host dir -> /system (ro)
#   OC_TMP_SIZE   size of the private /tmp tmpfs (default 256m)
#   OC_SHM_SIZE   size of /dev/shm (default 64m)
#   OC_PROC       "1": mount a fresh /proc (valid because we are pid 1 of a new pid namespace)
#   OC_BASH       absolute path of bash to run the command with (default /bin/bash)
#   OC_CMDFILE    host file holding the command (for commands too large for one argv entry); it is
#                 bind-mounted read-only at /.opencoach-command and run as `bash /.opencoach-command`
#                 (the <command> argument is then ignored)
#
# Exit status 125 means the sandbox could not be set up (message on stderr, prefixed "opencoach-sandbox:").
# Otherwise the exit status is the command's.

fail() {
  echo "opencoach-sandbox: $*" >&2
  exit 125
}

# Remount every mount at or below $1 read-only (and nosuid,nodev). `mount --rbind` copies mounts
# read-write unless they already were read-only, and a plain remount only affects the top mount.
ro_tree() {
  local top="$1" id parent dev root mp opts rest
  while IFS=' ' read -r id parent dev root mp opts rest; do
    mp=${mp//\\040/ }
    mp=${mp//\\011/$'\t'}
    mp=${mp//\\012/$'\n'}
    mp=${mp//\\134/\\}
    if [ "$mp" = "$top" ]; then
      # The top mount must become read-only; failing here would silently leave host dirs writable.
      mount -o remount,bind,ro,nosuid,nodev "$mp" 2>/dev/null || mount -o remount,bind,ro "$mp" \
        || fail "cannot make $mp read-only"
    elif [[ "$mp" == "$top"/* ]]; then
      # Submounts: skip the ones that already are read-only. A writable one that cannot be made read-only is
      # detached instead (its mount point then shows the empty directory underneath); failing that, give up.
      case ",$opts," in *,ro,*) continue ;; esac
      mount -o remount,bind,ro,nosuid,nodev "$mp" 2>/dev/null || mount -o remount,bind,ro "$mp" 2>/dev/null \
        || umount -l "$mp" 2>/dev/null || fail "cannot make $mp read-only"
    fi
  done </proc/self/mountinfo
}

bind_athlete() { # <host-src> <mountpoint-in-new-root> <rw|ro>
  [ -d "$1" ] || fail "mount source $1 is not a directory"
  mount -o "bind,$3,nosuid,nodev" "$1" "$R$2" || fail "cannot bind $1 on $2 ($3)"
}

# Hide the /proc entries that let root-owned processes poke the host (the same set Docker masks).
# Matters when the server itself runs as real root: namespace-root then owns these files.
mask_proc() {
  local p
  for p in kcore keys latency_stats timer_list timer_stats sched_debug sysrq-trigger; do
    [ -e "$R/proc/$p" ] && mount --bind /dev/null "$R/proc/$p" 2>/dev/null
  done
  for p in acpi scsi; do
    [ -d "$R/proc/$p" ] && mount -t tmpfs -o ro,size=4k tmpfs "$R/proc/$p" 2>/dev/null
  done
  for p in bus fs irq sys; do
    if [ -d "$R/proc/$p" ]; then
      mount --bind "$R/proc/$p" "$R/proc/$p" 2>/dev/null && mount -o remount,bind,ro "$R/proc/$p" 2>/dev/null
    fi
  done
  return 0
}

main() {
  local cwd="$1" cmd="$2"
  shift 2
  R="${OC_ROOT:?}"
  umask 022

  # Never let a mount here propagate to (or from) the host.
  mount --make-rprivate / 2>/dev/null || true

  mount -t tmpfs -o mode=755,size=4m,nosuid,nodev tmpfs "$R" || fail "cannot mount tmpfs root on $R"

  # All mount points in one go (forks are the main cost of this script).
  local d t hostdirs=() linkdirs=() linktargets=()
  local dirs=("$R/workspace" "$R/raw" "$R/history" "$R/system" "$R/tmp" "$R/dev" "$R/proc" "$R/.oldroot")
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    hostdirs+=("$d")
    dirs+=("$R$d")
  done <<<"${OC_HOST_DIRS:-}"
  while IFS=$'\t' read -r d t; do
    [ -n "$d" ] || continue
    linkdirs+=("$d")
    linktargets+=("$t")
    [ -n "${d%/*}" ] && dirs+=("$R${d%/*}")
  done <<<"${OC_HOST_LINKS:-}"
  mkdir -p "${dirs[@]}" || fail "cannot create mount points"

  # ---- host OS, read-only
  for d in "${hostdirs[@]}"; do
    mount --rbind "$d" "$R$d" || fail "cannot bind host dir $d"
  done
  # merged-/usr hosts: /bin -> usr/bin etc. are recreated as links; their targets are bound above.
  local i
  for i in "${!linkdirs[@]}"; do
    ln -s "${linktargets[$i]}" "$R${linkdirs[$i]}" || fail "cannot recreate symlink ${linkdirs[$i]}"
  done
  for d in "${hostdirs[@]}"; do ro_tree "$R$d"; done

  # Hide well-known host secrets that a root-owned /etc may contain (useful if the server runs as root).
  local f
  for f in "$R"/etc/shadow "$R"/etc/shadow- "$R"/etc/gshadow "$R"/etc/gshadow- "$R"/etc/sudoers "$R"/etc/security/opasswd "$R"/etc/krb5.keytab "$R"/etc/ssh/ssh_host_*_key; do
    [ -f "$f" ] && mount --bind /dev/null "$f" 2>/dev/null
  done
  for f in "$R"/etc/ssl/private "$R"/etc/sudoers.d "$R"/etc/letsencrypt; do
    [ -d "$f" ] && mount -t tmpfs -o mode=755,size=4k tmpfs "$f" 2>/dev/null
  done

  # ---- athlete mounts
  bind_athlete "${OC_WORKSPACE:?}" /workspace rw
  bind_athlete "${OC_RAW:?}" /raw ro
  bind_athlete "${OC_HISTORY:?}" /history ro
  bind_athlete "${OC_SYSTEM:?}" /system ro

  # ---- private /tmp
  mount -t tmpfs -o "mode=1777,size=${OC_TMP_SIZE:-256m},nosuid,nodev" tmpfs "$R/tmp" || fail "cannot mount /tmp"

  # ---- minimal /dev (individual safe nodes only; the host's disks and ttys stay invisible)
  mount -t tmpfs -o mode=755,size=1m,nosuid tmpfs "$R/dev" || fail "cannot mount /dev"
  local n
  for n in null zero full random urandom tty; do
    [ -e "/dev/$n" ] || continue
    : >"$R/dev/$n" && mount --bind "/dev/$n" "$R/dev/$n" 2>/dev/null || rm -f "$R/dev/$n"
  done
  ln -s /proc/self/fd "$R/dev/fd"
  ln -s /proc/self/fd/0 "$R/dev/stdin"
  ln -s /proc/self/fd/1 "$R/dev/stdout"
  ln -s /proc/self/fd/2 "$R/dev/stderr"
  mkdir "$R/dev/shm" && mount -t tmpfs -o "mode=1777,size=${OC_SHM_SIZE:-64m},nosuid,nodev" tmpfs "$R/dev/shm" 2>/dev/null
  mount -o remount,bind,ro,nosuid "$R/dev" 2>/dev/null || true

  # ---- /proc of the new pid namespace (best effort: unavailable under some container runtimes)
  if [ "${OC_PROC:-0}" = 1 ]; then
    if mount -t proc -o nosuid,nodev,noexec proc "$R/proc" 2>/dev/null; then
      mask_proc
    fi
  fi

  # ---- large command delivered as a file
  if [ -n "${OC_CMDFILE:-}" ]; then
    : >"$R/.opencoach-command" && mount --bind "$OC_CMDFILE" "$R/.opencoach-command" \
      && mount -o remount,bind,ro,nosuid,nodev "$R/.opencoach-command" || fail "cannot expose the command file"
  fi

  # ---- loopback only (best effort); there is no other interface and no route out
  if command -v ip >/dev/null 2>&1; then ip link set lo up 2>/dev/null || true; fi

  # ---- pivot into the new root and detach the old one so the host tree is unreachable
  cd "$R" || fail "cd $R"
  pivot_root . .oldroot || fail "pivot_root failed"
  cd / || fail "cd /"
  umount -l /.oldroot || fail "cannot detach the old root"
  rmdir /.oldroot 2>/dev/null || true
  mount -o remount,bind,ro / 2>/dev/null || true # nothing outside the declared mounts is writable
  hash -r

  cd -- "$cwd" 2>/dev/null || fail "cannot cd to $cwd"
  ulimit -c 0

  # Drop every capability. Without CAP_SYS_ADMIN the process cannot remount the read-only binds,
  # without CAP_SYS_CHROOT it cannot play chroot tricks, and no_new_privs blocks setuid escalation.
  # Fallback when setpriv is missing: enter a nested user namespace, which owns nothing in this one.
  local drop=()
  if command -v setpriv >/dev/null 2>&1; then
    drop=(setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all)
  else
    drop=(unshare --user --map-root-user --)
  fi

  if [ -n "${OC_CMDFILE:-}" ]; then
    exec "${drop[@]}" env -i "$@" "${OC_BASH:-/bin/bash}" /.opencoach-command
  fi
  exec "${drop[@]}" env -i "$@" "${OC_BASH:-/bin/bash}" -c "$cmd"
}

main "$@"
