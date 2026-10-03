import { describe, expect, it } from "vitest";
import { FetchBlocked, isPublicIp, normalizeFetchUrl, parseIPv6, safeFetch, USER_AGENT } from "../src/safe-fetch";
import { robotsAllows } from "../src/robots";
import { fetchOnePage, researchSite } from "../src/research";
import { extractHtml, hashText, pickLinks } from "../src/html";
import { parseAnalysis } from "../src/ai";
import { gz, makeNet, PUBLIC_IP, redirect } from "./net-fake";

const blockedWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(FetchBlocked);
  expect((e as FetchBlocked).code).toBe(code);
};

describe("address classification", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1", "0.0.0.0", "100.64.0.1", "100.100.100.200",
    "192.0.0.1", "192.0.2.5", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:a9fe:a9fe", "fe80::1", "fe80::abcd%eth0", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:0a00:0001::", "2001:db8::1", "2001::1", "0:0:0:0:0:0:0:1", "100::1",
    "not-an-ip", "300.1.1.1", "1.2.3",
  ])("refuses %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });
  it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1"])("allows %s", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });
  it("parses IPv6 forms", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")?.length).toBe(8);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("zzzz::1")).toBeNull();
  });
});

describe("URL rules", () => {
  it("upgrades http to https and drops fragments", () => {
    expect(normalizeFetchUrl("http://Rival.io/Pricing#x").toString()).toBe("https://rival.io/Pricing");
    expect(normalizeFetchUrl("http://rival.io:80/").toString()).toBe("https://rival.io/");
  });
  it.each(["ftp://rival.io/", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@rival.io/", "https://rival.io:8443/", "http://rival.io:8080/", "https://localhost/", "https://app.localhost/", "https://printer.local/", "https://db.internal/", "https://intranet/", "https://metadata/", "not a url", ""])("rejects %s", (u) => {
    expect(() => normalizeFetchUrl(u)).toThrow(FetchBlocked);
  });
});

