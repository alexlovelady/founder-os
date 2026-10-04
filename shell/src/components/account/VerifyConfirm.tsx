"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cardCls, postJson, safeNext } from "./shared";

/** Confirms the address by POSTing the token once on load (a mail scanner that only fetches the page cannot use the link up). */
export default function VerifyConfirm({ token }: { token: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<{ kind: "working" } | { kind: "error"; text: string }>({ kind: "working" });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void postJson("/api/account/verify", { token }).then((r) => {
      if (r.ok) router.replace(safeNext(r.data.next, "/login?verified=1"));
      else setState({ kind: "error", text: String(r.data.error ?? "Could not confirm your email.") });
    });
  }, [token, router]);

  return (
    <div className={cardCls}>
      <h1 className="text-xl font-semibold">{state.kind === "working" ? "Confirming your email..." : "Could not confirm your email"}</h1>
      {state.kind === "error" && (
        <>
          <p role="alert" className="text-sm text-slate-300">{state.text}</p>
          <p className="text-sm"><Link href="/verify" className="underline">Send me a new link</Link> or <Link href="/login" className="underline">sign in</Link>.</p>
        </>
      )}
    </div>
  );
}
