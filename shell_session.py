from __future__ import annotations

import os
import queue
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ShellResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False


class PersistentShellSession:
    """Persistent shell session that preserves cwd/env across commands."""

    def __init__(self, cwd: str):
        self.cwd = str(Path(cwd).resolve())
        self._backend: _BaseShellBackend
        if os.name == "nt":
            self._backend = _WindowsShellBackend(self.cwd)
        else:
            self._backend = _PosixShellBackend(self.cwd)

    def run(self, command: str, timeout: int = 300) -> ShellResult:
        return self._backend.run(command, timeout)

    def interrupt(self) -> None:
        self._backend.interrupt()

    def close(self) -> None:
        self._backend.close()


class _BaseShellBackend:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self._queue: queue.Queue[bytes] = queue.Queue()
        self._closed = False
        self._start()
        self._start_reader()
        self._sync()

    def _start(self) -> None:
        raise NotImplementedError

    def _reader_loop(self) -> None:
        raise NotImplementedError

    def _send(self, script: str) -> None:
        raise NotImplementedError

    def _interrupt_impl(self) -> None:
        raise NotImplementedError

    def _cleanup_impl(self) -> None:
        raise NotImplementedError

    def _build_script(self, command: str, marker: str) -> str:
        raise NotImplementedError

    def _build_sync_command(self, marker: str) -> str:
        raise NotImplementedError

    def _start_reader(self) -> None:
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()

    def _drain_queue(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    def _read_until(self, token: str, timeout: float) -> str | None:
        deadline = time.time() + timeout
        buffer = bytearray()
        token_bytes = token.encode("utf-8")

        while time.time() < deadline:
            try:
                chunk = self._queue.get(timeout=min(0.1, max(deadline - time.time(), 0.01)))
            except queue.Empty:
                if self._process.poll() is not None:
                    break
                continue
            buffer.extend(chunk)
            if token_bytes in buffer:
                return buffer.decode("utf-8", errors="replace")

        return None

    def _sync(self) -> None:
        marker = f"__CODEX_SYNC_{uuid.uuid4().hex}__"
        self._drain_queue()
        self._send(self._build_sync_command(marker))
        synced = self._read_until(marker, timeout=5)
        if synced is None:
            raise RuntimeError("Shell failed to become ready")

    def run(self, command: str, timeout: int = 300) -> ShellResult:
        marker = uuid.uuid4().hex
        stdout_marker = f"__CODEX_STDOUT_{marker}__"
        stderr_marker = f"__CODEX_STDERR_{marker}__"
        exit_marker = f"__CODEX_EXIT_{marker}__"

        self._drain_queue()
        self._send(self._build_script(command, marker))
        raw = self._read_until(exit_marker, timeout=timeout)
        if raw is None:
            self.interrupt()
            return ShellResult(stdout="", stderr="", exit_code=130, timed_out=True)

        return self._parse_result(raw, stdout_marker, stderr_marker, exit_marker)

    def interrupt(self) -> None:
        self._interrupt_impl()
        self._sync()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._cleanup_impl()
        finally:
            self._drain_queue()

    @staticmethod
    def _clean_section(text: str) -> str:
        return text.lstrip("\r\n").rstrip("\r\n")

    def _normalize_output(self, stdout: str, stderr: str) -> tuple[str, str]:
        return self._clean_section(stdout), self._clean_section(stderr)

    def _parse_result(
        self,
        raw: str,
        stdout_marker: str,
        stderr_marker: str,
        exit_marker: str,
    ) -> ShellResult:
        stdout_idx = raw.find(stdout_marker)
        stderr_idx = raw.find(stderr_marker)
        exit_idx = raw.find(exit_marker)
        if min(stdout_idx, stderr_idx, exit_idx) == -1:
            raise RuntimeError(f"Shell output missing command markers: {raw[-500:]}")

        stdout_text = raw[stdout_idx + len(stdout_marker):stderr_idx]
        stderr_text = raw[stderr_idx + len(stderr_marker):exit_idx]
        exit_tail = raw[exit_idx + len(exit_marker):]
        exit_tail = exit_tail.lstrip(":").strip()

        exit_code = 1
        if exit_tail:
            first_line = exit_tail.splitlines()[0].strip()
            try:
                exit_code = int(first_line)
            except ValueError:
                exit_code = 1

        stdout_text, stderr_text = self._normalize_output(stdout_text, stderr_text)
        return ShellResult(
            stdout=stdout_text,
            stderr=stderr_text,
            exit_code=exit_code,
            timed_out=False,
        )


class _WindowsShellBackend(_BaseShellBackend):
    def _start(self) -> None:
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        self._process = subprocess.Popen(
            ["cmd.exe", "/Q", "/V:ON", "/D", "/K", "prompt="],
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        if self._process.stdin is None or self._process.stdout is None:
            raise RuntimeError("Failed to create persistent Windows shell")

    def _reader_loop(self) -> None:
        assert self._process.stdout is not None
        while not self._closed:
            chunk = self._process.stdout.read(1)
            if not chunk:
                return
            self._queue.put(chunk)

    def _send(self, script: str) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write(script.encode("utf-8"))
        self._process.stdin.flush()

    def _interrupt_impl(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()
        if self._process.stdin is not None:
            self._process.stdin.close()
        if self._process.stdout is not None:
            self._process.stdout.close()
        self._start()
        self._start_reader()

    def _cleanup_impl(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
        if self._process.stdin is not None:
            self._process.stdin.close()
        if self._process.stdout is not None:
            self._process.stdout.close()

    def _build_sync_command(self, marker: str) -> str:
        return f"echo {marker}\r\n"

    def _build_script(self, command: str, marker: str) -> str:
        stdout_marker = f"__CODEX_STDOUT_{marker}__"
        stderr_marker = f"__CODEX_STDERR_{marker}__"
        exit_marker = f"__CODEX_EXIT_{marker}__"
        return (
            f"set \"__CODEX_OUT=%TEMP%\\{marker}.out\"\r\n"
            f"set \"__CODEX_ERR=%TEMP%\\{marker}.err\"\r\n"
            f"({command}) 1>\"%__CODEX_OUT%\" 2>\"%__CODEX_ERR%\"\r\n"
            f"echo {stdout_marker}\r\n"
            "type \"%__CODEX_OUT%\"\r\n"
            f"echo {stderr_marker}\r\n"
            "type \"%__CODEX_ERR%\"\r\n"
            f"echo {exit_marker}:!ERRORLEVEL!\r\n"
            "del /Q \"%__CODEX_OUT%\" \"%__CODEX_ERR%\"\r\n"
        )

    def _normalize_output(self, stdout: str, stderr: str) -> tuple[str, str]:
        import re

        def strip_prompts(text: str) -> str:
            lines = []
            for line in self._clean_section(text).splitlines():
                line = line.rstrip()
                line = re.sub(r"^[A-Za-z]:[^\r\n>]*>", "", line)
                if line.endswith(">") and (":\\" in line or ":/" in line):
                    continue
                if line:
                    lines.append(line)
            return "\n".join(lines).strip()

        return strip_prompts(stdout), strip_prompts(stderr)


class _PosixShellBackend(_BaseShellBackend):
    def _start(self) -> None:
        import pty
        import termios

        master_fd, slave_fd = pty.openpty()
        attrs = termios.tcgetattr(slave_fd)
        attrs[3] &= ~termios.ECHO
        termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)

        env = os.environ.copy()
        env["TERM"] = "dumb"
        env["PS1"] = ""
        env["PROMPT_COMMAND"] = ""

        self._master_fd = master_fd
        self._slave_fd = slave_fd
        self._process = subprocess.Popen(
            ["/bin/bash", "--noprofile", "--norc", "-s"],
            cwd=self.cwd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)
        self._slave_fd = None

    def _reader_loop(self) -> None:
        while not self._closed:
            try:
                chunk = os.read(self._master_fd, 1024)
            except OSError:
                return
            if not chunk:
                return
            self._queue.put(chunk)

    def _send(self, script: str) -> None:
        os.write(self._master_fd, script.encode("utf-8"))

    def _interrupt_impl(self) -> None:
        os.write(self._master_fd, b"\x03")

    def _cleanup_impl(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
        try:
            os.close(self._master_fd)
        except OSError:
            pass

    def _build_sync_command(self, marker: str) -> str:
        return f"printf '%s\\n' '{marker}'\n"

    def _build_script(self, command: str, marker: str) -> str:
        stdout_marker = f"__CODEX_STDOUT_{marker}__"
        stderr_marker = f"__CODEX_STDERR_{marker}__"
        exit_marker = f"__CODEX_EXIT_{marker}__"
        return (
            "__codex_out=$(mktemp)\n"
            "__codex_err=$(mktemp)\n"
            "{\n"
            f"{command}\n"
            "} 1>\"$__codex_out\" 2>\"$__codex_err\"\n"
            "__codex_status=$?\n"
            f"printf '%s\\n' '{stdout_marker}'\n"
            "cat \"$__codex_out\"\n"
            f"printf '\\n%s\\n' '{stderr_marker}'\n"
            "cat \"$__codex_err\"\n"
            f"printf '\\n%s:%s\\n' '{exit_marker}' \"$__codex_status\"\n"
            "rm -f \"$__codex_out\" \"$__codex_err\"\n"
        )
