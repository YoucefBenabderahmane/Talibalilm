'use server';

import { requireAdmin } from '@/lib/auth/guards';
import { corsProbeKey, CORS_PROBE_KEY_PATTERN, slideName } from '@/lib/storage/key';
import {
  deleteObject,
  r2Configured,
  readObjectHead,
  signDownload,
  signUpload,
} from '@/lib/storage/r2';
import { smtpCandidates, type SmtpCandidate } from '@/lib/email/send';
import type { AdminState } from '@/app/actions/admin';

/**
 * Two tests the office runs by hand, from the diagnostics page.
 *
 * Both exist for the same reason: a probe that could not complete was being
 * printed as a fault it never observed. The cure is not a better guess, it is
 * asking the question from somewhere that can actually answer it — the browser
 * for CORS, and every plausible mail host for SMTP.
 *
 * Admin only. Neither writes anything a student can reach, and neither ever
 * returns a credential.
 */

export interface CorsTicket extends AdminState {
  url?: string;
  key?: string;
  /** A signed GET for the same object: the read the class recorder needs. */
  readUrl?: string;
}

/**
 * Presign a PUT for eight bytes the browser is about to send.
 *
 * The server cannot settle whether a browser upload is allowed — it is not a
 * browser, and R2's answer to a server-to-server OPTIONS travels a different
 * path. So the browser does the real thing: same presigned PUT, same
 * `XMLHttpRequest`, same headers as a video upload. If those eight bytes land,
 * a two-gigabyte video lands too.
 */
export async function startCorsProbe(): Promise<CorsTicket> {
  await requireAdmin();
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const key = corsProbeKey(slideName());
  const url = await signUpload(key, 'application/octet-stream', 120);
  if (!url) return { ok: false, error: 'storageUnavailable' };
  const readUrl = await signDownload(key, 120);

  return { ok: true, url, key, ...(readUrl ? { readUrl } : {}) };
}

/**
 * Did the bytes arrive? Then take them away again.
 *
 * Green here means the object existed in the bucket and no longer does — the
 * whole round trip, not a header that looked plausible. The delete runs even
 * when the read says nothing arrived, because a probe must not be able to leave
 * litter behind in the one prefix nothing else cleans.
 */
export async function finishCorsProbe(input: { key: string }): Promise<AdminState> {
  await requireAdmin();
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  // A key this server did not mint stops here, before R2 is touched.
  if (!CORS_PROBE_KEY_PATTERN.test(input.key)) return { ok: false, error: 'invalid' };

  const object = await readObjectHead(input.key, 8);
  await deleteObject(input.key);

  if (!object.ok) {
    // "Missing" is the probe's whole point: the browser reported success and
    // the bucket has nothing. Anything else is storage refusing to answer, and
    // the raw reason is the evidence — not a guess dressed as one.
    return {
      ok: false,
      error: 'uploadFailed',
      detail:
        object.reason === 'missing'
          ? 'le navigateur n’a signalé aucune erreur mais rien n’est arrivé dans le bucket — ' +
            'vérifiez R2_BUCKET et R2_ACCOUNT_ID'
          : `la lecture a échoué (${object.reason}) : ${object.detail ?? 'sans détail'}`,
    };
  }

  if (object.size === 0) {
    return {
      ok: false,
      error: 'uploadFailed',
      detail:
        'le navigateur n’a signalé aucune erreur mais rien n’est arrivé dans le bucket — ' +
        'vérifiez R2_BUCKET et R2_ACCOUNT_ID',
    };
  }

  return { ok: true, detail: `${object.size} octets reçus puis supprimés` };
}

export interface SmtpCandidateReport extends AdminState {
  results?: SmtpCandidate[];
}

/**
 * Which mail host actually answers?
 *
 * `SMTP_HOST` names `mail.talibalim.com`, which has no DNS record, so every
 * send fails at the resolver. Rather than guess the right name and be wrong
 * again, this tries the plausible ones with the credentials already configured
 * and reports what each one did. The office reads the line that says "works"
 * and pastes that host into Vercel and Supabase.
 */
export async function testSmtpHosts(): Promise<SmtpCandidateReport> {
  await requireAdmin();
  const results = await smtpCandidates();
  if (results.length === 0) return { ok: false, error: 'unavailable' };
  return { ok: true, results };
}
