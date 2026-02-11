import { useEffect } from "react";

type MetaState = {
  element: HTMLMetaElement;
  existed: boolean;
  previousContent: string | null;
};

const ensureMeta = (name: string) => {
  const selector = `meta[name="${name}"]`;
  const existing = document.querySelector(selector);
  if (existing && existing instanceof HTMLMetaElement) {
    return { element: existing, existed: true };
  }
  const created = document.createElement("meta");
  created.setAttribute("name", name);
  created.dataset.shareMeta = "true";
  document.head.appendChild(created);
  return { element: created, existed: false };
};

export function useSharePageMeta() {
  useEffect(() => {
    const updates: Array<{ state: MetaState; content: string }> = [];

    const install = (name: string, content: string) => {
      const { element, existed } = ensureMeta(name);
      const previousContent = element.getAttribute("content");
      element.setAttribute("content", content);
      updates.push({ state: { element, existed, previousContent }, content });
    };

    // Share links are bearer credentials and should not be indexed.
    install("robots", "noindex,nofollow");
    // Reduce chance of leaking the share URL to cross-origin resources.
    install("referrer", "no-referrer");

    return () => {
      updates.forEach(({ state }) => {
        if (!state.existed && state.element.dataset.shareMeta === "true") {
          state.element.remove();
          return;
        }
        if (state.previousContent === null) {
          state.element.removeAttribute("content");
          return;
        }
        state.element.setAttribute("content", state.previousContent);
      });
    };
  }, []);
}
