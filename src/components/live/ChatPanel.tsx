'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeLocale } from '@/i18n/routing';
import type { ChatLine } from './useRoom';

/**
 * The class chat.
 *
 * Every line is rendered as text, never as markup. A student typing a script
 * tag types a script tag and everyone reads it — React escapes it by default
 * and nothing here reaches for `dangerouslySetInnerHTML`, which is the whole
 * of the defence and the reason not to get clever with formatting.
 *
 * Closed by the teacher, the composer goes away rather than failing on send.
 */
export function ChatPanel({
  lines,
  canWrite,
  closedReason,
  onSend,
}: {
  lines: ChatLine[];
  canWrite: boolean;
  closedReason: 'closed' | 'muted' | null;
  onSend: (body: string) => void;
}) {
  const t = useTranslations('live');
  // `undefined` would read the browser's language, not the page's: an English
  // browser on the French room would print 12-hour times under a French
  // heading. The times themselves are the reader's own clock.
  const timeFmt = new Intl.DateTimeFormat(safeLocale(useLocale()), {
    hour: '2-digit',
    minute: '2-digit',
  });
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {lines.length === 0 && (
          <li className="py-8 text-center text-[12px] text-white/40">{t('chatEmpty')}</li>
        )}
        {lines.map((line) => (
          <li key={line.id}>
            <p className="flex items-baseline gap-2">
              <span
                className={cn(
                  'text-[12px] font-semibold',
                  line.isHost ? 'text-brand-300' : 'text-white/70',
                )}
              >
                {line.name || '—'}
              </span>
              <time className="text-[10px] text-white/30">
                {timeFmt.format(new Date(line.at))}
              </time>
            </p>
            {/* Text, deliberately. Never markup. */}
            <p className="mt-0.5 text-[13px] leading-relaxed break-words text-white/90">
              {line.body}
            </p>
          </li>
        ))}
        <div ref={endRef} />
      </ol>

      {canWrite ? (
        <form
          className="flex items-center gap-2 border-t border-white/10 p-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            onSend(draft);
            setDraft('');
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            placeholder={t('chatPlaceholder')}
            aria-label={t('chatPlaceholder')}
            className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2 text-[13px] text-white placeholder:text-white/35 focus:bg-white/15 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            aria-label={t('chatSend')}
            className="rounded-full bg-brand-500 p-2 text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
          >
            <Send className="size-4" aria-hidden="true" />
          </button>
        </form>
      ) : (
        <p className="border-t border-white/10 p-3 text-center text-[12px] text-white/40">
          {closedReason === 'muted' ? t('chatMuted') : t('chatClosed')}
        </p>
      )}
    </div>
  );
}
