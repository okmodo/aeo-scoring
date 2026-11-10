import React, { useEffect, useRef, useState } from 'react';
import { unlockPreview } from './audit';

export function PreviewPassword({ onUnlock }: { onUnlock: (password: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      request.current?.abort();
      element?.close();
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || !input.current) return;
    const password = input.current.value;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    try {
      await unlockPreview(password, controller.signal);
      if (!controller.signal.aborted) onUnlock(password);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error && !(err instanceof TypeError) ? err.message : 'Could not reach testing access. Try again.');
        input.current?.select();
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <dialog ref={dialog} className="preview-password" aria-labelledby="preview-password-heading"
      onCancel={event => event.preventDefault()}>
      <form method="post" onSubmit={submit}>
        <h2 id="preview-password-heading">Testing access</h2>
        <label htmlFor="preview-password">Shared password</label>
        <input id="preview-password" ref={input} type="password" autoComplete="current-password"
          maxLength={128} required readOnly={pending} />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? 'Checking…' : 'Unlock preview'}</button>
      </form>
    </dialog>
  );
}
