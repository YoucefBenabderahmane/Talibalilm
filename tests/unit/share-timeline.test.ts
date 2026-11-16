import { describe, expect, it } from 'vitest';
import {
  classifyShareError,
  seconds,
  shareSteps,
  slowestStep,
  SLOW_STEP_MS,
  type ShareStamps,
} from '@/lib/live/share-timeline';

const stamps = (over: Partial<ShareStamps> = {}): ShareStamps => ({
  clicked: 1000,
  handled: 1020,
  requested: 1021,
  chosen: 2400,
  published: 2700,
  received: 3100,
  ...over,
});

describe('shareSteps', () => {
  it('splits a share into the steps the readout names', () => {
    expect(shareSteps(stamps())).toEqual({
      page: 20,
      site: 1,
      chrome: 1379,
      send: 300,
      receive: 400,
    });
  });

  it('leaves a step it cannot know empty, instead of guessing', () => {
    const steps = shareSteps(stamps({ clicked: null, published: null, received: null }));
    expect(steps.page).toBeNull();
    expect(steps.send).toBeNull();
    expect(steps.receive).toBeNull();
    expect(steps.chrome).toBe(1379);
  });

  it('never reports a negative step when two events arrive out of order', () => {
    // The server can confirm a subscriber before publishTrack resolves.
    expect(shareSteps(stamps({ received: 2600 })).receive).toBe(0);
  });
});

describe('slowestStep', () => {
  it('says nothing when every step is quick', () => {
    expect(slowestStep(shareSteps(stamps()))).toBeNull();
  });

  it('names Chrome when its window is what took two minutes', () => {
    expect(
      slowestStep(
        shareSteps(stamps({ chosen: 1021 + 125_000, published: 1021 + 125_300, received: null })),
      ),
    ).toBe('chrome');
  });

  it('names the page when the click itself waited', () => {
    expect(
      slowestStep(
        shareSteps(
          stamps({
            handled: 1000 + SLOW_STEP_MS + 1,
            requested: 1000 + SLOW_STEP_MS + 2,
            chosen: 1000 + SLOW_STEP_MS + 500,
          }),
        ),
      ),
    ).toBe('page');
  });
});

describe('classifyShareError', () => {
  it('treats closing Chrome’s window as her choice, not a failure', () => {
    expect(
      classifyShareError(new DOMException('Permission denied', 'NotAllowedError')).outcome,
    ).toBe('cancelled');
  });

  it('treats the system saying no as a refusal, with its words', () => {
    const result = classifyShareError(
      new DOMException('Permission denied by system', 'NotAllowedError'),
    );
    expect(result).toEqual({
      outcome: 'refused',
      detail: 'NotAllowedError: Permission denied by system',
    });
  });

  it('treats anything else as a failure, keeping the browser’s words', () => {
    expect(
      classifyShareError(new DOMException('Could not start video source', 'NotReadableError')),
    ).toEqual({
      outcome: 'failed',
      detail: 'NotReadableError: Could not start video source',
    });
    expect(classifyShareError('weird').outcome).toBe('failed');
  });

  it('treats « Arrêter » during the publish as her choice too', () => {
    const stopped = new DOMException(
      'Share cancelled: stopped before it was published',
      'AbortError',
    );
    expect(classifyShareError(stopped).outcome).toBe('cancelled');
  });
});

describe('seconds', () => {
  it('prints one decimal in the reader’s language', () => {
    expect(seconds(1379, 'fr')).toBe('1,4');
    expect(seconds(1379, 'en')).toBe('1.4');
    expect(seconds(null, 'fr')).toBeNull();
  });
});
