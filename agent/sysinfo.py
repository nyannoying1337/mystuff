"""Live machine numbers for the status page, without installing anything.

psutil covers CPU, memory and uptime everywhere. On Windows the GPU name comes
from the registry and its load and memory from the same performance counters
Task Manager reads. Hostname, user name and addresses are never read.
"""

from __future__ import annotations

import logging
import platform
import sys
import time

import psutil

log = logging.getLogger("agent")

_static: dict | None = None
_gpu_counters = None


def _windows_cpu_name() -> str | None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
    except OSError:
        return None


def _windows_gpu() -> tuple[str | None, int | None]:
    """The first real display adapter and its dedicated memory in bytes."""
    import winreg

    base = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base)
    except OSError:
        return None, None
    best: tuple[str | None, int | None] = (None, None)
    with root:
        for index in range(winreg.QueryInfoKey(root)[0]):
            name = winreg.EnumKey(root, index)
            if not name.isdigit():
                continue
            try:
                with winreg.OpenKey(root, name) as key:
                    description = str(winreg.QueryValueEx(key, "DriverDesc")[0])
                    try:
                        memory = int(winreg.QueryValueEx(key, "HardwareInformation.qwMemorySize")[0])
                    except (OSError, ValueError, TypeError):
                        memory = None
            except OSError:
                continue
            if "basic display" in description.lower() or "remote display" in description.lower():
                continue
            # prefer the adapter with the most memory: the discrete card over the iGPU
            if best[0] is None or (memory or 0) > (best[1] or 0):
                best = (description, memory)
    return best


def _static_info() -> dict:
    global _static
    if _static is None:
        info = {
            "os": f"{platform.system()} {platform.release()}".strip(),
            "cpu_cores": psutil.cpu_count(),
        }
        if sys.platform == "win32":
            info["kernel"] = platform.version()
            info["cpu"] = _windows_cpu_name()
            info["gpu"], info["vram_total"] = _windows_gpu()
        else:
            info["kernel"] = platform.release()
            info["cpu"] = platform.processor() or None
        _static = {key: value for key, value in info.items() if value}
        psutil.cpu_percent(None)  # prime: the first reading is always 0
    return dict(_static)


class _GpuCounters:
    """Sums per-process 3D engine load, like Task Manager's GPU column."""

    PDH_FMT_DOUBLE = 0x200
    PDH_MORE_DATA = 0x800007D2

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class Value(ctypes.Structure):
            _fields_ = [("status", wintypes.DWORD), ("value", ctypes.c_double)]

        class Item(ctypes.Structure):
            _fields_ = [("name", wintypes.LPWSTR), ("value", Value)]

        self.ctypes, self.wintypes, self.Item = ctypes, wintypes, Item
        self.pdh = ctypes.WinDLL("pdh")
        self.query = wintypes.HANDLE()
        if self.pdh.PdhOpenQueryW(None, 0, ctypes.byref(self.query)):
            raise OSError("PdhOpenQueryW failed")
        self.load = self._add(r"\GPU Engine(*engtype_3D)\Utilization Percentage")
        self.memory = self._add(r"\GPU Adapter Memory(*)\Dedicated Usage")
        self.pdh.PdhCollectQueryData(self.query)

    def _add(self, path):
        handle = self.wintypes.HANDLE()
        if self.pdh.PdhAddEnglishCounterW(self.query, path, 0, self.ctypes.byref(handle)):
            return None
        return handle

    def _values(self, handle) -> list[float]:
        ctypes, wintypes = self.ctypes, self.wintypes
        size, count = wintypes.DWORD(0), wintypes.DWORD(0)
        status = self.pdh.PdhGetFormattedCounterArrayW(handle, self.PDH_FMT_DOUBLE, ctypes.byref(size), ctypes.byref(count), None)
        if status & 0xFFFFFFFF != self.PDH_MORE_DATA:
            return []
        buffer = (ctypes.c_byte * size.value)()
        if self.pdh.PdhGetFormattedCounterArrayW(handle, self.PDH_FMT_DOUBLE, ctypes.byref(size), ctypes.byref(count), buffer):
            return []
        items = ctypes.cast(buffer, ctypes.POINTER(self.Item * count.value)).contents
        return [item.value.value for item in items if item.value.status in (0, 1)]

    def sample(self) -> dict:
        if self.pdh.PdhCollectQueryData(self.query):
            return {}
        out = {}
        if self.load:
            load = self._values(self.load)
            if load:
                out["gpu_percent"] = round(min(100.0, sum(load)), 1)
        if self.memory:
            memory = self._values(self.memory)
            if memory:
                out["vram_used"] = int(max(memory))
        return out


def _gpu_sample() -> dict:
    global _gpu_counters
    if sys.platform != "win32" or _gpu_counters is False:
        return {}
    try:
        if _gpu_counters is None:
            _gpu_counters = _GpuCounters()
            return {}  # load needs two samples; the next push has it
        return _gpu_counters.sample()
    except (OSError, AttributeError, ValueError) as err:
        log.info("GPU counters unavailable: %s", err)
        _gpu_counters = False
        return {}


def collect() -> dict:
    """CPU and GPU load are averaged since the previous call, i.e. over one push interval."""
    first = _static is None
    system = _static_info()
    memory = psutil.virtual_memory()
    if not first:  # the first reading has nothing to average over
        system["cpu_percent"] = round(psutil.cpu_percent(None), 1)
    system.update(
        mem_used=memory.total - memory.available,
        mem_total=memory.total,
        uptime={"uptime": int((time.time() - psutil.boot_time()) * 1000)},
    )
    system.update(_gpu_sample())
    return system
