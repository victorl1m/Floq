# Encrypted home: concurrent EPERM

Symptom: inside a session, parallel file/dir creation on `/home/agent` randomly fails with `EPERM`
(`mkdirat`/`openat(O_CREAT)`); `flutter pub get`, npm/pnpm, cargo and git may hit it. `/tmp` is unaffected.

Cause (upstream gocryptfs issue 892): the shard is mounted by root with `-allow_other`, so gocryptfs switches
to the calling uid per request on a locked OS thread. Debian bookworm's gocryptfs 2.3 is built against a newer
golang.org/x/sys whose `Setreuid`/`Setregid` apply to every thread, so concurrent requests clobber each other's
credentials and the kernel returns EPERM. Fixed upstream in v2.5.1; the image now installs the pinned
upstream v2.6.1 static binary (checksum verified at build) instead of the Debian package.

Verify after deploying the new image (existing mounts keep the old binary until the shard sleeps and wakes, or
the container is recreated):

    gocryptfs -version                                  # expect v2.6.1
    python3 runtime/scripts/fs-concurrency-probe.py ~ --threads 8     # in a session: expect 0 failures
    python3 runtime/scripts/fs-concurrency-probe.py /tmp --threads 8  # control (tmpfs)

The probe exits 1 and prints per-op error counts when anything fails. On the host, run it as the shard uid
against the mountpoint, e.g. `setpriv --reuid=<uid> --regid=<uid> --clear-groups python3 fs-concurrency-probe.py /mnt/floq/<uid>`.

Workaround on an unfixed image: keep hot, highly parallel caches off the home mount, e.g. for Flutter
`export PUB_CACHE=/tmp/pub-cache` (lost on session restart).
