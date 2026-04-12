import os
import shutil
import tempfile
import unittest

from pathlib import Path

from shell_session import PersistentShellSession


def _commands_for_platform(temp_dir: str) -> dict[str, str]:
    if os.name == "nt":
        return {
            "make_and_cd": "cd ..",
            "pwd": "cd",
            "pwd_expected": str(Path(temp_dir).resolve().parent),
            "set_env": "set FOO=bar",
            "get_env": "echo %FOO%",
            "sleep": "powershell -NoLogo -NoProfile -Command \"Start-Sleep -Seconds 5\"",
            "alive": "echo alive",
        }
        return {
            "make_and_cd": "mkdir -p subdir && cd subdir",
            "pwd": "pwd",
            "pwd_expected": str(Path(temp_dir, "subdir").resolve()),
            "set_env": "export FOO=bar",
            "get_env": "printf '%s' \"$FOO\"",
            "sleep": "sleep 5",
            "alive": "echo alive",
        }


class PersistentShellSessionTests(unittest.TestCase):
    def _make_temp_dir(self) -> str:
        return tempfile.mkdtemp(dir=os.getcwd())

    def test_shell_preserves_working_directory(self):
        temp_dir = self._make_temp_dir()
        commands = _commands_for_platform(temp_dir)
        shell = PersistentShellSession(cwd=temp_dir)
        try:
            shell.run(commands["make_and_cd"])
            result = shell.run(commands["pwd"])

            if os.name != "nt":
                self.assertEqual(result.exit_code, 0)
            self.assertEqual(Path(result.stdout.strip()).resolve(), Path(commands["pwd_expected"]).resolve())
        finally:
            shell.close()
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_shell_preserves_environment_variables(self):
        temp_dir = self._make_temp_dir()
        commands = _commands_for_platform(temp_dir)
        shell = PersistentShellSession(cwd=temp_dir)
        try:
            shell.run(commands["set_env"])
            result = shell.run(commands["get_env"])

            if os.name != "nt":
                self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.stdout.strip(), "bar")
        finally:
            shell.close()
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_shell_timeout_interrupts_command_but_keeps_session_alive(self):
        temp_dir = self._make_temp_dir()
        commands = _commands_for_platform(temp_dir)
        shell = PersistentShellSession(cwd=temp_dir)
        try:
            timed_out = shell.run(commands["sleep"], timeout=1)
            follow_up = shell.run(commands["alive"])

            self.assertTrue(timed_out.timed_out)
            self.assertIn("alive", follow_up.stdout)
            if os.name != "nt":
                self.assertEqual(follow_up.exit_code, 0)
        finally:
            shell.close()
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
