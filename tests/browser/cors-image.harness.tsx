/**
 * The slide image component, rendered by React in a real browser.
 *
 * The guarantee under test: a slide ALWAYS appears for the class — with CORS
 * when the bucket allows it (so the recorder may draw it), and as a plain image
 * when it does not (today's R2 policy), instead of a black stage.
 */
import { createRoot } from 'react-dom/client';
import { CorsImage } from '@/components/live/CorsImage';

declare global {
  interface Window {
    mountSlide: (src: string) => void;
  }
}

window.mountSlide = (src: string) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(<CorsImage src={src} alt="" data-testid="slide" />);
};
