'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionError } from '@/components/admin/ActionError';
import { finishCorsProbe, startCorsProbe } from '@/app/actions/diagnostics';
import type { AdminState } from '@/app/actions/admin';

const IDLE: AdminState = { ok: false };

/**
 * Does a browser upload to R2 actually work?
 *
 * The server cannot answer this. It tried: a server-to-server OPTIONS with an
 * `Origin` header, which is a reasonable idea and which came back `fetch
 * failed` — and `fetch failed` there means the PROBE could not run, not that
 * the bucket refuses anything. That distinction cost a round of blaming a
 * bucket policy that was correct all along, so the page no longer pretends
 * otherwise: the row goes grey, and this button does the real thing instead.
 *
 * Eight bytes, a presigned PUT, `XMLHttpRequest` — the identical call path a
 * slide or a two-gigabyte video takes. If these bytes land, those do too. The
 * server then confirms the object existed and deletes it, so a green tick means
 * the whole round trip happened rather than that a header looked plausible.
 */
export function R2BrowserCheck() {
  const t = useTranslations('admin');
  const [state, setState] = useState<AdminState>(IDLE);
  /** The GET half: can the room read a slide back under CORS, for the recording? */
  const [read, setRead] = useState<'ok' | 'blocked' | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setState(IDLE);
    setRead(null);
    try {
      const ticket = await startCorsProbe();
      if (!ticket.ok || !ticket.url || !ticket.key) {
        setState(ticket);
        return;
      }

      const status = await new Promise<number>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', ticket.url!);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.onload = () => resolve(xhr.status);
        // Zero is the browser's way of saying "blocked before a response
        // existed" — a CORS refusal, or no network. It is not a status R2 can
        // return, which is exactly why it is worth reporting as itself.
        xhr.onerror = () => resolve(0);
        xhr.ontimeout = () => resolve(0);
        xhr.send(new Uint8Array([82, 50, 45, 67, 79, 82, 83, 10]));
      });

      if (status === 0) {
        setState({
          ok: false,
          error: 'uploadFailed',
          // The origin is the string the bucket's AllowedOrigins must contain.
          // Without it the message asks the office to guess which of the site's
          // addresses the browser actually sent.
          detail: `${t('diagBrowserBlocked')} (origine ${window.location.origin})`,
        });
        return;
      }
      if (status < 200 || status >= 300) {
        setState({
          ok: false,
          error: 'uploadFailed',
          detail: t('diagBrowserStatus', { status }),
        });
        return;
      }

      // The same read the classroom makes for each slide (crossOrigin
      // "anonymous"): a TypeError here is the browser refusing it under CORS,
      // which is exactly what keeps slides out of the recording.
      if (ticket.readUrl) {
        try {
          const response = await fetch(ticket.readUrl, { mode: 'cors', cache: 'no-store' });
          setRead(response.ok ? 'ok' : 'blocked');
        } catch {
          setRead('blocked');
        }
      }

      setState(await finishCorsProbe({ key: ticket.key }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-[var(--radius-card)] border border-line bg-white p-4">
      <p className="text-[13px] font-medium text-ink">{t('diagBrowserTest')}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{t('diagBrowserTestLead')}</p>

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={busy}
        onClick={() => void run()}
      >
        <Upload className="size-3.5" aria-hidden="true" />
        {busy ? t('diagBrowserTesting') : t('diagBrowserTest')}
      </Button>

      <ActionError state={state} />
      {read === 'ok' && (
        <p role="status" className="mt-2 flex items-start gap-2 text-[12px] text-brand-700">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('diagBrowserReadOk')}</span>
        </p>
      )}
      {read === 'blocked' && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-red-700">
          {t('diagBrowserReadBlocked', { origin: window.location.origin })}
        </p>
      )}
      {state.ok && (
        <p role="status" className="mt-2 flex items-start gap-2 text-[12px] text-brand-700">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('diagBrowserOk')}
            {state.detail && <span className="text-ink-muted"> — {state.detail}</span>}
          </span>
        </p>
      )}
    </div>
  );
}
