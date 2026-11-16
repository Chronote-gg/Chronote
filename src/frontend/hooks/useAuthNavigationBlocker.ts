import { useEffect, useLayoutEffect, useState } from "react";
import { registerAuthNavigationBlocker } from "../services/authRecovery";

export function useAuthNavigationBlocker(
  blocked: boolean,
  active = true,
): void {
  useLayoutEffect(() => {
    if (active && blocked) return registerAuthNavigationBlocker();
  }, [blocked, active]);
}

export function useAuthModalDraft(opened: boolean, saving: boolean) {
  const [dirty, setDirty] = useState(false);
  useAuthNavigationBlocker(dirty || saving, opened);
  useEffect(() => {
    if (!opened) setDirty(false);
  }, [opened]);
  return { dirty, markDirty: () => setDirty(true) };
}
