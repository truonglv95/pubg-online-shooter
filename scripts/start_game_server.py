#!/usr/bin/env python3
"""Start the game-server as a fully-detached daemon (double-fork).

The sandbox environment aggressively kills processes that are still attached
to the interactive shell's process group / session. Using setsid+nohup alone
is not enough — the parent bash subshell still gets SIGTERM/SIGHUP which
propagates to children. A classic double-fork detaches the daemon from any
controlling terminal and reparents it to PID 1, so it survives.

Usage:
    python3 start_game_server.py          # start
    python3 start_game_server.py restart  # kill existing then start
    python3 start_game_server.py status   # show running PID
"""
import os
import sys
import signal
import time
import subprocess

SERVER_DIR = '/home/z/my-project/mini-services/game-server'
LOG_FILE = '/tmp/game-server.log'
PID_FILE = '/tmp/game-server.pid'


def find_running() -> list[int]:
    """Return PIDs of all running `bun index.ts` processes."""
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
            if 'bun' in cmd and 'index.ts' in cmd:
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
    """Classic double-fork daemon."""
    pid = os.fork()
    if pid > 0:
        time.sleep(0.5)
        return False

    os.setsid()

    pid = os.fork()
    if pid > 0:
        os._exit(0)

    os.chdir(SERVER_DIR)
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

    os.execvp('bun', ['bun', 'index.ts'])


def status():
    pids = find_running()
    if not pids:
        print('game-server: NOT RUNNING')
        return 1
    for pid in pids:
        try:
            with open(f'/proc/{pid}/cmdline', 'r') as f:
                cmd = f.read().replace('\x00', ' ').strip()
        except FileNotFoundError:
            cmd = '?'
        print(f'game-server: RUNNING pid={pid} cmd={cmd}')
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'start'

    if mode == 'status':
        sys.exit(status())

    if mode == 'restart':
        print('Killing existing game-server...')
        kill_existing()

    if mode in ('start', 'restart'):
        if mode == 'start' and find_running():
            print('game-server already running, use "restart" to restart')
            sys.exit(status())

        print(f'Starting game-server (logging to {LOG_FILE})...')
        with open(LOG_FILE, 'a') as f:
            f.write(f'\n=== game-server start at {time.strftime("%Y-%m-%d %H:%M:%S")} ===\n')

        daemonize()
        time.sleep(2)
        return status()


if __name__ == '__main__':
    main()
