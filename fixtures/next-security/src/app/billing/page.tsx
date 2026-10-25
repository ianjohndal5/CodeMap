import { InvoiceNote } from '../../components/InvoiceNote';

const serializeJsonLd = (data: object) => JSON.stringify(data).replace(/</g, '\\u003c');

export default async function BillingPage() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/billing/search?number=42`);
  const invoices = await res.json();

  return (
    <main>
      <InvoiceNote html={invoices[0]?.note ?? ''} />
      {/* not flagged: JSON-LD built with JSON.stringify */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ '@type': 'Invoice' }) }} />
      {/* not flagged: a JSON-LD serializer */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd({ '@type': 'WebPage' }) }} />
    </main>
  );
}
