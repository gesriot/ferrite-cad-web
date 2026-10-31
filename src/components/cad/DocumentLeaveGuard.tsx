import { useEffect } from "react";
import { useCad } from "@/lib/cad/store";

/**
 * The part editor unmounts when the user opens another route, so a listener
 * that lives on that view is gone while the document is still dirty.
 * This guard stays mounted for the whole application. A clean or closed
 * document does not warn. Moving between Ferrite and Assemblies keeps the
 * same in-memory part; reload, close, and leaving the site still ask.
 */
export function DocumentLeaveGuard() {
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!useCad.getState().exchange?.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);
  return null;
}
