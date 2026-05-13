import { Channel, invoke, isTauri } from './tauri';

/**
 * Thin async wrapper over the Rust PTY commands exposed by the Tauri shell:
 *   pty_open / pty_write / pty_resize / pty_close / pty_subscribe.
 *
 * Backing implementation per PRD §10.2: Rust `portable-pty` → ConPTY on
 * Windows. One PTY per consumer; the renderer holds the xterm instance and
 * pumps bytes through these calls.
 */
export interface PtyHandle {
  id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export async function openPty(opts: {
  cols: number;
  rows: number;
  onData: (chunk: string) => void;
}): Promise<PtyHandle | null> {
  if (!isTauri()) {
    console.warn('[skippy/ui] openPty: not in Tauri — no PTY available.');
    return null;
  }
  const ptyId = await invoke<string>('pty_open', { cols: opts.cols, rows: opts.rows });
  const ch = new Channel<string>();
  ch.onmessage = (chunk) => opts.onData(chunk);
  await invoke('pty_subscribe', { ptyId, channel: ch });
  return {
    id: ptyId,
    async write(data: string) {
      await invoke('pty_write', { ptyId, data }).catch(() => undefined);
    },
    async resize(cols: number, rows: number) {
      await invoke('pty_resize', { ptyId, cols, rows }).catch(() => undefined);
    },
    async close() {
      await invoke('pty_close', { ptyId }).catch(() => undefined);
    },
  };
}
