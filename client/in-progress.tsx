import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type InProgressEntry, type StartedIssue } from "../shared/in-progress";
import { sessionSignal } from "../shared/item-view";
import { CardList, CardRow } from "./card";
import type { Actions } from "./item-actions";
import { ItemRow } from "./item-row";
import { IssueRow, type IssueRowProps, issueDetailsQuery } from "./next-up";
import { PlaceText } from "./entity";
import { sessionEntry } from "./session-menu";
import { ActionSheet, DETAILS_STALE_MS, DetailLines, githubEntry, type SheetEntry, usePrefetchOnRest } from "./sheet";
import { Meta } from "./ui";

// In progress: my drafts and the issues I started, in one list, whatever waits on me first [PRS-05, SES-11].
export function InProgress({ entries, actions, issueRow }: { entries: InProgressEntry[]; actions: Actions; issueRow: IssueRowProps }) {
  return (
    <CardList>
      {entries.map((entry, index) =>
        entry.kind === "draft" ? (
          <ItemRow key={entry.item.key} item={entry.item} first={index === 0} actions={actions} />
        ) : entry.started.issue ? (
          // Next up's card, so its sheet keeps Unclaim and Close issue; it's mine to unclaim once assigned [NXT-07].
          <IssueRow key={entry.started.key} issue={entry.started.issue} claim={!entry.started.assigned} first={index === 0} {...issueRow} />
        ) : (
          <PlainIssueRow key={entry.started.key} started={entry.started} first={index === 0} login={issueRow.login} fetchDetails={issueRow.fetchDetails} onOpenAgent={issueRow.onOpenAgent} />
        ),
      )}
    </CardList>
  );
}

// An issue Next up doesn't know, assigned to someone else or outside where it looks: what its session says, until a PR
// that closes it gives it a full card. Like every card, › and a tap open its sheet [ATT-06, SES-11].
function PlainIssueRow({ started, first, login, fetchDetails, onOpenAgent }: { started: StartedIssue; first: boolean } & Pick<IssueRowProps, "login" | "fetchDetails" | "onOpenAgent">) {
  const [sheet, setSheet] = useState(false);
  const session = started.sessions[0];
  const title = session.title ?? `Issue #${started.number}`;
  const open = () => setSheet(true);
  const prefetch = usePrefetchOnRest(issueDetailsQuery(started, fetchDetails));
  return (
    <CardRow
      first={first}
      mark={{ icon: "issue", tone: "neutral" }}
      title={title}
      meta={{ place: { repo: started.repo, number: started.number, login }, signals: [sessionSignal(session)] }}
      onOpen={open}
      hover={prefetch}
      primary={{ label: "Open session", icon: "agent", onPress: () => onOpenAgent(session.id) }}
      secondary={[{ label: `Details for #${started.number}`, icon: "chevronRight", onPress: open }]}
      overlay={sheet ? <PlainIssueSheet started={started} title={title} fetchDetails={fetchDetails} onOpenAgent={onOpenAgent} onClose={() => setSheet(false)} /> : null}
    />
  );
}

// Its sessions, then the issue on GitHub, then what the sheet fetches [ATT-06, SES-03].
function PlainIssueSheet({ started, title, fetchDetails, onOpenAgent, onClose }: { started: StartedIssue; title: string; onClose: () => void } & Pick<IssueRowProps, "fetchDetails" | "onOpenAgent">) {
  const details = useQuery({ ...issueDetailsQuery(started, fetchDetails), staleTime: DETAILS_STALE_MS });
  const close = (then: () => void) => () => (onClose(), then());
  const url = `https://github.com/${started.repo}/issues/${started.number}`;
  const entries: SheetEntry[] = [
    ...started.sessions.map((agent) => sessionEntry(agent, "Continue session", (agentId) => close(() => onOpenAgent(agentId))())),
    githubEntry({ kind: "issue", repo: started.repo, number: started.number, url }, (link) => close(() => void openExternalUrl(link))()),
  ];
  return (
    <ActionSheet
      title={title}
      onClose={onClose}
      top={<Meta lead={<PlaceText place={{ repo: started.repo, number: started.number, login: null }} />} facts={[]} chips={[]} />}
      entries={entries}
      bottom={<DetailLines details={details.data} loading={details.isLoading} error={details.error} linkedLabel="PR" expected={0} />}
    />
  );
}
