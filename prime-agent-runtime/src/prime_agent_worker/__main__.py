from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import threading
import time
import traceback
import types
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from IPython.core.interactiveshell import InteractiveShell

JSONRPC_VERSION = "2.0"


def is_record(value: Any) -> bool:
	return isinstance(value, dict)


def duplicate_protocol_stdout() -> Any:
	try:
		fd = os.dup(sys.stdout.fileno())
		return os.fdopen(
			fd,
			"w",
			encoding=getattr(sys.stdout, "encoding", None) or "utf-8",
			errors="replace",
			buffering=1,
		)
	except Exception:
		return sys.stdout


def strip_ipython_displayhook(stdout: str, result_text: str | None) -> str:
	if result_text is None:
		return stdout
	pattern = re.compile(rf"^Out\[\d+\]: {re.escape(result_text)}\n?", re.MULTILINE)
	return pattern.sub("", stdout, count=1)


class RpcError(Exception):
	def __init__(self, message: str, data: Any | None = None) -> None:
		super().__init__(message)
		self.data = data


class JsonRpcPeer:
	def __init__(self) -> None:
		self._stdout = duplicate_protocol_stdout()
		self._stdin = sys.stdin
		self._write_lock = threading.Lock()
		self._next_id = 1
		self._pending: dict[str, asyncio.Future[Any]] = {}
		self._loop = asyncio.get_running_loop()
		self.app: PrimeWorker | None = None

	def send_sync(self, message: dict[str, Any]) -> None:
		payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
		with self._write_lock:
			self._stdout.write(payload)
			self._stdout.write("\n")
			self._stdout.flush()

	def notify_sync(self, method: str, params: dict[str, Any]) -> None:
		self.send_sync({"jsonrpc": JSONRPC_VERSION, "method": method, "params": params})

	async def request(self, method: str, params: dict[str, Any]) -> Any:
		request_id = self._next_id
		self._next_id += 1
		future: asyncio.Future[Any] = self._loop.create_future()
		self._pending[str(request_id)] = future
		self.send_sync({"jsonrpc": JSONRPC_VERSION, "id": request_id, "method": method, "params": params})
		return await future

	async def read_loop(self) -> None:
		while True:
			line = await asyncio.to_thread(self._stdin.readline)
			if line == "":
				return
			line = line.strip()
			if not line:
				continue
			try:
				message = json.loads(line)
			except json.JSONDecodeError:
				continue
			await self.handle_message(message)

	async def handle_message(self, message: Any) -> None:
		if not is_record(message):
			return

		if "method" in message and "id" in message:
			asyncio.create_task(self.handle_request(message))
			return

		if "method" in message:
			return

		request_id = str(message.get("id"))
		future = self._pending.pop(request_id, None)
		if future is None or future.done():
			return

		error = message.get("error")
		if is_record(error):
			future.set_exception(RpcError(str(error.get("message", "RPC error")), error.get("data")))
			return

		future.set_result(message.get("result"))

	async def handle_request(self, message: dict[str, Any]) -> None:
		request_id = message.get("id")
		try:
			if self.app is None:
				raise RpcError("worker is not initialized")
			result = await self.app.dispatch(str(message.get("method")), message.get("params"))
			self.send_sync({"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result})
		except Exception as exc:
			self.send_sync(
				{
					"jsonrpc": JSONRPC_VERSION,
					"id": request_id,
					"error": {"code": -32000, "message": str(exc), "data": traceback.format_exc()},
				}
			)


class OutputCapture:
	def __init__(self, peer: JsonRpcPeer, execute_id: Any, stream: str, max_chars: int) -> None:
		self.peer = peer
		self.execute_id = execute_id
		self.stream = stream
		self.max_chars = max_chars
		self.parts: list[str] = []
		self.length = 0
		self.truncated = False
		self._lock = threading.Lock()
		self.encoding = "utf-8"
		self.errors = "replace"

	def write(self, text: str) -> int:
		if text:
			self.peer.notify_sync(
				"output",
				{"execute_id": self.execute_id, "stream": self.stream, "text": text},
			)
			with self._lock:
				self._append(text)
		return len(text)

	def flush(self) -> None:
		return None

	def isatty(self) -> bool:
		return False

	def _append(self, text: str) -> None:
		if self.length >= self.max_chars:
			self.truncated = True
			return

		remaining = self.max_chars - self.length
		if len(text) > remaining:
			self.parts.append(text[:remaining])
			self.length = self.max_chars
			self.truncated = True
			return

		self.parts.append(text)
		self.length += len(text)

	def getvalue(self) -> str:
		with self._lock:
			value = "".join(self.parts)
			if self.truncated:
				return value + f"\n[... output truncated at {self.max_chars} chars ...]"
			return value


def redirect_fd_to_capture(fd: int, capture: OutputCapture) -> tuple[int, threading.Thread]:
	read_fd, write_fd = os.pipe()
	saved_fd = os.dup(fd)
	os.dup2(write_fd, fd)
	os.close(write_fd)

	def read_pipe() -> None:
		with os.fdopen(read_fd, "rb", closefd=True) as stream:
			while True:
				chunk = stream.read(4096)
				if not chunk:
					return
				capture.write(chunk.decode("utf-8", errors="replace"))

	thread = threading.Thread(target=read_pipe, daemon=True)
	thread.start()
	return saved_fd, thread


@contextmanager
def capture_output(peer: JsonRpcPeer, execute_id: Any, max_chars: int) -> Iterator[tuple[OutputCapture, OutputCapture]]:
	stdout = OutputCapture(peer, execute_id, "stdout", max_chars)
	stderr = OutputCapture(peer, execute_id, "stderr", max_chars)
	old_stdout = sys.stdout
	old_stderr = sys.stderr
	saved_stdout_fd, stdout_thread = redirect_fd_to_capture(1, stdout)
	saved_stderr_fd, stderr_thread = redirect_fd_to_capture(2, stderr)
	sys.stdout = stdout
	sys.stderr = stderr
	try:
		yield stdout, stderr
	finally:
		try:
			sys.stdout.flush()
			sys.stderr.flush()
		except Exception:
			pass
		sys.stdout = old_stdout
		sys.stderr = old_stderr
		os.dup2(saved_stdout_fd, 1)
		os.close(saved_stdout_fd)
		os.dup2(saved_stderr_fd, 2)
		os.close(saved_stderr_fd)
		stdout_thread.join(timeout=1)
		stderr_thread.join(timeout=1)


@dataclass
class TokenUsage:
	prompt_tokens: int
	completion_tokens: int


@dataclass
class RLMResult:
	answer: str
	usage: TokenUsage
	turns: int
	session_dir: Path | None = None


@dataclass
class RLMBackgroundStatus:
	id: str
	state: str
	session_dir: Path | None = None
	result: RLMResult | None = None
	error: str | None = None
	timed_out: bool = False


class RLMBackgroundHandle:
	def __init__(self, host: HostRLM, id: str, state: str, session_dir: Path | None = None) -> None:
		self._host = host
		self.id = id
		self.state = state
		self.session_dir = session_dir

	async def status(self) -> RLMBackgroundStatus:
		return await self._host.background_status(self.id)

	async def wait(self, timeout: float | None = None) -> RLMBackgroundStatus:
		timeout_ms = None if timeout is None else int(timeout * 1000)
		return await self._host.background_wait(self.id, timeout_ms=timeout_ms)

	async def result(self, timeout: float | None = None) -> RLMResult:
		status = await self.wait(timeout=timeout)
		if status.result is not None:
			return status.result
		if status.timed_out:
			raise TimeoutError(f"RLM background run {self.id} did not finish before timeout")
		if status.error:
			raise RuntimeError(status.error)
		raise RuntimeError(f"RLM background run {self.id} is {status.state}")


class HostRLM:
	def __init__(self, peer: JsonRpcPeer) -> None:
		self.peer = peer

	def _ensure_recursion_allowed(self) -> None:
		depth = int(os.environ.get("RLM_DEPTH", "0"))
		max_depth = int(os.environ.get("RLM_MAX_DEPTH", "5"))
		if depth >= max_depth:
			raise RuntimeError(f"RLM recursion limit reached: depth {depth} >= max depth {max_depth}")

	async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
		return await self.run(prompt, **kwargs)

	async def run(self, prompt: str, **kwargs: Any) -> RLMResult:
		self._ensure_recursion_allowed()
		payload = await self.peer.request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
		return self._to_result(payload)

	async def background(self, prompt: str, **kwargs: Any) -> RLMBackgroundHandle:
		self._ensure_recursion_allowed()
		payload = await self.peer.request("rlm.background", {"prompt": prompt, "kwargs": kwargs})
		return RLMBackgroundHandle(
			self,
			id=str(payload["id"]),
			state=str(payload["state"]),
			session_dir=self._to_path(payload.get("session_dir")),
		)

	async def background_status(self, id: str) -> RLMBackgroundStatus:
		payload = await self.peer.request("rlm.background_status", {"id": id})
		return self._to_status(payload)

	async def background_wait(self, id: str, timeout_ms: int | None = None) -> RLMBackgroundStatus:
		payload = await self.peer.request("rlm.background_wait", {"id": id, "timeoutMs": timeout_ms})
		return self._to_status(payload)

	def _to_path(self, value: Any) -> Path | None:
		if value is None:
			return None
		return Path(str(value))

	def _to_usage(self, payload: Any) -> TokenUsage:
		return TokenUsage(
			prompt_tokens=int(payload.get("prompt_tokens", 0)),
			completion_tokens=int(payload.get("completion_tokens", 0)),
		)

	def _to_result(self, payload: Any) -> RLMResult:
		return RLMResult(
			answer=str(payload.get("answer", "")),
			usage=self._to_usage(payload.get("usage", {})),
			turns=int(payload.get("turns", 0)),
			session_dir=self._to_path(payload.get("session_dir")),
		)

	def _to_status(self, payload: Any) -> RLMBackgroundStatus:
		result_payload = payload.get("result")
		return RLMBackgroundStatus(
			id=str(payload.get("id", "")),
			state=str(payload.get("state", "")),
			session_dir=self._to_path(payload.get("session_dir")),
			result=None if result_payload is None else self._to_result(result_payload),
			error=None if payload.get("error") is None else str(payload.get("error")),
			timed_out=bool(payload.get("timed_out", False)),
		)


class CallableRLMModule(types.ModuleType):
	def __call__(self, prompt: str, **kwargs: Any) -> Any:
		return self.rlm(prompt, **kwargs)


def install_rlm_module(host: HostRLM) -> None:
	module = CallableRLMModule("rlm")
	module.rlm = host
	module.run = host.run
	module.background = host.background
	module.background_status = host.background_status
	module.background_wait = host.background_wait
	module.TokenUsage = TokenUsage
	module.RLMResult = RLMResult
	module.RLMBackgroundStatus = RLMBackgroundStatus
	module.RLMBackgroundHandle = RLMBackgroundHandle
	sys.modules["rlm"] = module


class PrimeWorker:
	def __init__(self, peer: JsonRpcPeer) -> None:
		self.peer = peer
		self.shell = InteractiveShell.instance()
		self.host_rlm = HostRLM(peer)
		install_rlm_module(self.host_rlm)
		self.shell.user_ns["rlm"] = self.host_rlm

	async def dispatch(self, method: str, params: Any) -> Any:
		if method == "ping":
			return {"ok": True}
		if method == "execute":
			return await self.execute(params)
		if method == "shutdown":
			asyncio.get_running_loop().call_soon(asyncio.get_running_loop().stop)
			return {"ok": True}
		raise RpcError(f"unknown method: {method}")

	async def execute(self, params: Any) -> dict[str, Any]:
		if not is_record(params):
			raise RpcError("execute params must be an object")
		code = str(params.get("code", ""))
		execute_id = params.get("execute_id")
		max_chars = int(params.get("max_output_chars", 65536))
		started_at = time.monotonic()

		error_payload = None
		result_text = None
		with capture_output(self.peer, execute_id, max_chars) as (stdout, stderr):
			try:
				transformed_cell = self.shell.transform_cell(code)
				preprocessing_exc_tuple = None
			except Exception:
				transformed_cell = code
				preprocessing_exc_tuple = sys.exc_info()
			execution_result = await self.shell.run_cell_async(
				code,
				store_history=True,
				transformed_cell=transformed_cell,
				preprocessing_exc_tuple=preprocessing_exc_tuple,
			)
			error = execution_result.error_before_exec or execution_result.error_in_exec
			if error is not None:
				error_payload = {
					"ename": type(error).__name__,
					"evalue": str(error),
					"traceback": traceback.format_exception(type(error), error, error.__traceback__),
				}
			elif execution_result.result is not None:
				result_text = repr(execution_result.result)

		return {
			"stdout": strip_ipython_displayhook(stdout.getvalue(), result_text),
			"stderr": stderr.getvalue(),
			"result": result_text,
			"status": "error" if error_payload is not None else "ok",
			"error": error_payload,
			"durationMs": int((time.monotonic() - started_at) * 1000),
		}


async def main() -> None:
	peer = JsonRpcPeer()
	app = PrimeWorker(peer)
	peer.app = app
	await peer.read_loop()


if __name__ == "__main__":
	asyncio.run(main())
