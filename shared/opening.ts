// Only the newest of several pending opens may go through: tapping another card while one waits for its details supersedes
// it, so two sheets never open on top of each other whichever request finishes first [ATT-06].
export class LatestOnly {
  private current: { id: number; cancel: () => void } | null = null;
  private next = 0;

  // A new pending open; the one before it, if still waiting, is cancelled.
  start(cancel: () => void): PendingOpen {
    this.current?.cancel();
    const id = ++this.next;
    this.current = { id, cancel };
    return {
      isCurrent: () => this.current?.id === id,
      // It opened, or its card went away: nothing is pending any more.
      done: () => {
        if (this.current?.id === id) this.current = null;
      },
    };
  }
}

export interface PendingOpen {
  isCurrent: () => boolean;
  done: () => void;
}
