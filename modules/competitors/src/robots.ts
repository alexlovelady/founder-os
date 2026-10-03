/** Minimal robots.txt parser (RFC 9309 semantics: longest matching rule wins, Allow wins ties, `*` and `$` supported). */

interface Group { agents: string[]; rules: { allow: boolean; pattern: string }[] }

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (value) cur.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** May `agent` (our product token, e.g. "FounderOS-Research") fetch this path (with query string)? */
export function robotsAllows(text: string, agent: string, pathAndQuery: string): boolean {
  const groups = parseRobots(text);
  const me = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && me.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
      const len = r.pattern.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}
