import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx

from avl_computer_use.backend.control import Desktop, InputRejected
from avl_computer_use.backend import desktop_ops as ops
from avl_computer_use.backend.server import Runtime, Settings, create_app
from avl_computer_use.backend.wire import Frame


class DesktopOpsTests(unittest.IsolatedAsyncioTestCase):
    def test_repair_rechecks_target_and_rebuilds_dependencies_in_order(self):
        with patch.object(ops, "healthy", return_value=True), patch.object(ops, "control") as control:
            ops.recover("backend")
            control.assert_not_called()

        with patch.object(ops, "healthy", side_effect=lambda name: name != "x11"), \
             patch.object(ops, "control") as control:
            ops.recover("x11")
            self.assertEqual(
                [call.args for call in control.call_args_list],
                [("stop", "backend"), ("stop", "novnc"), ("stop", "xfce"),
                 ("restart", "x11"), ("start", "xfce"), ("start", "novnc"), ("start", "backend")],
            )

    def test_dependent_recovery_waits_for_x11_and_no_other_command_is_allowed(self):
        with patch.object(ops, "healthy", return_value=False), patch.object(ops, "control") as control:
            ops.recover("xfce")
            control.assert_not_called()
        with self.assertRaises(ValueError):
            ops.recover("sshd")
        for command in ("recover backend; id", "recover sshd", "restart x11", "probe\nprobe"):
            self.assertIsNone(ops.parse_operation(command))

    def test_password_authenticated_entrypoint_only_accepts_an_allowed_operation(self):
        with patch.object(ops, "recover_locked") as recover:
            with patch("sys.argv", ["desktop_ops", "recover", "backend"]):
                self.assertEqual(ops.main(), 0)
                recover.assert_called_once_with("backend")
            recover.reset_mock()
            with patch("sys.argv", ["desktop_ops", "recover", "sshd"]):
                self.assertEqual(ops.main(), 2)
                recover.assert_not_called()

    def test_probe_and_repair_use_the_configured_supervisor(self):
        config = "/etc/supervisor/current-desktop.conf"
        with patch.object(ops, "probe_config", return_value={"supervisor_config": config}), \
             patch.object(ops.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "xfce RUNNING"
            self.assertEqual(ops.supervisor_state("xfce"), "RUNNING")
            ops.control("restart", "backend")
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ("/usr/bin/supervisorctl", "-c", config, "status", "xfce"),
            ("/usr/bin/supervisorctl", "-c", config, "stop", "backend"),
            ("/usr/bin/supervisorctl", "-c", config, "start", "backend"),
        ])

    def test_backend_health_distinguishes_a_frozen_frame_from_a_live_frame(self):
        desktop = Desktop(stale_after=5)
        with self.assertRaises(InputRejected):
            desktop.require_live()
        frame = Frame("generation", 1, 123, 640, 360, b"jpeg")
        with patch("time.monotonic", return_value=100):
            desktop.publish(frame)
        with patch("time.monotonic", return_value=100.5):
            self.assertEqual(desktop.require_live(), frame)
        with patch("time.monotonic", return_value=105):
            with self.assertRaises(InputRejected):
                desktop.require_live()

    def test_backend_probe_uses_the_existing_desktop_port_without_sending_a_token(self):
        with patch.object(ops, "probe_config", return_value={"backend_port": 8081}), \
             patch.object(ops, "http_status", return_value=204) as request:
            self.assertTrue(ops.backend_live())
            request.assert_called_once_with(8081, "/v1/health")

    async def test_http_health_reports_liveness_without_returning_desktop_data(self):
        app = create_app(Settings("desktop-test", "model-test", synthetic=True))
        async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://desktop",
        ) as client:
            with patch.object(Desktop, "require_live", side_effect=InputRejected("stale")):
                stale = await client.get("/v1/health")
            with patch.object(Desktop, "require_live"):
                live = await client.get("/v1/health")
        self.assertEqual(stale.status_code, 503)
        self.assertEqual(live.status_code, 204)
        self.assertEqual(stale.content, b"")


class RecoveryStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_backend_restart_retains_submissions_and_pauses_previous_manual_owner(self):
        with TemporaryDirectory() as directory:
            settings = Settings("desktop-test", "model-test", state_path=str(Path(directory) / "control.sqlite"))
            before = Runtime(settings)
            before.desktop.publish(Frame("old", 1, 123, 640, 360, b"jpeg"))
            self.assertTrue(before.recovery.reserve("old-request", observe_only=False))
            await before.desktop.take_control(object())
            before.recovery.close()

            after = Runtime(settings)
            try:
                self.assertEqual(after.desktop.mode, "paused")
                self.assertTrue(after.needs_observation)
                self.assertFalse(after.recovery.reserve("old-request", observe_only=False))
                after.desktop.publish(Frame("new", 1, 123, 640, 360, b"jpeg"))
                await after.desktop.resume_agent()
                self.assertFalse(after.recovery.restore()[0])
            finally:
                after.recovery.close()
