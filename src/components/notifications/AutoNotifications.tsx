'use client';

import { useEffect, useRef } from 'react';
import { urlBase64ToUint8Array } from '@/lib/push/key';
import { savePushSubscription } from '@/app/actions/push';

/**
 * Subscribe this device, without asking.
 *
 * The office asked for notifications to be always on: a staff device that has
 * to be switched on by hand is a device that misses the registration it was
 * meant to announce. So the admin panel subscribes itself.
 *
 * The browser still owns the decision, and nothing here tries to pretend
 * otherwise: a permission already granted means subscribe silently, a
 * permission not yet asked means ask once, and a refusal is left alone —
 * re-prompting somebody who said no is how a site gets its permission
 * blocked for good. Nothing is shown on screen either way; a device that
 * cannot subscribe must not turn the overview into a warning.
 */
const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

/**
 * The endpoint this browser last told the server about.
 *
 * The admin shell mounts this on every page, so without the mark every
 * navigation through the office screens posted the same subscription again —
 * a Server Action, which re-renders the whole admin page it was called from.
 * A push endpoint is stable for the life of the browser profile, so one write
 * per endpoint is all this ever needed to be.
 */
const SAVED = 'tal-push-endpoint';

export function AutoNotifications() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!VAPID) return;
    if (Notification.permission === 'denied') return;

    const subscribe = async () => {
      try {
        const permission =
          Notification.permission === 'granted'
            ? 'granted'
            : await Notification.requestPermission();
        if (permission !== 'granted') return;

        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        const existing = await registration.pushManager.getSubscription();
        const subscription =
          existing ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID) as BufferSource,
          }));

        // Already registered from this browser: nothing has changed, and the
        // write would rebuild the admin page for no reason.
        if (window.localStorage.getItem(SAVED) === subscription.endpoint) return;

        const json = subscription.toJSON();
        await savePushSubscription({
          endpoint: subscription.endpoint,
          p256dh: json.keys?.p256dh ?? '',
          auth: json.keys?.auth ?? '',
          userAgent: navigator.userAgent,
        });
        window.localStorage.setItem(SAVED, subscription.endpoint);
      } catch {
        // Silent by design: this is a convenience, and the admin panel is not
        // the place to explain a browser's push rules.
      }
    };

    void subscribe();
  }, []);

  return null;
}
