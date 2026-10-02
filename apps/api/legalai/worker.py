import asyncio
import logging
import threading

from .config import get_settings
from .jobs.runner import mark_stale_nodes, process_one


async def main(stop: "threading.Event | None" = None) -> None:
    s = get_settings()
    while not (stop and stop.is_set()):
        try:
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
