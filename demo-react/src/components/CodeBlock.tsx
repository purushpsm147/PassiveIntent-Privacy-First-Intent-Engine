import React from 'react';

interface Props {
  label: string;
  /** Pass pre-highlighted HTML via dangerouslySetInnerHTML, or use children */
  code: string;
}

/**
 * Renders a syntax-highlighted code block using lightweight CSS classes.
 * No external parser needed — the template strings are already tagged with
 * span class names (kw, fn, str, num, cmt, type, prop) in each page.
 */
export default function CodeBlock({ label, code }: Props) {
  return (
    <div className="code-block">
      <div className="code-label">{label}</div>
      {/* eslint-disable-next-line react/no-danger */}
      <pre dangerouslySetInnerHTML={{ __html: code }} />
    </div>
  );
}
