import asyncio
import logging
import threading
import time

from .config import get_settings
from .corpus.refresh import enqueue_due_refreshes
from .providers.pull_gpu import purge_stale_requests
from .jobs.runner import mark_stale_nodes, process_one


LAST_TICK = 0.0  # monotonic time of the last worker loop pass (read by /api/admin/health)


async def main(stop: "threading.Event | None" = None) -> None:
    s = get_settings()
    global LAST_TICK
    last_sched = 0.0
    while not (stop and stop.is_set()):
        LAST_TICK = time.monotonic()
        try:
            if time.monotonic() - last_sched > 300:  # scheduled corpus refresh check, every 5 minutes
                last_sched = time.monotonic()
                enqueue_due_refreshes(s)
                purge_stale_requests(s)
            mark_stale_nodes(s)
            worked = await process_one(s)
        except Exception:  # noqa: BLE001
            logging.getLogger("legalai.worker").exception("worker loop error")
            worked = False
        if not worked:
            await asyncio.sleep(2)


def start_in_thread() -> threading.Event:
    """Run the worker beside the API. Railway volumes attach to one service only, so the process that
    owns the document volume also runs the queue."""
    stop = threading.Event()
    threading.Thread(target=lambda: asyncio.run(main(stop)), daemon=True, name="job-worker").start()
    return stop


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
