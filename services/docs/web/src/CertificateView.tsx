import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { api } from './api';
import { ErrorNotice } from './ErrorNotice';
import { renderMarkdown } from './markdown';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';

/** The audit certificate, rendered for reading and printing. */
export function CertificateView({ requestId }: { requestId: string }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .certificate(requestId)
      .then(setMarkdown)
      .catch((cause: Error) => setError(cause.message));
  }, [requestId]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <Card className="w-full max-w-[440px] shadow-(--shadow-raised)">
          <CardContent>
            <ErrorNotice message={error} />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Printed evidence is black on white, whatever the screen is doing.
  return (
    <div className="mx-auto max-w-[820px] px-8 pt-10 pb-20 max-sm:px-4 print:bg-white print:text-black">
      <div className="mb-4 flex justify-end print:hidden">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          Print or save as PDF
        </Button>
      </div>
      <article className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown ?? 'Loading…') }} />
    </div>
  );
}
