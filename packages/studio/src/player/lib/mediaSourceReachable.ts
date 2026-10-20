import { studioApiFetch } from "../../utils/studioApiFetch";

/**
 * Whether a media URL answers with its bytes; an HTML page (a dev server's fallback for a path it
 * does not have) is no answer. Mediabunny's `Input.dispose()` chains a bare `.then`
 * on a demuxer that failed to open, so handing it a missing file leaves an unhandled rejection
 * behind; callers ask this first and never open what is not there. Costs one one-byte request.
 */
export async function mediaSourceReachable(url: string, signal?: AbortSignal): Promise<boolean> {
  let res: Response;
  try {
    res = await studioApiFetch(url, { headers: { Range: "bytes=0-0" }, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
  void res.body?.cancel().catch(() => undefined);
  return res.ok && !/^text\/html\b/i.test(res.headers.get("content-type") ?? "");
}
