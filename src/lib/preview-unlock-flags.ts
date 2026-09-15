/** Browser-safe flags shared by the preview deck and Node unlock routes. */

export function clipReadyToUnlock(status: string | undefined): boolean {
  return status === "complete";
}

/** Server snapshot wins. Missing/false incoming clears a stale client true. */
export function mergeUnlocked(incoming: boolean | undefined): boolean {
  return incoming === true;
}
