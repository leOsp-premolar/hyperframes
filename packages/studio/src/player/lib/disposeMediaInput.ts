/**
 * Dispose a Mediabunny input once its open has settled, and not at all when the open failed.
 * `Input.dispose()` chains onto the open without a catch, so after a file that cannot be read it
 * leaves an unhandled rejection behind (a page error in the browser). An input that never opened
 * holds only its source references, which Mediabunny frees when the input is collected.
 */
export function disposeMediaInput(input: {
  getFormat: () => Promise<unknown>;
  dispose: () => void;
}): void {
  input.getFormat().then(
    () => input.dispose(),
    () => {},
  );
}
