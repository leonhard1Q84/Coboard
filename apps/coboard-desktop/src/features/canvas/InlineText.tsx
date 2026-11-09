import { useMemo } from 'react';
import { segmentInlineMath } from './math';
import { MathView } from './MathView';

/** Paragraph text with embedded formulas rendered inline. */
export function InlineText({ text }: { text: string }) {
  const segments = useMemo(() => segmentInlineMath(text), [text]);
  if (segments.every((s) => s.kind === 'text')) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) => (s.kind === 'math' ? <MathView key={i} source={s.value} inline className="inline-math" /> : <span key={i}>{s.value}</span>))}
    </>
  );
}
