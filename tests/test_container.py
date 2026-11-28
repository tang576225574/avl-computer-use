import importlib.util
import os
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ContainerTests(unittest.TestCase):
    def test_secret_handoff_and_validation(self):
        spec = importlib.util.spec_from_file_location("entry", ROOT/"container"/"entrypoint.py")
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        env = {"AVL_MODEL_TOKEN":"model-key", "AVL_SUDO_PASSWORD":"pass $'word",
               "SUDO_PW":"old", "VNC_PW":"old", "AVL_MODEL_TOKENS":"cloud-only", "DISPLAY":":1"}
        pwd, token = entry.take_credentials(env)
        self.assertEqual((pwd,token), ("pass $'word","model-key"))
        self.assertEqual(env, {"DISPLAY":":1"})
        with self.assertRaises(ValueError):
            entry.take_credentials({"AVL_MODEL_TOKEN":"t","AVL_SUDO_PASSWORD":"a\nb"})

        for invalid in ("with space", "non-ASCII-é", "a" * 513):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                entry.take_credentials({"AVL_MODEL_TOKEN":invalid, "AVL_SUDO_PASSWORD":"test-only"})

    def test_model_connection_cannot_reuse_the_sudo_password(self):
        spec = importlib.util.spec_from_file_location("entry", ROOT/"container"/"entrypoint.py")
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        with self.assertRaisesRegex(ValueError, "distinct"):
            entry.take_credentials({"AVL_MODEL_TOKEN":"same", "AVL_SUDO_PASSWORD":"same"})

    def test_operation_rejects_extra_arguments_without_touching_credentials(self):
        result = subprocess.run(["/bin/sh",str(ROOT/"container"/"ops-sshd"),"unexpected"],
                                capture_output=True)
        self.assertEqual(result.returncode, 64)
