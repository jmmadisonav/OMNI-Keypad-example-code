// electron/app-dialog.ts
//
// Message boxes drawn by the app itself instead of by Windows. A native
// message box renders in the light system style and, with custom button
// labels, as "command links" -- neither of which matches anything else the
// app shows. The main process asks; the designer page (designer/static/app.js)
// draws it with its own modal and answers.

/** What the main process asks for. */
export interface AppDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** Null for a notice with a single button. */
  cancelLabel: string | null;
}

export interface AppDialogRequest extends AppDialogOptions {
  id: number;
}

/**
 * The dialogs waiting on an answer from the renderer.
 *
 * Held here rather than only pushed, because the renderer may not be
 * listening yet when one is asked for -- licensing starts as the page
 * finishes loading, which can be before Angular has subscribed. So the
 * renderer also asks for everything pending when it starts. A request it
 * sees both ways is the same id, shown once.
 */
export class AppDialogs {
  private nextId = 1;
  private readonly waiting = new Map<number, { request: AppDialogRequest; resolve: (confirmed: boolean) => void }>();

  /** `send` delivers a request to the renderer, or does nothing when there
   * is no window to deliver it to. */
  constructor(private readonly send: (request: AppDialogRequest) => void) {}

  /** Shows a dialog and resolves true for the confirm button, false for
   * cancel, Escape, or the renderer going away. */
  show(options: AppDialogOptions): Promise<boolean> {
    const request = { id: this.nextId++, ...options };
    return new Promise(resolve => {
      this.waiting.set(request.id, { request, resolve });
      this.send(request);
    });
  }

  pending(): AppDialogRequest[] {
    return [...this.waiting.values()].map(entry => entry.request);
  }

  answer(id: number, confirmed: boolean): void {
    const entry = this.waiting.get(id);
    if (!entry) { return; }
    this.waiting.delete(id);
    entry.resolve(confirmed === true);
  }

  /** Answers everything outstanding as cancelled, for a window that closed
   * with dialogs still up. Nothing awaiting one is left hanging. */
  cancelAll(): void {
    for (const id of [...this.waiting.keys()]) { this.answer(id, false); }
  }
}
