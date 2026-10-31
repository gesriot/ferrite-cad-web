import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CadApp } from "@/components/cad/CadApp";

export const Route = createFileRoute("/")({
  ssr: false,
  component: Home,
});

function Home() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) {
    return (
      <main className="grid h-svh place-items-center bg-bg font-sans text-muted">
        Ferrite CAD
      </main>
    );
  }
  return <CadApp />;
}
