# ADR 0004: Local sandbox via unprivileged Linux namespaces

- Status: accepted (2026-10-06)
- Context: self-hosters may not run Docker. Unprivileged user namespaces are widely available. The continuation environment supports both namespaces and a Docker daemon; both providers have been exercised.
- Decision: `LocalSandboxProvider` runs each command in fresh user, mount, network, PID, IPC and UTS namespaces (`unshare`), with a tmpfs root, read-only rbinds of host OS dirs, the athlete mounts at `/workspace` (rw), `/raw`, `/history`, `/system` (ro), private `/tmp`, then `pivot_root` and capability dropping. Git metadata has a nested read-only bind, including worktree `.git` files. There is no network. A non-isolated fallback exists only when `sandbox.allowUnsafe: true` and logs loudly. Docker remains available as `DockerSandboxProvider` (one container per athlete, network none) with the same metadata protection.
- Consequences: works on most Linux hosts without root. Docker deployments must allow user namespaces in the container (seccomp profile), or use the Docker provider via a socket proxy.
