import logging
import os

import uvicorn

from .app import create_app

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    # Bind to loopback only. Expose it to Railway through the tunnel (cloudflared), never by port-forwarding.
    uvicorn.run(create_app(), host=os.environ.get("GATEWAY_BIND", "127.0.0.1"),
                port=int(os.environ.get("GATEWAY_PORT", "8787")))
