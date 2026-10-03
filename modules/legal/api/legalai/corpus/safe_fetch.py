"""SSRF-safe HTTP fetching for source adapters. Library sources are configured by administrators, but a URL is still
untrusted input: only https, never private/loopback/link-local/reserved addresses (checked on every redirect hop),
bounded size and time."""
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

MAX_BYTES = 25 * 1024 * 1024
MAX_REDIRECTS = 3
UA = "LegalAI-corpus/1.0 (official-source refresh)"


class FetchBlocked(Exception):
    pass


@dataclass
class Fetched:
    status: int
    headers: dict
    content: bytes
    url: str


def _default_resolver(host: str) -> list[str]:
    return list({ai[4][0] for ai in socket.getaddrinfo(host, None)})


def check_url(url: str, resolver=_default_resolver) -> None:
    u = urlparse(url)
    if u.scheme != "https":
        raise FetchBlocked("Only https URLs are allowed")
    if not u.hostname or u.username or u.password:
        raise FetchBlocked("Invalid URL")
    try:
        ips = [ipaddress.ip_address(u.hostname)]
    except ValueError:
        try:
            ips = [ipaddress.ip_address(x) for x in resolver(u.hostname)]
        except OSError as e:
            raise FetchBlocked(f"Host could not be resolved: {u.hostname}") from e
    for ip in ips:
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
                or ip.is_unspecified or (ip.version == 6 and ip.ipv4_mapped and ip.ipv4_mapped.is_private)):
            raise FetchBlocked("URL resolves to a non-public address")


async def safe_get(url: str, headers: dict | None = None, *, timeout: float = 30, resolver=_default_resolver,
                   transport: httpx.AsyncBaseTransport | None = None, max_bytes: int = MAX_BYTES) -> Fetched:
    hdrs = {"User-Agent": UA, **(headers or {})}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport) as c:
        for _ in range(MAX_REDIRECTS + 1):
            check_url(url, resolver)
            async with c.stream("GET", url, headers=hdrs) as r:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    url = urljoin(url, r.headers["location"])
                    continue
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > max_bytes:
                        raise FetchBlocked("Response too large")
                return Fetched(r.status_code, dict(r.headers), bytes(buf), url)
    raise FetchBlocked("Too many redirects")
