import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { HistoryFilter, Item } from "../shared/attention";
import { allNotesBusy } from "../shared/got-it";
import { historyWeeks, oldestWeek, weekOf } from "../shared/history-report";
import type { IconName } from "./icons";
import { FilterSheet } from "./sheet";
import { Still } from "./still";
import { Button, FilterButton, SectionHeader, TablerIcon, useCopy, useStyles } from "./ui";

// History: what others did to my work, unread, on top until Got it or an archive; then what I finished, by week, with
// Reviewed and cleared changes when the filter shows them [HIS-01, HIS-02, HIS-06, HIS-07]. A week copies what's shown as
// Markdown lists, per kind; changes by others are never copied [HIS-03]. Which items go where is shared/history-report.ts.

function weekLabel(monday: Date): string {
  const weeks = Math.round((weekOf(new Date().toISOString()).getTime() - monday.getTime()) / (7 * 86_400_000));
  if (weeks === 0) return "This week";
  if (weeks === 1) return "Last week";
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const format = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${format(monday)} – ${format(sunday)}`;
}

export function History({
  weekCount,
  notes,
  calm,
  items,
  filter,
  filtering,
  onFiltering,
  onFilter,
  busy,
  onMarkAllRead,
  card,
}: {
  // How many weeks History shows, `historyWeeks` in config.json [HIS-01].
  weekCount: number;
  // Nothing finished and nothing unread, after a refresh that worked [HIS-08].
  calm: boolean;
  notes: Item[];
  items: Item[];
  filter: HistoryFilter[];
  filtering: boolean;
  onFiltering: (open: boolean) => void;
  onFilter: (filter: HistoryFilter[]) => void;
  busy: ReadonlySet<string>;
  onMarkAllRead: (notes: Item[]) => void;
  // The screen's cards, with their actions and sheets.
  card: (items: Item[]) => ReactNode;
}) {
  const styles = useStyles();
  const copy = useCopy();
  const { weeks, anything } = historyWeeks(items, filter, oldestWeek(weekCount));
  if (calm) return <Still shore="bench" title="Nothing finished yet." line="Your accomplishments will show up here." />;
  if (notes.length === 0 && !anything) return <Text style={styles.text}>Nothing finished in this period.</Text>;
  return (
    <>
      {notes.length > 0 ? (
        <View>
          <SectionHeader
            icon="team"
            title="Changed by others"
            count={notes.length}
            action={
              notes.length > 1 ? (
                <View style={styles.overCard}>
                  <Button
                    label="Mark all as read"
                    icon="check"
                    variant="ghost"
                    disabled={allNotesBusy(busy, notes.map((item) => item.key))}
                    onPress={() => onMarkAllRead(notes)}
                  />
                </View>
              ) : null
            }
          />
          {card(notes)}
        </View>
      ) : null}
      {/* Filter shows whenever a week holds anything, even only what the filter hides, so it can be turned on [HIS-07]. */}
      {anything ? (
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <FilterButton count={filter.length} onPress={() => onFiltering(true)} />
        </View>
      ) : null}
      {anything && weeks.length === 0 ? <Text style={styles.text}>Nothing finished in this period.</Text> : null}
      {weeks.map((week) => {
        const label = weekLabel(week.monday);
        const { links } = week.copy;
        return (
          <View key={week.monday.getTime()} style={{ gap: 8 }}>
            <SectionHeader
              icon="clock"
              title={label}
              count={week.done.length}
              action={
                links > 0 ? (
                  <View style={styles.overCard}>
                    <Button
                      icon="markdown"
                      variant="ghost"
                      accessibilityLabel={`Copy links from ${label}`}
                      onPress={() => copy(week.copy.text, `Copied ${links} link${links === 1 ? "" : "s"} from ${label}`)}
                    />
                  </View>
                ) : null
              }
            />
            {week.done.length > 0 ? card(week.done) : null}
            {week.reviewed.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Subgroup icon="review" label="Reviewed" count={week.reviewed.length} />
                {card(week.reviewed)}
              </View>
            ) : null}
            {week.changed.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Subgroup icon="team" label="Changed by others" count={week.changed.length} />
                {card(week.changed)}
              </View>
            ) : null}
          </View>
        );
      })}
      {filtering ? <HistoryFilterSheet filter={filter} onChange={onFilter} onClose={() => onFiltering(false)} /> : null}
    </>
  );
}

// A quiet name for a week's second list, like Reviewed or its cleared changes [HIS-02, HIS-07].
function Subgroup({ icon, label, count }: { icon: IconName; label: string; count: number }) {
  const styles = useStyles();
  return (
    <View style={[styles.row, { gap: 6, paddingVertical: 2 }]}>
      <TablerIcon name={icon} size={13} />
      <Text style={styles.muted}>
        {label} · {count}
      </Text>
    </View>
  );
}

// History's filter: Finished always, plus Reviewed and cleared Changed by others per week [HIS-07].
function HistoryFilterSheet({ filter, onChange, onClose }: { filter: HistoryFilter[]; onChange: (filter: HistoryFilter[]) => void; onClose: () => void }) {
  const flip = (id: string) => onChange(filter.includes(id as HistoryFilter) ? filter.filter((other) => other !== id) : [...filter, id as HistoryFilter]);
  const options = [
    { id: "finished", label: "Finished", state: "on" as const, disabled: true, note: "always" },
    { id: "reviewed", label: "Reviewed" },
    { id: "changed", label: "Changed by others" },
  ];
  return <FilterSheet groups={[{ kind: "history", title: "Show in each week", options, active: filter }]} onToggle={(_, id) => flip(id)} onClear={() => onChange([])} onClose={onClose} />;
}
