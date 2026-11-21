"""Run LLM-written verification scripts in a restricted subprocess.

Layers of protection (all best-effort):
  1. AST filter: only whitelisted imports, no open/exec/eval/getattr/dunder access.
  2. Separate process: `python -I`, empty environment, temp working dir.
  3. OS limits (Linux/Android/Termux): CPU seconds, memory, max file size.
  4. Wall-clock timeout.

WARNING: this is NOT a hardened security sandbox. A determined attacker could escape an
AST filter. It is fine for your own machine / private use. If you expose the API publicly,
run the whole backend inside Docker (no network, read-only filesystem) or a VM.
"""
import ast
import os
import re
import subprocess
import sys
import tempfile

ALLOWED_IMPORTS = {
    "math", "cmath", "fractions", "decimal", "itertools", "functools", "statistics",
    "random", "collections", "heapq", "bisect", "re", "string", "typing", "dataclasses",
    "operator", "numbers", "sympy", "numpy", "scipy", "pint",
}
BLOCKED_NAMES = {
    "open", "exec", "eval", "compile", "__import__", "input", "breakpoint", "getattr",
    "setattr", "delattr", "globals", "locals", "vars", "memoryview", "exit", "quit",
}


class Rejected(Exception):
    pass


def _check_ast(code: str) -> None:
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORTS:
                    raise Rejected(f"import not allowed: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            if node.level != 0 or (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                raise Rejected(f"import not allowed: {node.module}")
        elif isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            raise Rejected(f"name not allowed: {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise Rejected(f"attribute not allowed: {node.attr}")


def _status(returncode: int, stdout: str) -> str:
    if returncode != 0:
        return "ERROR"
    if re.search(r"\bFAIL", stdout, re.IGNORECASE):
        return "FAIL"
    if re.search(r"\bPASS", stdout, re.IGNORECASE):
        return "PASS"
    return "UNCLEAR"


def run_python(code: str, timeout: int = 10, mem_mb: int = 1024, max_output: int = 1500) -> dict:
    """Returns {"status": PASS|FAIL|ERROR|UNCLEAR|TIMEOUT|REJECTED, "output": str}."""
    try:
        _check_ast(code)
    except SyntaxError as e:
        return {"status": "REJECTED", "output": f"syntax error: {e}"}
    except Rejected as e:
        return {"status": "REJECTED", "output": str(e)}

    def limits():  # runs in the child process before exec (posix only)
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (timeout + 1, timeout + 1))
        resource.setrlimit(resource.RLIMIT_AS, (mem_mb * 1024 * 1024, mem_mb * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))

    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONIOENCODING": "utf-8",
        "OMP_NUM_THREADS": "1",
    }
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "check.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        try:
            p = subprocess.run(
                [sys.executable, "-I", path],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=d,
                env=env,
                preexec_fn=limits if os.name == "posix" else None,
            )
        except subprocess.TimeoutExpired:
            return {"status": "TIMEOUT", "output": f"exceeded {timeout}s"}

    out = p.stdout.strip()
    if p.returncode != 0:
        out = (out + "\n" + p.stderr.strip()[-600:]).strip()
    return {"status": _status(p.returncode, p.stdout), "output": out[:max_output]}
