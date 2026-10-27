"""Private graphical session for Pi; never fall back to the personal seat."""
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time

BASE = Path('/run/user') / str(os.getuid())
CONFIG = Path(__file__).with_name('hyprland.lua')
CLEAR = ('DISPLAY', 'XAUTHORITY', 'WAYLAND_SOCKET', 'HYPRLAND_INSTANCE_SIGNATURE',
         'DBUS_SESSION_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE',
         'AT_SPI_BUS_ADDRESS', 'XDG_ACTIVATION_TOKEN', 'DESKTOP_STARTUP_ID')


def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f'Expected a private user-owned directory: {path}')


def query(env, *args):
    output = subprocess.check_output(['hyprctl', '-j', *args], env=env,
                                    stderr=subprocess.PIPE, timeout=3)
    # Hyprland 0.56.2 prints a lone closing bracket when there are no instances.
    if args == ('instances',) and output.strip() in (b'', b']'):
        return []
    return json.loads(output)


def single(instances):
    if len(instances) > 1:
        raise RuntimeError('Ambiguous desktop instances; refusing to choose a seat')
    return instances[0] if instances else None


def ready(env, instance):
    if not instance:
        return False
    target = dict(env, HYPRLAND_INSTANCE_SIGNATURE=instance['instance'])
    monitors = query(target, 'monitors', 'all')
    active = [m for m in monitors if not m['disabled']]
    return len(active) == 1 and active[0]['name'] == 'PI-AGENT' and active[0]['width'] == 1280 and active[0]['height'] == 800


def desktop_environment():
    runtime = BASE / 'pi-desktop'
    private_directory(runtime)
    env = {k: v for k, v in os.environ.items() if k not in CLEAR}
    env.update(XDG_RUNTIME_DIR=str(runtime), HYPRLAND_NO_SD_VARS='1')
    with (runtime / 'start.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        instance = single(query(env, 'instances'))
        if instance is None:
            hosts = query(dict(env, XDG_RUNTIME_DIR=str(BASE)), 'instances')
            signature = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE')
            matching = [host for host in hosts if host['instance'] == signature]
            host = single(matching or hosts)
            if host is None:
                raise RuntimeError('No parent Wayland session; the agent desktop was not started')
            env['WAYLAND_DISPLAY'] = str(BASE / host['wl_socket'])
            with (runtime / 'startup.log').open('a') as log:
                process = subprocess.Popen(['dbus-run-session', '--', 'Hyprland', '--config', str(CONFIG)],
                    env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True, cwd=Path.home())
            deadline = time.monotonic() + 12
            try:
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f'Agent desktop exited; see {runtime}/startup.log')
                    instance = single(query(env, 'instances'))
                    try:
                        if ready(env, instance):
                            break
                    except (subprocess.SubprocessError, json.JSONDecodeError):
                        pass
                    time.sleep(0.05)
                else:
                    raise RuntimeError(f'Agent desktop readiness timed out; see {runtime}/startup.log')
            except BaseException:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
                raise
        if not ready(env, instance):
            raise RuntimeError('Agent desktop is not the expected isolated 1280x800 display')
        process_dir = Path('/proc') / str(instance['pid'])
        command = (process_dir / 'cmdline').read_bytes().split(b'\0')
        if str(CONFIG).encode() not in command:
            raise RuntimeError(f"Private runtime holds a compositor (pid {instance['pid']}) started from another hyprland.lua, e.g. an older or moved install; refusing to attach. Stop it (kill {instance['pid']}) and retry.")
        values = dict(item.split(b'=', 1) for item in (process_dir / 'environ').read_bytes().split(b'\0') if b'=' in item)
        bus = values.get(b'DBUS_SESSION_BUS_ADDRESS', b'').decode()
        if not bus.startswith('unix:'):
            raise RuntimeError('Agent compositor has no private session bus')
        env.update(HYPRLAND_INSTANCE_SIGNATURE=instance['instance'],
                   WAYLAND_DISPLAY=str(runtime / instance['wl_socket']), DBUS_SESSION_BUS_ADDRESS=bus)
        return env
