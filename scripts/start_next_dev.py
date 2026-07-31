#!/usr/bin/env python3
"""Start Next.js dev server as a fully-detached daemon (double-fork)."""
import os
import sys
import signal
import time
import subprocess

PROJECT_DIR = '/home/z/my-project'
LOG_FILE = '/tmp/next-dev.log'
PID_FILE = '/tmp/next-dev.pid'


def find_running() -> list[int]:
    pids = []
    try:
        out = subprocess.check_output(['ps', '-eo', 'pid,cmd'], text=True)
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            pid_str, cmd = parts
            if 'next-server' in cmd or ('next dev' in cmd and 'bun' not in cmd):
                try:
                    pid = int(pid_str)
                    if pid != os.getpid():
                        pids.append(pid)
                except ValueError:
                    continue
    except subprocess.CalledProcessError:
        pass
    return pids


def kill_existing():
    for pid in find_running():
        try:
            os.kill(pid, signal.SIGTERM)
            print(f'  sent SIGTERM to {pid}')
        except ProcessLookupError:
            pass
    time.sleep(1)
    for pid in find_running():
        try:
            os.kill(pid, signal.SIGKILL)
            print(f'  sent SIGKILL to {pid}')
        except ProcessLookupError:
            pass


def daemonize():
    pid = os.fork()
    if pid > 0:
        time.sleep(0.5)
        return False
    os.setsid()
    pid = os.fork()
    if pid > 0:
        os._exit(0)
    os.chdir(PROJECT_DIR)
    os.umask(0)
    sys.stdout.flush()
    sys.stderr.flush()
    with open('/dev/null', 'r') as f:
        os.dup2(f.fileno(), 0)
    with open(LOG_FILE, 'a') as f:
        os.dup2(f.fileno(), 1)
        os.dup2(f.fileno(), 2)
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))
    os.execvp('bun', ['bun', 'run', 'dev'])


def status():
    pids = find_running()
    if not pids:
        print('next-dev: NOT RUNNING')
        return 1
    for pid in pids:
        print(f'next-dev: RUNNING pid={pid}')
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'start'
    if mode == 'status':
        sys.exit(status())
    if mode == 'restart':
        print('Killing existing next-dev...')
        kill_existing()
    if mode in ('start', 'restart'):
        if mode == 'start' and find_running():
            print('next-dev already running')
            sys.exit(status())
        print(f'Starting next-dev (logging to {LOG_FILE})...')
        with open(LOG_FILE, 'a') as f:
            f.write(f'\n=== next-dev start at {time.strftime("%Y-%m-%d %H:%M:%S")} ===\n')
        daemonize()
        time.sleep(3)
        return status()


if __name__ == '__main__':
    main()
