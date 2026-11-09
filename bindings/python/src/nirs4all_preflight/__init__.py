"""Thin Python facade over the Rust engine; no numerical implementation."""
from __future__ import annotations

import ctypes
import json
import os
import sys
from pathlib import Path
from typing import Any

__version__ = "0.1.7"
__all__ = ["analyze", "validate", "report_html", "__version__"]

class _Buffer(ctypes.Structure):
    _fields_ = [("data", ctypes.c_void_p), ("len", ctypes.c_size_t)]


def _library() -> ctypes.CDLL:
    suffix = ".dll" if sys.platform == "win32" else ".dylib" if sys.platform == "darwin" else ".so"
    default = Path(__file__).parent / "_native" / ("nirs4all_preflight_capi.dll" if sys.platform == "win32" else "libnirs4all_preflight_capi" + suffix)
    path = os.environ.get("N4PF_LIBRARY_PATH", str(default))
    lib = ctypes.CDLL(path)
    lib.n4pf_abi_version.argtypes = []
    lib.n4pf_abi_version.restype = ctypes.c_uint32
    if lib.n4pf_abi_version() != 1:
        raise RuntimeError("Unsupported nirs4all-preflight C ABI")
    for name in ("n4pf_validate_json", "n4pf_report_html_json"):
        fn = getattr(lib, name)
        fn.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(_Buffer)]
        fn.restype = ctypes.c_int32
    lib.n4pf_analyze_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.POINTER(_Buffer)]
    lib.n4pf_analyze_json.restype = ctypes.c_int32
    lib.n4pf_buffer_free.argtypes = [ctypes.POINTER(_Buffer)]
    lib.n4pf_buffer_free.restype = None
    return lib


def _call(name: str, payload: dict[str, Any], methods_library: str | None = None) -> str:
    data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("JSON_MEMORY_BUDGET_EXCEEDED")
    lib = _library()
    out = _Buffer()
    args = [data, len(data)]
    if name == "n4pf_analyze_json":
        args.append(methods_library.encode("utf-8") if methods_library else None)
    args.append(ctypes.byref(out))
    try:
        status = getattr(lib, name)(*args)
        text = ctypes.string_at(out.data, out.len).decode("utf-8") if out.data else ""
        if status:
            try:
                message = json.loads(text).get("error", text)
            except json.JSONDecodeError:
                message = text
            raise ValueError(message or f"N4PF_STATUS_{status}")
        return text
    finally:
        lib.n4pf_buffer_free(ctypes.byref(out))


def validate(dataset: dict[str, Any]) -> dict[str, Any]:
    """Validate a canonical, already assembled dataset without numerical methods."""
    return json.loads(_call("n4pf_validate_json", dataset))


def analyze(dataset: dict[str, Any], *, methods_library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Qualify development data using Methods, locally in the current process.

    An explicit path or N4M_LIBRARY_PATH takes precedence over the installed
    Methods distribution. The latter exposes its loaded native library path.
    """
    selected = os.fspath(methods_library) if methods_library is not None else os.environ.get("N4M_LIBRARY_PATH")
    if selected is None:
        import n4m

        selected = n4m.library_path()
        if not selected:
            raise RuntimeError("The installed Methods distribution did not report its library path")
        native = Path(selected).resolve()
        package = Path(n4m.__file__).resolve().parent
        if not (native.is_relative_to(package / "lib") or native.is_relative_to(package.parent / "nirs4all_methods.libs")):
            raise RuntimeError("Methods did not load its installed distribution library; use methods_library for an explicit override")
    return json.loads(_call("n4pf_analyze_json", dataset, selected))


def report_html(report: dict[str, Any]) -> str:
    """Render the Rust-generated standalone HTML report with escaped content."""
    return _call("n4pf_report_html_json", report)