describe("safeFetch: SSRF protection", () => {
  const ok = (body = "<html><title>t</title><body>hello</body></html>") => ({ body });

  it.each([
    "https://127.0.0.1/", "http://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://2130706433/", "https://0x7f.0.0.1/",
    "https://0177.0.0.1/", "https://[fd00::1]/", "https://[fe80::1]/", "https://10.0.0.5/", "https://192.168.0.1/admin", "https://172.16.5.5/", "https://[::]/", "https://100.100.100.200/", "https://[2002:7f00:1::]/", "https://0.0.0.0/",
  ])("never connects to %s", async (u) => {
    const { net, calls } = makeNet(() => ok());
    await blockedWith(safeFetch(u, net), "private");
    expect(calls.length).toBe(0);
  });

  it("refuses names that resolve to private addresses, including when only one answer is private", async () => {
    for (const answers of [["10.0.0.5"], ["127.0.0.1"], ["::1"], ["fe80::1"], ["169.254.169.254"], [PUBLIC_IP, "192.168.1.10"], ["::ffff:10.0.0.1"]]) {
      const { net, calls } = makeNet(() => ok(), { "evil.example.org": answers });
      await blockedWith(safeFetch("https://evil.example.org/", net), "private");
      expect(calls.length).toBe(0);
    }
  });

  it("reports unresolvable hosts without connecting", async () => {
    const { net, calls } = makeNet(() => ok());
    await blockedWith(safeFetch("https://nxdomain.invalid-host.com/", net), "dns");
    expect(calls.length).toBe(0);
  });

  it("connects to the exact address it checked and identifies itself", async () => {
    const { net, calls } = makeNet(() => ok(), { "rival.io": ["93.184.216.35"] });
    const r = await safeFetch("https://rival.io/", net);
    expect(r.status).toBe(200);
    expect(calls[0].address).toBe("93.184.216.35");
    expect(calls[0].headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^FounderOS-Research\/1\.0/);
  });

  it("DNS rebinding style: a public page redirecting to a host that resolves privately is refused on that hop", async () => {
    const { net, calls } = makeNet((u) => (u.hostname === "rival.io" ? redirect("https://rebind.example.org/x") : ok()), { "rebind.example.org": ["10.0.0.5"] });
    await blockedWith(safeFetch("https://rival.io/", net), "private");
    expect(calls.map((c) => c.host)).toEqual(["rival.io"]);
  });

  it("refuses redirects to literal private and metadata addresses and non-https schemes", async () => {
    for (const to of ["https://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/", "https://[::1]/", "file:///etc/passwd", "ftp://rival.io/x", "https://localhost/", "https://rival.io:9999/"]) {
      const { net, calls } = makeNet((u) => (u.hostname === "rival.io" && u.port === "" && u.pathname === "/" ? redirect(to) : ok()));
      const e = await safeFetch("https://rival.io/", net).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(FetchBlocked);
      expect(calls.length).toBe(1);
    }
  });

  it("upgrades an http redirect to https instead of fetching in the clear", async () => {
    const { net, calls } = makeNet((u) => (u.pathname === "/" ? redirect("http://rival.io/home") : ok()));
    const r = await safeFetch("https://rival.io/", net);
    expect(r.finalUrl).toBe("https://rival.io/home");
    expect(calls.every((c) => c.url.startsWith("https://"))).toBe(true);
  });

  it("follows up to 3 redirects and no more", async () => {
    const chain = (n: number) => makeNet((u) => { const i = Number(u.pathname.slice(1) || 0); return i < n ? redirect(`/${i + 1}`) : ok(); });
    const three = chain(3);
    expect((await safeFetch("https://rival.io/", three.net)).redirects).toBe(3);
    const four = chain(4);
    await blockedWith(safeFetch("https://rival.io/", four.net), "redirects");
    expect(four.calls.length).toBe(4);
    const loop = makeNet(() => redirect("/"));
    await blockedWith(safeFetch("https://rival.io/", loop.net), "redirects");
  });

  it("caps response size by header, by streaming, and for decompressed bodies", async () => {
    await blockedWith(safeFetch("https://rival.io/", makeNet(() => ({ body: "x", headers: { "content-length": "9999999" } })).net), "size");
    await blockedWith(safeFetch("https://rival.io/", makeNet(() => ({ bytes: 1_600_000 })).net), "size");
    const exactly = await safeFetch("https://rival.io/", makeNet(() => ({ bytes: 1_500_000 })).net);
    expect(exactly.text.length).toBe(1_500_000);
    await blockedWith(safeFetch("https://rival.io/", makeNet(() => gz(Buffer.alloc(5_000_000, "a"))).net), "size"); // decompression bomb
    expect((await safeFetch("https://rival.io/", makeNet(() => gz("<html>small</html>")).net)).text).toBe("<html>small</html>");
  });

  it("stops reading a streamed body once the cap is hit", async () => {
    const { net } = makeNet(() => ({ bytes: 10_000_000 }));
    const t = Date.now();
    await blockedWith(safeFetch("https://rival.io/", net), "size");
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("only accepts HTML and plain text", async () => {
    for (const type of ["application/pdf", "application/json", "image/png", "application/octet-stream", "application/javascript", "video/mp4", null]) {
      await blockedWith(safeFetch("https://rival.io/", makeNet(() => ({ type, body: "data" })).net), "type");
    }
    expect((await safeFetch("https://rival.io/", makeNet(() => ({ type: "text/plain", body: "hello" })).net)).text).toBe("hello");
    expect((await safeFetch("https://rival.io/", makeNet(() => ({ type: "TEXT/HTML; charset=iso-8859-1", body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) })).net)).text).toBe("café");
  });

  it("times out slow servers", async () => {
    const { net } = makeNet(() => ({ hang: true }));
    await blockedWith(safeFetch("https://rival.io/", net, { timeoutMs: 60 }), "timeout");
  });

  it("returns non-2xx statuses without reading a body", async () => {
    const r = await safeFetch("https://rival.io/", makeNet(() => ({ status: 503, body: "oops" })).net);
    expect(r).toMatchObject({ status: 503, text: "" });
  });

  it("lets a caller veto each hop (used for robots.txt)", async () => {
    const seen: string[] = [];
    const { net, calls } = makeNet((u) => (u.pathname === "/" ? redirect("https://other.example.net/p") : { body: "x" }));
    await blockedWith(safeFetch("https://rival.io/", net, { beforeRequest: async (u) => { seen.push(u.hostname); if (u.hostname === "other.example.net") throw new FetchBlocked("robots", "no"); } }), "robots");
    expect(seen).toEqual(["rival.io", "other.example.net"]);
    expect(calls.length).toBe(1);
  });
});

describe("robots.txt", () => {
  const txt = "User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\n\nUser-agent: FounderOS-Research\nDisallow: /pricing\n";
  it("uses our own group when present and ignores the wildcard group then", () => {
    expect(robotsAllows(txt, "FounderOS-Research", "/pricing")).toBe(false);
    expect(robotsAllows(txt, "FounderOS-Research", "/private/x")).toBe(true); // our group has no rule for it
    expect(robotsAllows(txt, "FounderOS-Research", "/")).toBe(true);
  });
  it("applies wildcard rules, longest match wins, allow wins ties, and $ anchors", () => {
    const w = "User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nDisallow: /tie\nAllow: /tie\n";
    expect(robotsAllows(w, "FounderOS-Research", "/private/x")).toBe(false);
    expect(robotsAllows(w, "FounderOS-Research", "/private/public/a")).toBe(true);
    expect(robotsAllows(w, "FounderOS-Research", "/files/a.pdf")).toBe(false);
    expect(robotsAllows(w, "FounderOS-Research", "/files/a.pdf?x=1")).toBe(true);
    expect(robotsAllows(w, "FounderOS-Research", "/tie")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "FounderOS-Research", "/anything")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow:", "FounderOS-Research", "/anything")).toBe(true);
    expect(robotsAllows("", "FounderOS-Research", "/")).toBe(true);
  });
});

describe("research flow", () => {
  const home = `<html><head><title>Rival &amp; Co - Salon software</title><meta name="description" content="Scheduling for salons"><style>.x{}</style><script>var SECRET_SCRIPT=1</script></head>
    <body><nav><a href="/pricing">Pricing</a> <a href="/about-us">About</a> <a href="/login">Log in</a> <a href="https://other-site.com/pricing">Elsewhere</a><a href="/features/booking">Features</a><a href="/blog/post">Blog</a><a href="/files/deck.pdf">Deck</a></nav>
    <h1>Salon scheduling made simple</h1><p>Book&nbsp;faster. Fewer no-shows.</p><footer>Cookie banner junk</footer></body></html>`;
  const site = (u: URL) => {
    switch (u.pathname) {
      case "/robots.txt": return { type: "text/plain", body: "User-agent: *\nDisallow: /about-us\n" };
      case "/": return { body: home };
      case "/pricing": return { body: "<html><title>Pricing</title><body><h1>Pricing</h1><p>Starter $29 per month</p></body></html>" };
      case "/features/booking": return { body: "<html><body><p>Online booking</p></body></html>" };
      default: return undefined;
    }
  };

  it("strips boilerplate, decodes entities and extracts links", () => {
    const ex = extractHtml(home, "https://rival.io/");
    expect(ex.title).toBe("Rival & Co - Salon software");
    expect(ex.description).toBe("Scheduling for salons");
    expect(ex.text).toContain("Salon scheduling made simple");
    expect(ex.text).toContain("Book faster. Fewer no-shows.");
    expect(ex.text).not.toMatch(/SECRET_SCRIPT|Cookie banner|Pricing/);
    expect(ex.links.map((l) => l.text)).toContain("Pricing");
  });

  it("picks only pricing/product/about links on the same site", () => {
    const links = extractHtml(home, "https://rival.io/").links;
    expect(pickLinks(links, "https://rival.io/", 5)).toEqual(["https://rival.io/pricing", "https://rival.io/features/booking", "https://rival.io/about-us"]);
    expect(pickLinks(links, "https://rival.io/", 1)).toEqual(["https://rival.io/pricing"]);
  });

  it("reads the home page and the useful pages, and skips what robots.txt disallows (telling the user)", async () => {
    const { net, calls } = makeNet(site);
    const pages = await researchSite("https://rival.io/", [], net);
    expect(pages.map((p) => [new URL(p.url).pathname, p.status])).toEqual([["/", "ok"], ["/pricing", "ok"], ["/features/booking", "ok"], ["/about-us", "blocked_robots"]]);
    expect(pages.find((p) => p.status === "blocked_robots")!.error).toMatch(/robots\.txt/);
    expect(calls.some((c) => c.path === "/about-us")).toBe(false);
    expect(calls.filter((c) => c.path === "/robots.txt").length).toBe(1);
    expect(pages[1].text).toContain("Starter $29 per month");
    expect(pages[1].hash).toBe(hashText(pages[1].text));
  });

  it("limits to 6 pages and only same-site user pages", async () => {
    const many = "<html><body>" + Array.from({ length: 12 }, (_, i) => `<a href="/pricing/p${i}">Pricing ${i}</a>`).join("") + "</body></html>";
    const { net, calls } = makeNet((u) => (u.pathname === "/robots.txt" ? { status: 404 } : { body: many }));
    const pages = await researchSite("https://rival.io/", ["https://rival.io/extra", "https://evil.com/x"], net);
    expect(pages.length).toBe(6);
    expect(pages[1].userAdded).toBe(true);
    expect(calls.some((c) => c.host === "evil.com")).toBe(false);
  });

  it("treats a missing robots.txt as allowed, an HTML 'not found' robots page as allowed, and a failing robots.txt as do-not-crawl", async () => {
    const mk = (robots: { status?: number; type?: string; body?: string }) => makeNet((u) => (u.pathname === "/robots.txt" ? { type: "text/plain", ...robots } : { body: "<html><body>hi</body></html>" }));
    expect((await researchSite("https://rival.io/", [], mk({ status: 404 }).net))[0].status).toBe("ok");
    expect((await researchSite("https://rival.io/", [], mk({ type: "text/html", body: "<html>Not found</html>" }).net))[0].status).toBe("ok");
    const down = await researchSite("https://rival.io/", [], mk({ status: 503 }).net);
    expect(down[0].status).toBe("blocked_robots");
    const all = await researchSite("https://rival.io/", [], mk({ body: "User-agent: *\nDisallow: /" }).net);
    expect(all[0].status).toBe("blocked_robots");
    expect(all.length).toBe(1);
    const specific = await researchSite("https://rival.io/", [], mk({ body: "User-agent: FounderOS-Research\nDisallow: /" }).net);
    expect(specific[0].status).toBe("blocked_robots");
  });

  it("applies robots.txt of the host a redirect leads to", async () => {
    const { net, calls } = makeNet((u) => {
      if (u.hostname === "rival.io" && u.pathname === "/") return redirect("https://www.rival.io/");
      if (u.pathname === "/robots.txt") return { type: "text/plain", body: u.hostname === "www.rival.io" ? "User-agent: *\nDisallow: /" : "" };
      return { body: "<html>x</html>" };
    });
    const pages = await researchSite("https://rival.io/", [], net);
    expect(pages[0].status).toBe("blocked_robots");
    expect(calls.some((c) => c.host === "www.rival.io" && c.path === "/")).toBe(false);
  });

  it("reports SSRF refusals and HTTP errors per page, never throws for them", async () => {
    const r1 = await fetchOnePage("https://rival.io/", makeNet(() => redirect("https://169.254.169.254/")).net, async () => undefined, false, () => new Date());
    expect(r1.page).toMatchObject({ status: "error" });
    expect(r1.page.error).toMatch(/private or internal/);
    const r2 = await fetchOnePage("https://rival.io/", makeNet(() => ({ status: 404 })).net, async () => undefined, false, () => new Date());
    expect(r2.page.error).toMatch(/404/);
    const r3 = await fetchOnePage("https://rival.io/", makeNet(() => ({ type: "application/pdf", body: "%PDF" })).net, async () => undefined, false, () => new Date());
    expect(r3.page.error).toMatch(/Not a web page/);
  });
});

describe("analysis honesty (parseAnalysis)", () => {
  const pages = [{ url: "https://rival.io/pricing", fetchedAt: "2026-10-01T10:00:00.000Z", text: "Pricing\nStarter $29 per month\nPro plan 79 dollars" }, { url: "https://rival.io/", fetchedAt: "2026-10-01T10:01:00.000Z", text: "Salon scheduling made simple" }];
  const reply = JSON.stringify({
    positioning: [{ claim: "Simple salon scheduling", source_url: "https://rival.io/", quote: "Salon scheduling made simple" }, { claim: "Market leader in Europe", source_url: "https://news.example.com/x" }],
    pricing: [
      { claim: "Starter costs $29/month", source_url: "https://rival.io/pricing", quote: "starter $29 per month" },
      { claim: "Enterprise costs $999", source_url: "https://rival.io/pricing", quote: "Enterprise $999 per month" },
      { claim: "Free plan exists", source_url: "https://rival.io/pricing" },
      { claim: "Costs $5", source_url: "https://invented.example.com/", quote: "$5" },
    ],
    strengths: ["Easy to use"],
    comparison_with_us: "They are broader than you.",
  });
  it("takes fetched_at from our records, verifies quotes, and rejects unverifiable prices", () => {
    const p = parseAnalysis("```json\n" + reply + "\n```", pages);
    expect(p.parsed).toBe(true);
    const pos = p.claims.filter((c) => c.field === "positioning");
    expect(pos[0]).toMatchObject({ source_url: "https://rival.io/", fetched_at: "2026-10-01T10:01:00.000Z", quote_verified: true });
    expect(pos[1]).toMatchObject({ source_url: null, fetched_at: null }); // cited a page we never fetched
    const pricing = p.claims.filter((c) => c.field === "pricing");
    expect(pricing.map((c) => c.text)).toEqual(["Starter costs $29/month"]);
    expect(p.rejected.map((r) => r.text)).toEqual(["Enterprise costs $999", "Free plan exists", "Costs $5"]);
    expect(p.claims.find((c) => c.field === "strengths")).toMatchObject({ text: "Easy to use", source_url: null });
    expect(p.comparison).toBe("They are broader than you.");
  });
  it("does not pretend free text is sourced", () => {
    expect(parseAnalysis("Sure! Here is my analysis: they are great.", pages)).toMatchObject({ parsed: false, claims: [] });
    expect(parseAnalysis("{ broken json", pages).parsed).toBe(false);
  });
});
