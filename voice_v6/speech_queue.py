"""Ordered, interruptible, de-duplicated sentence queue (backend state per response_id)."""
from __future__ import annotations
import threading, time


class SpeechQueue:
    def __init__(self):
        self._lock = threading.Lock()
        self.items: dict[str, dict] = {}   # rid -> {chunks:[...], state, created}
        self.active: str | None = None

    def start(self, rid: str, chunks: list[dict]) -> bool:
        """False when rid already exists (duplicate prevention). A new response interrupts the active one."""
        with self._lock:
            if rid in self.items:
                return False
            if self.active and self.items.get(self.active, {}).get("state") == "playing":
                self.items[self.active]["state"] = "interrupted"
            self.items[rid] = {"chunks": chunks, "state": "playing", "created": time.time(), "next": 0}
            self.active = rid
            while len(self.items) > 20:
                self.items.pop(next(iter(self.items)))
            return True

    def state(self, rid: str) -> str:
        return self.items.get(rid, {}).get("state", "unknown")

    def alive(self, rid: str) -> bool:
        return self.state(rid) == "playing"

    def pause(self, rid: str) -> bool:
        return self._set(rid, "paused", {"playing"})

    def resume(self, rid: str) -> bool:
        return self._set(rid, "playing", {"paused"})

    def stop(self, rid: str | None = None) -> bool:
        return self._set(rid or self.active or "", "stopped", {"playing", "paused"})

    def finish(self, rid: str):
        self._set(rid, "done", {"playing"})

    def _set(self, rid: str, new: str, frm: set) -> bool:
        with self._lock:
            it = self.items.get(rid)
            if it and it["state"] in frm:
                it["state"] = new
                return True
            return False


QUEUE = SpeechQueue()
