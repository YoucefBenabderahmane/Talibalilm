import 'server-only';

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { reportError } from '@/lib/observability/report';
import { malformedR2Config } from '@/lib/storage/r2-config';

/**
 * Cloudflare R2.
 *
 * The bucket holds slide images and uploaded lesson videos.
 *
 * A live class recording still goes to the teacher's own computer as it is made
 * (see `useRecorder`) — that path costs nothing and is unchanged. What the
 * school then does with the file is its own decision: put it on YouTube or
 * Drive and paste the link, or upload it here and have it served from a private
 * bucket behind the paywall. R2 charges for storage but not for downloads,
 * which is what makes the second option affordable at all.
 *
 * `server-only` at the top is load-bearing. R2 credentials are ordinary secrets
 * with full read and write over the bucket, and the one way they could leak is
 * a module like this being pulled into a Client Component's import graph. That
 * import now fails the build rather than shipping a key to the browser.
 *
 * Nothing here throws when R2 is unset. Like PayPal, Resend and Sentry, storage
 * is optional at runtime: unconfigured, slide upload says so plainly and the
 * rest of the class — the room, the video, the recording — carries on.
 */

const ACCOUNT = process.env.R2_ACCOUNT_ID?.trim() ?? '';
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID?.trim() ?? '';
const SECRET = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
const BUCKET = process.env.R2_BUCKET?.trim() ?? '';

/** True once all four values are present. Screens check this and degrade. */
export const r2Configured = Boolean(ACCOUNT && ACCESS_KEY && SECRET && BUCKET);

/**
 * Which of the four is missing, by name.
 *
 * Names only — never a value, not even a fragment. "Storage is not configured"
 * is true and useless when all four look set in the dashboard: the one that is
 * actually empty, or spelled differently, or attached to a different
 * environment, is the whole of the answer.
 */
export function r2Missing(): string[] {
  return [
    ['R2_ACCOUNT_ID', ACCOUNT],
    ['R2_ACCESS_KEY_ID', ACCESS_KEY],
    ['R2_SECRET_ACCESS_KEY', SECRET],
    ['R2_BUCKET', BUCKET],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name as string);
}

/**
 * Which of the four is present but impossible, by name.
 *
 * A value that is set is not the same as a value that is right: the S3 API URL
 * pasted into `R2_ACCOUNT_ID` is present and produces a hostname no resolver
 * can answer. The shape rules live in `r2-config.ts`, pure and unit-tested.
 */
export function r2Malformed(): string[] {
  return malformedR2Config(ACCOUNT, BUCKET);
}

/**
 * One R2 round trip may take this long before it is abandoned.
 *
 * Without it a bucket that accepts the connection and never answers held the
 * caller forever: an upload stalled at the page it was confirming, a removal
 * spun on a delete that was never coming back. A deadline turns both into a
 * named failure the screen can show. Eight seconds is far longer than any
 * healthy HEAD, GET or DELETE of one small object.
 */
const R2_TIMEOUT_MS = 8_000;

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      // R2 has no regions; 'auto' is what Cloudflare's own documentation uses.
      region: 'auto',
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },

      // WITHOUT THIS, EVERY BROWSER UPLOAD FAILS.
      //
      // Recent versions of the AWS SDK add a CRC32 checksum to S3 writes by
      // default. For an ordinary upload it is computed from the body and is a
      // genuine integrity check. For a PRESIGNED url there is no body at
      // signing time, so the SDK computes the checksum of NOTHING —
      // `x-amz-checksum-crc32=AAAAAA==`, the CRC32 of zero bytes — and bakes
      // that into the query string. R2 then compares the file the browser
      // actually sent against the checksum of an empty payload, and rejects
      // every upload that is not empty.
      //
      // The rejection is invisible from the browser: an S3 error response
      // carries no CORS headers, so `xhr.onerror` fires with no status and no
      // message, indistinguishable from a dropped connection. It cost a full
      // round of blaming the bucket policy, which was correct all along.
      //
      // 'WHEN_REQUIRED' keeps checksums for the operations that genuinely need
      // them and stops the SDK volunteering one it cannot compute.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

/**
 * A URL the browser may PUT one object to, for a few minutes.
 *
 * The upload goes straight from the teacher's machine to Cloudflare rather than
 * through Vercel — a function that streams every slide would be paying for
 * bandwidth to do nothing but forward it, and a two-gigabyte video could not go
 * through one at all. The signature pins the key and the content type, so the
 * URL cannot be reused for a different object.
 *
 * A video needs longer than a slide: `seconds` is a parameter for that reason,
 * and the caller decides.
 */
export async function signUpload(
  key: string,
  contentType: string,
  seconds = 300,
): Promise<string | null> {
  if (!r2Configured) return null;
  try {
    return await getSignedUrl(
      s3(),
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: seconds },
    );
  } catch (error) {
    reportError('r2.signUpload', error, { key });
    return null;
  }
}

/**
 * A URL the browser may GET one object from, for a few minutes.
 *
 * Short-lived on purpose. The bucket itself stays private — there is no public
 * base URL anywhere in this codebase — so a slide is only ever reachable
 * through a signature minted after `can_read_slide()` said yes. A link that
 * escapes into a chat log stops working within the hour.
 */
export async function signDownload(key: string, seconds = 3600): Promise<string | null> {
  if (!r2Configured) return null;
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      expiresIn: seconds,
    });
  } catch (error) {
    reportError('r2.signDownload', error, { key });
    return null;
  }
}

