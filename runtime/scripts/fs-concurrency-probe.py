#!/usr/bin/env python3
"""Concurrent filesystem probe: N threads doing mkdir + create(O_TRUNC) + write + chmod in a target directory.

Usage: fs-concurrency-probe.py [DIR] [--threads N] [--ops N] [--keep]
  DIR defaults to $HOME. Run it inside a session (home = encrypted shard mount) and compare against /tmp.
  On the host, point it at a mounted shard, e.g. /mnt/floq/<uid> (as that uid, e.g. setpriv --reuid=<uid> ...).
Exit status: 0 = no errors, 1 = errors seen (EPERM on a healthy mount is the gocryptfs fsuid bug, see docs/).
"""
import argparse, errno, os, shutil, sys, threading, time
from collections import Counter

parser = argparse.ArgumentParser()
parser.add_argument("dir", nargs="?", default=os.path.expanduser("~"))
parser.add_argument("--threads", type=int, default=8)
parser.add_argument("--ops", type=int, default=150, help="iterations per thread (4 syscalls each)")
parser.add_argument("--keep", action="store_true")
args = parser.parse_args()

root = os.path.join(args.dir, ".fs-probe-%d-%d" % (os.getpid(), int(time.time())))
os.mkdir(root, 0o755)
errors, lock, total = Counter(), threading.Lock(), [0]

def attempt(name, fn):
    try:
        fn()
    except OSError as e:
        with lock:
            errors[(name, errno.errorcode.get(e.errno, str(e.errno)))] += 1
    finally:
        with lock:
            total[0] += 1

def worker(tid):
    base = os.path.join(root, "t%d" % tid)
    attempt("mkdir", lambda: os.mkdir(base, 0o755))
    for i in range(args.ops):
        d = os.path.join(base, "d%d" % i)
        f = os.path.join(d, "f")
        attempt("mkdir", lambda: os.mkdir(d, 0o755))
        def create():
            fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            try:
                os.write(fd, b"x" * 4096)
            finally:
                os.close(fd)
        attempt("create+write", create)
        attempt("chmod", lambda: os.chmod(f, 0o600))

threads = [threading.Thread(target=worker, args=(t,)) for t in range(args.threads)]
start = time.time()
for t in threads: t.start()
for t in threads: t.join()
elapsed = time.time() - start
if not args.keep:
    shutil.rmtree(root, ignore_errors=True)

print("dir=%s threads=%d ops=%d elapsed=%.1fs" % (args.dir, args.threads, total[0], elapsed))
if errors:
    for (op, code), n in sorted(errors.items()):
        print("  FAIL %-13s %-8s x%d" % (op, code, n))
    print("RESULT: %d failures" % sum(errors.values()))
    sys.exit(1)
print("RESULT: OK (0 failures)")
