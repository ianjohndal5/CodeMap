'use client';

import DOMPurify from 'dompurify';

export function InvoiceNote({ html }: { html: string }) {
  const clean = DOMPurify.sanitize(html);

  return (
    <>
      {/* flagged: raw HTML from the API */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {/* not flagged: sanitized, a literal, or literals joined with + */}
      <div dangerouslySetInnerHTML={{ __html: clean }} />
      <div dangerouslySetInnerHTML={{ __html: '<b>Paid</b>' }} />
      <script dangerouslySetInnerHTML={{ __html: '(function(){' + 'document.documentElement.dataset.ready="1"' + '})()' }} />
    </>
  );
}
