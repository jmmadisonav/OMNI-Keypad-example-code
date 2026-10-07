// electron/app-dialog.spec.ts
import { describe, expect, it } from 'vitest';
import { AppDialogs, type AppDialogRequest } from './app-dialog';

const NOTICE = { title: 'Activation complete', message: 'Licensed.', confirmLabel: 'OK', cancelLabel: null };

describe('AppDialogs', () => {
  it('sends each request to the renderer with its own id', () => {
    const sent: AppDialogRequest[] = [];
    const dialogs = new AppDialogs(request => sent.push(request));
    void dialogs.show(NOTICE);
    void dialogs.show({ ...NOTICE, title: 'Second' });
    expect(sent.map(r => [r.id, r.title])).toEqual([[1, 'Activation complete'], [2, 'Second']]);
  });

  it('resolves with the answer and forgets the request', async () => {
    const dialogs = new AppDialogs(() => {});
    const confirmed = dialogs.show(NOTICE);
    const cancelled = dialogs.show(NOTICE);
    dialogs.answer(1, true);
    dialogs.answer(2, false);
    expect(await confirmed).toBe(true);
    expect(await cancelled).toBe(false);
    expect(dialogs.pending()).toEqual([]);
  });

  it('keeps unanswered requests for a renderer that starts listening late', () => {
    const dialogs = new AppDialogs(() => {});
    void dialogs.show(NOTICE);
    expect(dialogs.pending()).toEqual([{ id: 1, ...NOTICE }]);
  });

  it('ignores an answer for an unknown or already answered id', async () => {
    const dialogs = new AppDialogs(() => {});
    const result = dialogs.show(NOTICE);
    dialogs.answer(99, true);
    dialogs.answer(1, false);
    dialogs.answer(1, true);
    expect(await result).toBe(false);
  });

  it('cancels everything outstanding when the window goes away', async () => {
    const dialogs = new AppDialogs(() => {});
    const first = dialogs.show(NOTICE);
    const second = dialogs.show(NOTICE);
    dialogs.cancelAll();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(dialogs.pending()).toEqual([]);
  });
});
