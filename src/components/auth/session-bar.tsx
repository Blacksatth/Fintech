"use client";

import { useEffect, useState } from "react";
import { signOut } from "firebase/auth";
import { Button, LinkButton, useToast } from "@/components/ui";
import { getFirebaseWebAuth } from "@/lib/firebase-web";

interface SessionInfo {
  uid: string;
  email: string | null;
}

export function SessionBar() {
  const { toast } = useToast();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<SessionInfo>) : null))
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOutEverywhere() {
    setPending(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout-fallido");
      await signOut(getFirebaseWebAuth());
      setSession(null);
      toast("success", "Sesión cerrada");
    } catch {
      toast("danger", "No pudimos cerrar tu sesión", "Intenta de nuevo en un momento.");
    } finally {
      setPending(false);
    }
  }

  if (!ready) return null;
  if (!session) return <LinkButton href="/login" size="sm">Ingresar</LinkButton>;

  return (
    <div className="flex items-center gap-3">
      <span className="hidden max-w-40 truncate text-sm text-ink-muted sm:inline">
        {session.email ?? session.uid}
      </span>
      <Button variant="secondary" size="sm" loading={pending} onClick={signOutEverywhere}>
        Cerrar sesión
      </Button>
    </div>
  );
}
