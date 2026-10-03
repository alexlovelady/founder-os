"use client";
import { useRouter } from "next/navigation";
import { legalAuth } from "@/lib/auth/legalai";

export default function SignOut() {
  const router = useRouter();
  return (
    <button
      className="text-left text-xs text-slate-400 underline"
      onClick={async () => {
        await legalAuth.logout();
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
