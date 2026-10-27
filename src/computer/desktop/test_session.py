import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import session


class SessionTests(unittest.TestCase):
    def test_no_instances_output(self):
        for output in (b'\n', b'\n]\n'):
            with patch.object(session.subprocess, 'check_output', return_value=output):
                self.assertEqual(session.query({}, 'instances'), [])
                with self.assertRaises(ValueError):
                    session.query({}, 'monitors')

    def test_ambiguous_instances_fail_closed(self):
        self.assertIsNone(session.single([]))
        self.assertEqual(session.single([{'pid': 1}]), {'pid': 1})
        with self.assertRaises(RuntimeError):
            session.single([{'pid': 1}, {'pid': 2}])

    def test_directory_rejects_public_or_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'private'
            session.private_directory(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            path.chmod(0o755)
            with self.assertRaises(RuntimeError):
                session.private_directory(path)
            link = Path(tmp) / 'link'
            link.symlink_to(path)
            with self.assertRaises(RuntimeError):
                session.private_directory(link)

    def test_only_private_monitor_is_ready(self):
        monitor = {'name': 'PI-AGENT', 'disabled': False, 'width': 1280, 'height': 800}
        instance = {'instance': 'private'}
        with patch.object(session, 'query', return_value=[monitor]):
            self.assertTrue(session.ready({}, instance))
        for monitors in ([], [dict(monitor, name='DP-2')], [dict(monitor, width=1)],
                         [monitor, dict(monitor, name='DP-2')]):
            with patch.object(session, 'query', return_value=monitors):
                self.assertFalse(session.ready({}, instance))
        self.assertFalse(session.ready({}, None))

    def test_no_parent_never_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(session, 'BASE', Path(tmp)), \
             patch.object(session, 'query', return_value=[]), patch.object(session.subprocess, 'Popen') as start:
            with self.assertRaisesRegex(RuntimeError, 'No parent'):
                session.desktop_environment()
            start.assert_not_called()

    # Integration: attaches to (or starts) the real private desktop, which must run this copy's hyprland.lua.
    @unittest.skipUnless(os.environ.get('PI_DESKTOP_LIVE'), 'set PI_DESKTOP_LIVE=1 with a Hyprland parent session')
    def test_existing_live_session_ignores_personal_environment(self):
        with patch.dict(os.environ, {'DISPLAY': ':0', 'HYPRLAND_INSTANCE_SIGNATURE': 'not-the-agent',
                                     'WAYLAND_DISPLAY': '/run/user/1000/wayland-1',
                                     'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
                                     'AT_SPI_BUS_ADDRESS': 'personal'}):
            env = session.desktop_environment()
        self.assertEqual(env['XDG_RUNTIME_DIR'], str(session.BASE / 'pi-desktop'))
        self.assertTrue(env['WAYLAND_DISPLAY'].startswith(str(session.BASE / 'pi-desktop') + '/'))
        self.assertNotEqual(env['HYPRLAND_INSTANCE_SIGNATURE'], 'not-the-agent')
        self.assertNotEqual(env['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/run/user/1000/bus')
        self.assertNotIn('DISPLAY', env)
        self.assertNotIn('AT_SPI_BUS_ADDRESS', env)


if __name__ == '__main__':
    unittest.main()
