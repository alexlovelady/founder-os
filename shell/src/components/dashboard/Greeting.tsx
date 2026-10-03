"use client";
import { useSyncExternalStore } from "react";
import { greeting } from "@/lib/dashboard/logic";

const subscribe = () => () => undefined;
const hourNow = () => new Date().getHours();
const hourServer = () => -1;

/** Greets by the viewer's local time of day (the server clock is not their clock); renders "Welcome back" until the browser takes over. */
export default function Greeting({ name }: { name: string }) {
  const hour = useSyncExternalStore(subscribe, hourNow, hourServer);
  const text = hour < 0 ? (name ? `Welcome back, ${name}` : "Welcome back") : greeting(hour, name);
  return <h1 className="text-2xl font-semibold">{text}</h1>;
}