/**
 * The first bytes of an object, and its true length, read server-side.
 *
 * This is what lets the upload go direct to Cloudflare without giving up the
 * rule that a file is judged by its bytes and never by its declared type. The
 * browser uploads, then the server reads a few bytes back with a ranged GET and
 * sniffs them; only then does a row appear. An object that turns out not to be
 * an image is deleted and never becomes a slide.
 *
 * The length comes from the response's Content-Range (`bytes 0-15/12345`), not
 * from the browser. A presigned PUT cannot cap what is actually sent, so the
 * size that reaches the database has to be measured here rather than believed.
 *
 * `missing` and `failed` are two different answers on purpose. An object the
 * bucket does not have means the upload never landed; a bucket that could not
 * be reached — a deadline, DNS, a dropped socket — is a storage fault, and
 * telling the office "upload failed" for it sends them to the wrong problem.
 */
export type ObjectHead =
  | { ok: true; head: Uint8Array; size: number }
  | { ok: false; reason: 'missing' | 'failed'; detail?: string };

export async function readObjectHead(key: string, bytes = 16): Promise<ObjectHead> {
  if (!r2Configured) return { ok: false, reason: 'failed', detail: 'storage is not configured' };
  try {
    const result = await s3().send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: `bytes=0-${bytes - 1}` }),
      { abortSignal: AbortSignal.timeout(R2_TIMEOUT_MS) },
    );
    const body = await result.Body?.transformToByteArray();
    if (!body) return { ok: false, reason: 'missing' };

    // "bytes 0-15/12345" — the figure after the slash is the whole object.
    const total = Number(result.ContentRange?.split('/')[1]);
    const size = Number.isFinite(total) && total > 0 ? total : (result.ContentLength ?? 0);
    return { ok: true, head: new Uint8Array(body), size };
  } catch (error) {
    reportError('r2.readHead', error, { key });
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    const name = (error as { name?: string })?.name;
    const missing = name === 'NoSuchKey' || status === 404;
    return {
      ok: false,
      reason: missing ? 'missing' : 'failed',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/**
 * Three outcomes, not two.
 *
 * `unverifiable` is the one that had to exist. The previous version returned a
 * boolean, so a probe that never reached Cloudflare at all — DNS, egress, a
 * four-second deadline — came back `ok: false` and was printed as "the bucket
 * refuses your origin". That is a fault this code never observed, reported as
 * fact, about a bucket whose policy was correct the whole time. A check that
 * cries wolf costs more than no check.
 *
 * So: `allowed` means R2 named our origin back, `refused` means R2 answered and
 * did not, and `unverifiable` means the question was never put. Only the first
 * two are evidence.
 */
export type CorsOutcome = 'allowed' | 'refused' | 'unverifiable';

export interface CorsProbe {
  configured: boolean;
  outcome: CorsOutcome;
  status?: number;
  allowOrigin?: string;
  allowMethods?: string;
  allowHeaders?: string;
  error?: string;
}

/**
 * Will the bucket accept a browser PUT from this origin?
 *
 * A failed direct upload tells the browser almost nothing — a CORS refusal and
 * a dropped connection arrive at `xhr.onerror` identically, with no status and
 * no message, by design in the fetch spec. So the guess goes on screen and the
 * fault stays hidden, which is exactly the thing CLAUDE.md forbids.
 *
 * The server has no such handicap: it can send the preflight ITSELF, with an
 * `Origin` header, and read what R2 actually answers. That turns "the upload
 * was refused or interrupted" into a fact — either the bucket names our origin
 * back, or it does not.
 *
 * The key is presigned but never written to. A preflight is a question, not an
 * upload; nothing is stored by asking.
 */
export async function checkCors(origin: string): Promise<CorsProbe> {
  if (!r2Configured) return { configured: false, outcome: 'unverifiable' };

  try {
    const url = await getSignedUrl(
      s3(),
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'cors-probe/never-written',
        ContentType: 'video/mp4',
      }),
      { expiresIn: 60 },
    );

    const response = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
      cache: 'no-store',
      // A deadline, because this runs inside a page render with a budget. A
      // preflight that hangs must report itself, not take the page with it.
      signal: AbortSignal.timeout(4000),
    });

    const allowOrigin = response.headers.get('access-control-allow-origin') ?? '';
    const allowMethods = response.headers.get('access-control-allow-methods') ?? '';
    const allowHeaders = response.headers.get('access-control-allow-headers') ?? '';

    // R2 answers 200 with the headers when the policy matches, and 403 — or a
    // 200 with no headers at all — when it does not.
    const allowed =
      response.ok && (allowOrigin === '*' || allowOrigin.toLowerCase() === origin.toLowerCase());

    return {
      configured: true,
      outcome: allowed ? 'allowed' : 'refused',
      status: response.status,
      allowOrigin,
      allowMethods,
      allowHeaders,
    };
  } catch (error) {
    // The request never completed. That is a fact about this probe — a resolver,
    // an egress rule, the four-second deadline — and says nothing whatever
    // about the bucket's policy. Reported as what it is, with the raw error, so
    // the browser test can answer the question properly.
    reportError('r2.checkCors', error, { origin });
    return {
      configured: true,
      outcome: 'unverifiable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove one object. Used when a slide is deleted, and to clean up a rejected
 * upload.
 *
 * Bounded like the read: a delete that never answers is a caller that never
 * answers. Deleting is idempotent in S3 — a key that is already gone asks for
 * nothing and succeeds — so the deadline only ever fires on a genuine stall.
 */
export async function deleteObject(key: string): Promise<boolean> {
  if (!r2Configured) return false;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }), {
      abortSignal: AbortSignal.timeout(R2_TIMEOUT_MS),
    });
    return true;
  } catch (error) {
    reportError('r2.delete', error, { key });
    return false;
  }
}
