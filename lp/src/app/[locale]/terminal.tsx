"use client";

import { useEffect, useRef, useState } from "react";

type TerminalProps = {
  /** Shown after a `$` prompt above the output, when given. */
  command?: string;
  lines: string[];
  label: string;
};

/// A terminal window, drawn as text rather than a screenshot so it stays sharp and
/// selectable. Report lines are wider than the column on most screens: it scrolls
/// sideways, and fades the edge that has more to show.
export function Terminal({ command, lines, label }: TerminalProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      setEdges({ left: element.scrollLeft > 1, right: element.scrollLeft < max - 1 });
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const mask = `linear-gradient(to right, ${edges.left ? "transparent" : "black"}, black 32px, black calc(100% - 32px), ${edges.right ? "transparent" : "black"})`;

  return (
    <figure
      aria-label={label}
      className="w-full min-w-0 overflow-hidden rounded-lg bg-terminal shadow-shot"
    >
      <pre
        className="no-scrollbar overflow-x-auto px-4 py-3 font-mono text-console text-terminal-ink leading-normal"
        ref={ref}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        <code>
          {command && (
            <span className="block">
              <span className="select-none text-terminal-muted">$ </span>
              {command}
            </span>
          )}
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed lines; blank ones repeat
            <span className="block min-h-line" key={index}>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
