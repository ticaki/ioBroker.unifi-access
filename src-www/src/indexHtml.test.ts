/**
 * The inline loader of socket.io.js in index.html, executed as the browser does it: the tests decide
 * whether each <script> that it adds loads or fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

interface LoaderWindow {
    socketUrl?: string;
    socketPath?: string;
    socketLoadError?: string;
    socketLoadedHandler?: () => void;
    socketLoadErrorHandler?: (tried: string) => void;
    registerSocketOnLoad?: (cb: () => void) => void;
    registerSocketLoadError?: (cb: (tried: string) => void) => void;
}

function inlineScript(file: string): string {
    const html = readFileSync(file, 'utf8');
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!match) {
        throw new Error(`no inline script in ${file}`);
    }
    return match[1];
}

const LOADER = inlineScript(resolve(here, '../index.html'));

/** The <script> elements the loader added, in order */
function addedScripts(): HTMLScriptElement[] {
    return [...document.head.querySelectorAll('script')].filter(s => s.src);
}

const added: HTMLScriptElement[] = [];

function run(path: string): LoaderWindow {
    window.history.replaceState({}, '', path);
    // indirect eval: runs in the global scope like a classic <script>
    (0, eval)(LOADER);
    return window as unknown as LoaderWindow;
}

/** Let the n-th script (counted from all the loader ever added) fail or load */
function settle(index: number, outcome: 'load' | 'error'): void {
    const script = added[index];
    script.dispatchEvent(new Event(outcome));
}

beforeEach(() => {
    added.length = 0;
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
        if (node instanceof HTMLScriptElement) {
            added.push(node);
        }
        return append(node);
    });
});

afterEach(() => {
    for (const script of addedScripts()) {
        script.remove();
    }
    const w = window as unknown as LoaderWindow;
    delete w.socketLoadError;
    delete w.socketLoadedHandler;
    delete w.socketLoadErrorHandler;
    delete w.registerSocketOnLoad;
    delete w.registerSocketLoadError;
    delete w.socketUrl;
});

describe('index.html socket.io loader', () => {
    it('loads socket.io.js one level above the panel, also behind a path prefix', () => {
        run('/iob/unifi-access/index.html?instance=1');

        expect(added.map(s => s.src)).toEqual(['http://localhost:3000/iob/lib/js/socket.io.js']);
    });

    it('calls the handler of the app once the library is loaded', () => {
        const w = run('/unifi-access/index.html');
        const loaded = vi.fn();
        w.registerSocketOnLoad?.(loaded);

        settle(0, 'load');

        expect(loaded).toHaveBeenCalledTimes(1);
        expect(w.socketLoadError).toBeUndefined();
    });

    it('tries the root of the server next and reports every URL it tried if nothing loads', () => {
        const w = run('/iob/unifi-access/index.html');
        const failed = vi.fn();
        w.registerSocketLoadError?.(failed);

        settle(0, 'error');
        expect(added.map(s => s.src)).toEqual([
            'http://localhost:3000/iob/lib/js/socket.io.js',
            'http://localhost:3000/lib/js/socket.io.js',
        ]);
        expect(failed).not.toHaveBeenCalled();

        settle(1, 'error');
        expect(failed).toHaveBeenCalledWith(
            'http://localhost:3000/iob/lib/js/socket.io.js, http://localhost:3000/lib/js/socket.io.js',
        );
        // failed script elements are removed again
        expect(addedScripts()).toEqual([]);
    });

    it('does not try the same URL twice for a page directly below the root', () => {
        const w = run('/unifi-access/index.html');
        settle(0, 'error');

        expect(added).toHaveLength(1);
        expect(w.socketLoadError).toBe('http://localhost:3000/lib/js/socket.io.js');
    });

    it('also reports a failure that happened before the app registered its handler', () => {
        const w = run('/unifi-access/index.html');
        settle(0, 'error');

        const failed = vi.fn();
        w.registerSocketLoadError?.(failed);
        expect(failed).toHaveBeenCalledWith('http://localhost:3000/lib/js/socket.io.js');
    });

    it('is shipped unchanged in www/index.html', () => {
        // the CI job "frontend-tests" checks that www/ matches the sources; locally run npm run build:www
        expect(inlineScript(resolve(here, '../../www/index.html'))).toBe(LOADER);
    });

    it('connects to the origin of the page', () => {
        const w = run('/iob/unifi-access/index.html');

        expect(w.socketUrl).toBe('http://localhost:3000');
    });

    describe('WebSocket path behind a reverse proxy with a path prefix', () => {
        const w = window as unknown as LoaderWindow & { io?: unknown };
        afterEach(() => {
            delete w.io;
            delete w.socketPath;
        });

        it('passes the prefix as socketPath to the ws client of the web adapter (it ignores the "path" option)', () => {
            run('/iob/unifi-access/index.html');
            w.io = { connect: vi.fn() };
            settle(0, 'load');

            expect(w.socketPath).toBe('/iob/');
        });

        it('sets no socketPath for a page directly below the root', () => {
            run('/unifi-access/index.html');
            w.io = { connect: vi.fn() };
            settle(0, 'load');

            expect(w.socketPath).toBeUndefined();
        });

        it('sets no socketPath if the library was only found at the root of the server', () => {
            run('/iob/unifi-access/index.html');
            settle(0, 'error');
            w.io = { connect: vi.fn() };
            settle(1, 'load');

            expect(w.socketPath).toBeUndefined();
        });

        it('sets no socketPath for real socket.io (it uses the "path" option)', () => {
            run('/iob/unifi-access/index.html');
            w.io = { connect: vi.fn(), Manager: vi.fn() };
            settle(0, 'load');

            expect(w.socketPath).toBeUndefined();
        });
    });
});
