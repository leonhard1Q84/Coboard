import 'katex/dist/katex.min.css';
import { useMemo } from 'react';
import { renderMath } from './math';

/** Rendered formula; falls back to the raw source if KaTeX cannot produce HTML. */
export function MathView({ source, inline = false, className = '' }: { source: string; inline?: boolean; className?: string }) {
  const html = useMemo(() => renderMath(source, !inline), [source, inline]);
  if (html === null) return <code className={className}>{source}</code>;
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
