"""Stdio bridge to Sibyl Memory.

Halflife is a Node service. Sibyl Memory is a Python library. This file is the
only place the two meet.

It is deliberately dumb: it does not know what a certification is, what
revocation means, or what any of halflife's rules are. It takes a named Sibyl
call plus arguments, makes that call, and hands back what came out. Every
decision about *what* to remember lives in src/lib/memory.js, so there is one
place to look for halflife's memory semantics and one place to look for the
transport.

Protocol: one JSON object per line on stdin, one JSON object per line on
stdout. Requests carry an id so replies can be matched to callers.

  -> {"id": 1, "op": "set_entity", "args": ["agent", "a.example", {...}]}
  <- {"id": 1, "ok": true, "result": {...}}
  <- {"id": 1, "ok": false, "error": "..."}

A bad call must never take the process down: one failed memory operation
should surface as an error to that one caller, not kill the memory layer for
everybody.
"""

import json
import os
import sys
import traceback

# Only these Sibyl calls are reachable from Node. An allow-list rather than
# getattr on anything, so a bug in the caller cannot reach into the client's
# internals or the filesystem.
ALLOWED = {
    "set_entity",
    "get_entity",
    "list_entities",
    "search_entities",
    "write_event",
    "read_events",
    "set_state",
    "get_state",
}


def main() -> None:
    db_path = os.environ.get("HALFLIFE_MEMORY_DB", "./halflife-memory.db")

    try:
        from sibyl_memory_client import MemoryClient
        from sibyl_memory_client.exceptions import NotFoundError

        memory = MemoryClient.local(db_path)
    except Exception as exc:  # noqa: BLE001 - report, never crash silently
        # Startup failure is reported on the same channel as everything else so
        # Node sees a real reason instead of an empty pipe.
        sys.stdout.write(
            json.dumps({"id": None, "ok": False, "error": f"memory unavailable: {exc}"})
            + "\n"
        )
        sys.stdout.flush()
        return

    sys.stdout.write(json.dumps({"id": None, "ok": True, "result": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            args = request.get("args") or []
            kwargs = request.get("kwargs") or {}

            if op not in ALLOWED:
                raise ValueError(f"operation not allowed: {op}")

            result = getattr(memory, op)(*args, **kwargs)
            reply = {"id": request_id, "ok": True, "result": result}
        except NotFoundError:
            # "I have never seen this agent" is an answer, not a failure. Sibyl
            # raises for a missing entity but returns None for missing state, so
            # the two are flattened here to one shape: a successful null.
            #
            # This distinction is the whole point. If a missing record reached
            # halflife as an error it would be indistinguishable from a broken
            # memory, and halflife would be unable to tell "this agent is new"
            # from "I cannot remember anything right now".
            reply = {"id": request_id, "ok": True, "result": None, "notFound": True}
        except Exception as exc:  # noqa: BLE001 - one bad call, one bad reply
            reply = {
                "id": request_id,
                "ok": False,
                "error": str(exc) or exc.__class__.__name__,
                "trace": traceback.format_exc(limit=3),
            }

        sys.stdout.write(json.dumps(reply, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
