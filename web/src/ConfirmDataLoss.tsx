import { lazy, Suspense, useEffect, useState } from 'react';

/**
 * The one confirm on the web, and only for data loss: an act that destroys
 * content and cannot be undone (docs/DESIGN.md). Closing an issue,
 * archiving, signing a device out and revoking access do not ask.
 *
 * `confirmDataLoss()` is a plain function, like `toast()`: a handler awaits it
 * without threading a prop. `<ConfirmHost />` is mounted once, at the app
 * root, and loads the dialog with the first ask.
 *
 * The wording pattern: the title asks the act with its object ("Delete
 * “Q3 plan”?"); the body says what is lost, then "This can’t be undone.";
 * the action repeats the verb.
 */
export interface DataLossAsk {
  title: string;
  body: string;
  action: string;
}

interface Pending extends DataLossAsk {
  resolve: (confirmed: boolean) => void;
}

const ConfirmDialog = lazy(() => import('./ConfirmDialog'));

let show: ((ask: Pending) => void) | null = null;

export function confirmDataLoss(ask: DataLossAsk): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) {
      resolve(false);
      return;
    }
    show({ ...ask, resolve });
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    show = (ask) => setPending((current) => {
      current?.resolve(false);
      return ask;
    });
    return () => { show = null; };
  }, []);
  if (!pending) return null;
  const answer = (confirmed: boolean) => {
    pending.resolve(confirmed);
    setPending(null);
  };
  return (
    <Suspense fallback={null}>
      <ConfirmDialog ask={pending} onAnswer={answer} />
    </Suspense>
  );
}
