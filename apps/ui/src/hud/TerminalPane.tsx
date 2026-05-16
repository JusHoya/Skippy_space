import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Channel, invoke, isTauri } from '../lib/tauri';

interface Props {
  /** Logical tab identifier — useful for debugging and future per-agent PTYs. */
  tabId: string;
  /**
   * When supplied, attach to an existing Rust-side PTY instead of opening a
   * fresh one. Used for claude-code tabs whose PTY was opened by
   * `claude_code_spawn` on the Rust side. The tab does NOT call `pty_close`
   * on unmount in this mode — the subprocess outlives the renderer-side tab
   * (the user explicitly closes it via the close-tab affordance).
   */
  existingPtyId?: string;
}

/**
 * One xterm.js terminal bound to one Rust-side PTY (PRD §10).
 *
 * The Rust shell owns the actual ConPTY via `portable-pty`; we use the four
 * Tauri commands `pty_open` / `pty_write` / `pty_resize` / `pty_close`, plus
 * `pty_subscribe` to stream output back over a Channel.
 *
 * If we're not running inside Tauri (e.g., `pnpm dev` opened in a regular
 * browser tab), we still render the terminal — it just prints a hint instead
 * of failing.
 */
export default function TerminalPane({ tabId, existingPtyId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      theme: {
        background: '#0B0C10',
        foreground: '#C5C6C7',
        cursor: '#66FCF1',
        selectionBackground: 'rgba(102, 252, 241, 0.35)',
      },
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(hostRef.current);

    // Run an initial fit on the next frame so xterm sees real layout sizes.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* host element not yet sized — harmless */
      }
    });

    let ptyId: string | null = null;
    let disposed = false;
    // When attaching to an existing PTY (claude-code), don't issue pty_close
    // on unmount — the subprocess outlives the tab. The Rust shell will reap
    // it via the exit-watcher task and publish `claude_code_exited`.
    const ownsPty = existingPtyId === undefined;

    (async () => {
      if (!isTauri()) {
        term.writeln('\x1b[36mskippy_space\x1b[0m: terminal is running outside Tauri — PTY disabled.');
        term.writeln('Launch via `pnpm tauri dev` for the real shell.');
        return;
      }
      try {
        if (existingPtyId !== undefined) {
          ptyId = existingPtyId;
          // The PTY already exists on the Rust side; just resize to our cols/rows
          // so the subprocess sees a sane terminal geometry. Resize is best-effort.
          await invoke('pty_resize', { ptyId, cols: term.cols, rows: term.rows }).catch(
            () => undefined,
          );
        } else {
          ptyId = await invoke<string>('pty_open', { cols: term.cols, rows: term.rows });
        }
        if (disposed) return;
        const ch = new Channel<string>();
        ch.onmessage = (data) => term.write(data);
        await invoke('pty_subscribe', { ptyId, channel: ch });
        term.onData((d) => {
          if (ptyId) {
            invoke('pty_write', { ptyId, data: d }).catch(() => undefined);
          }
        });
      } catch (e) {
        term.writeln(`\x1b[31mskippy_space: PTY open failed:\x1b[0m ${String(e)}`);
      }
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ptyId) {
        invoke('pty_resize', { ptyId, cols: term.cols, rows: term.rows }).catch(() => undefined);
      }
    });
    ro.observe(hostRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      if (ptyId && ownsPty) {
        invoke('pty_close', { ptyId }).catch(() => undefined);
      }
      term.dispose();
    };
    // The PTY is bound to the tabId / existingPtyId; if either changes we
    // tear down the previous PTY (when owned) and re-attach.
  }, [tabId, existingPtyId]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
