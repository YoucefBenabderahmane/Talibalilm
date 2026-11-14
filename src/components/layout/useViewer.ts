'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { supabaseConfigured } from '@/lib/env';

export interface HeaderViewer {
  /** null while still unknown — the first paint cannot know. */
  signedIn: boolean | null;
}

/**
 * Is anyone signed in, for the header only.
 *
 * Signed in, and nothing more. It used to read the profile's role as well, to
 * decide whether to show an Administration link — a decision made in the
 * browser, which is the wrong place for it. The dashboard carries that link
 * instead, chosen on the server, so a student's page never contains it.
 *
 * Read in the browser rather than on the server, and that is a deliberate
 * trade. The header sits in the root layout, so asking the server would mean
 * reading cookies there — which turns every marketing page dynamic and throws
 * away the static rendering the catalogue depends on for SEO. Chrome is not
 * worth that.
 *
 * Two reads, not one. `getSession()` answers from the stored cookie with no
 * network round trip, so the header flips to "Mon espace" the instant the
 * session exists — which is what a student who has just confirmed their email
 * expects. `getUser()` then revalidates against the auth server and corrects
 * the answer if the stored session was stale. The first is presentation, the
 * second is the truth, and the gap between them is a frame.
 *
 * The session can also change in a page we are not navigating: an email
 * confirmed in another tab, or a magic link opened in a second window. So the
 * read is repeated when the tab regains focus and when it becomes visible
 * again — otherwise the header keeps offering a login to somebody who has
 * already signed in. Not on every route change any more: that was one auth
 * round trip from the browser on every click, and a sign-in or sign-out in
 * this tab reaches `onAuthStateChange` without it.
 *
 * This is presentation only. Nothing here guards anything: the dashboard is
 * protected by the middleware and by the RLS policies, both of which hold
 * whatever this hook believes.
 */
export function useViewer(): HeaderViewer {
  const [viewer, setViewer] = useState<HeaderViewer>({ signedIn: null });

  useEffect(() => {
    if (!supabaseConfigured) {
      setViewer({ signedIn: false });
      return;
    }

    const supabase = createClient();
    let alive = true;

    const read = (userId: string | undefined | null) => {
      if (alive) setViewer({ signedIn: Boolean(userId) });
    };

    const check = () => {
      void supabase.auth.getSession().then(({ data }) => read(data.session?.user?.id));
      void supabase.auth.getUser().then(({ data }) => read(data.user?.id));
    };

    check();

    // Signing out in another tab has to be reflected here too, or the header
    // keeps offering a dashboard that now redirects to the login page.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      read(session?.user?.id);
    });

    const onFocus = () => check();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return viewer;
}
