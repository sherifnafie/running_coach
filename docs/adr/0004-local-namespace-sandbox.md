# ADR 0004: Local sandbox via unprivileged Linux namespaces

- Status: accepted (2026-10-06)
- Context: self-hosters may not run Docker, and the dev/CI environment has no Docker daemon. Unprivileged user namespaces are widely available.
- Decision: `LocalSandboxProvider` runs each command in fresh user+mount+net(+pid) namespaces (`unshare`), with a tmpfs root, read-only rbinds of host OS dirs, the athlete mounts at `/workspace` (rw), `/raw`, `/history`, `/system` (ro), private `/tmp`, then `chroot`. There is no network. A non-isolated fallback exists only when `sandbox.allowUnsafe: true` and logs loudly. Docker remains available as `DockerSandboxProvider` (one container per athlete, network none).
- Consequences: works on most Linux hosts without root. Docker deployments must allow user namespaces in the container (seccomp profile), or use the Docker provider via a socket proxy.
