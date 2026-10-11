'use client';

import { forwardRef, useState, type ImgHTMLAttributes } from 'react';

/**
 * A slide image the recorder is allowed to read — when the bucket allows it.
 *
 * Slides come from R2, another origin. Loaded as a plain <img> they display
 * fine but are unreadable to the page, and drawing one into the recording
 * froze the file (see `@/lib/live/recording/drawable`). Loaded with
 * `crossOrigin="anonymous"`, they are readable — provided the bucket's CORS
 * policy answers GET. If it does not, the CORS request fails and the image
 * would not appear at all, which is worse than not being recorded.
 *
 * So: CORS first; on failure, once, the plain load. The class always sees the
 * slide; the recording includes it whenever the bucket allows, and the
 * recorder says so when it does not. The order matters: a CORS answer can
 * serve a later plain request from cache, the reverse can poison a CORS one.
 */
type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'crossOrigin'> & { src: string };

export const CorsImage = forwardRef<HTMLImageElement, Props>(function CorsImage(
  { src, alt = '', onError, ...rest },
  ref,
) {
  // The fallback belongs to the URL that failed: a new slide starts with its
  // own CORS attempt in the very first render, never a plain load first.
  const [plainFor, setPlainFor] = useState<string | null>(null);
  const plain = plainFor === src;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- a signed URL that expires, loaded under CORS
    <img
      ref={ref}
      // The attribute changing reloads the image, which is what the fallback is.
      key={plain ? 'plain' : 'cors'}
      {...rest}
      alt={alt}
      src={src}
      crossOrigin={plain ? undefined : 'anonymous'}
      onError={(event) => {
        if (!plain) {
          setPlainFor(src);
          return;
        }
        onError?.(event);
      }}
    />
  );
});
