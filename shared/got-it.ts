// Got it on one Changed by others note and Mark all as read on them all wait for each other, so a note is never in two
// Undos at once, where undoing the one would bring back what the other cleared [HIS-07].
// Archive session and Archive all clean wait for each other the same way, so a row is never archived twice [ATT-22].

// The busy keys Mark all as read and Archive all clean run under; a row's own action runs under its item's key.
export const ALL_NOTES = "changed";
export const ALL_WRAP = "wrap";

export function noteBusy(busy: ReadonlySet<string>, key: string): boolean {
  return busy.has(key) || busy.has(ALL_NOTES);
}

export function allNotesBusy(busy: ReadonlySet<string>, keys: string[]): boolean {
  return busy.has(ALL_NOTES) || keys.some((key) => busy.has(key));
}

export function wrapBusy(busy: ReadonlySet<string>, key: string): boolean {
  return busy.has(key) || busy.has(ALL_WRAP);
}

export function allWrapBusy(busy: ReadonlySet<string>, keys: string[]): boolean {
  return busy.has(ALL_WRAP) || keys.some((key) => busy.has(key));
}
