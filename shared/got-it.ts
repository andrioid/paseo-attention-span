// Got it on one Changed by others note and Mark all as read on them all wait for each other, so a note is never in two
// Undos at once, where undoing the one would bring back what the other cleared [ATT-21].

// The busy key Mark all as read runs under; a row's own Got it runs under its item's key.
export const ALL_NOTES = "changed";

export function noteBusy(busy: ReadonlySet<string>, key: string): boolean {
  return busy.has(key) || busy.has(ALL_NOTES);
}

export function allNotesBusy(busy: ReadonlySet<string>, keys: string[]): boolean {
  return busy.has(ALL_NOTES) || keys.some((key) => busy.has(key));
}
