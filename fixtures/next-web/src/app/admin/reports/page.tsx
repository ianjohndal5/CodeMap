'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/axios';

export default function ReportsPage() {
  const [year, setYear] = useState<number | null>(null);
  const [report, setReport] = useState<unknown>(null);

  useEffect(() => {
    // Optional Laravel parameter {year?}: both branches match the same route.
    api.get(year ? `/api/v1/admin/reports/${year}` : '/api/v1/admin/reports').then((r) => setReport(r.data));
  }, [year]);

  const exportCsv = () => api({ url: '/api/v1/admin/reports/export', method: 'post' });

  return (
    <div>
      <button onClick={() => setYear(2024)}>2024</button>
      <button onClick={exportCsv}>Export</button>
      <pre>{JSON.stringify(report)}</pre>
    </div>
  );
}
