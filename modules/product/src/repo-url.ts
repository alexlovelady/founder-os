/** Strict parsing of repository URLs. Only GitHub and GitLab.com are supported; nothing else is ever fetched. */

export type Provider = "github" | "gitlab";

export interface RepoRef {
  provider: Provider;
  /** GitHub owner, or the GitLab group path (may contain subgroups, e.g. "group/sub"). */
  owner: string;
  name: string;
  /** Canonical https URL, e.g. https://github.com/octocat/Hello-World */
  url: string;
}

const HOSTS: Record<string, Provider> = { "github.com": "github", "www.github.com": "github", "gitlab.com": "gitlab", "www.gitlab.com": "gitlab" };
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

export class RepoUrlError extends Error {}

export function parseRepoUrl(input: string): RepoRef {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 300) throw new RepoUrlError("Enter the address of a GitHub or GitLab repository");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RepoUrlError("That is not a valid web address");
  }
  if (u.protocol !== "https:") throw new RepoUrlError("Only https:// addresses are supported");
  if (u.username || u.password || u.port) throw new RepoUrlError("The address must not contain credentials or a port");
  const provider = HOSTS[u.hostname.toLowerCase()];
  if (!provider) throw new RepoUrlError("Only github.com and gitlab.com repositories are supported");
  let parts = u.pathname.split("/").filter(Boolean);
  // Allow pasting a browser URL such as /tree/main/src or /-/tree/main.
  if (provider === "gitlab") {
    const dash = parts.indexOf("-");
    if (dash >= 0) parts = parts.slice(0, dash);
  } else {
    parts = parts.slice(0, 2);
  }
  if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, "");
  const min = 2;
  if (parts.length < min) throw new RepoUrlError(provider === "github" ? "Use the form https://github.com/<owner>/<repo>" : "Use the form https://gitlab.com/<group>/<project>");
  if (parts.length > 6) throw new RepoUrlError("That path is too deep");
  for (const p of parts) {
    if (!SEGMENT.test(p) || p === "." || p === ".." || p.startsWith(".")) throw new RepoUrlError("The repository path contains characters that are not allowed");
  }
  const name = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join("/");
  return { provider, owner, name, url: `https://${provider === "github" ? "github.com" : "gitlab.com"}/${owner}/${name}` };
}
