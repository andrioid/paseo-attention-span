import { openExternalUrl } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { SubRow } from "../shared/attention";
import { stackMark } from "./mark";
import { githubColor, NumberText } from "./entity";
import { Meta, TablerIcon, tint, toneColor, useHover, useStyles } from "./ui";

// Stacked or linked PRs as a connected line; collapsed, only those needing attention [ATT-03, ATT-04].
// In the sheet each row opens its PR on GitHub [ATT-12], and the PR an issue's actions apply to is tinted and says so [ATT-06].
export function StackLine({ rows, links = false, target }: { rows: SubRow[]; links?: boolean; target?: string }) {
  const styles = useStyles();
  return (
    <View>
      {rows.map((row, index) => {
        const mark = stackMark(row);
        const merged = mark.icon === "merge";
        return (
          <StackRow key={row.key} url={row.url} number={row.number} link={links} target={row.key === target}>
            <View style={{ width: 16, alignItems: "center" }}>
              <View style={{ width: 2, flex: 1, backgroundColor: index === 0 ? "transparent" : styles.c.border }} />
              <TablerIcon name={mark.icon} size={14} color={githubColor(styles, mark.color) ?? toneColor(styles, mark.tone)} />
              <View style={{ width: 2, flex: 1, backgroundColor: index === rows.length - 1 ? "transparent" : styles.c.border }} />
            </View>
            <View style={{ flex: 1, paddingVertical: 3, gap: 2 }}>
              <Text style={{ color: styles.c.foreground, fontSize: 13 }} numberOfLines={1}>
                {row.title}
              </Text>
              <View style={[styles.wrap, { columnGap: 10, rowGap: 2 }]}>
                <Meta lead={<NumberText number={row.number} />} facts={merged && row.mergedBy ? [`merged by ${row.mergedBy}`] : []} chips={row.chips} />
                {row.key === target ? <Text style={{ color: styles.action, fontSize: 12, fontWeight: "600" }}>actions apply here</Text> : null}
              </View>
            </View>
            {links ? (
              <View style={{ justifyContent: "center", paddingHorizontal: 4 }}>
                <TablerIcon name="github" size={14} color={styles.c.foregroundMuted} />
              </View>
            ) : null}
          </StackRow>
        );
      })}
    </View>
  );
}

function StackRow({ url, number, link, target = false, children }: { url: string; number: number; link: boolean; target?: boolean; children: ReactNode }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const tinted = target ? { backgroundColor: tint(styles.action, 0.1), borderRadius: 6 } : null;
  if (!link) return <View style={[styles.row, { alignItems: "stretch" }, tinted]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open PR #${number} on GitHub`}
      onPress={() => void openExternalUrl(url)}
      {...hover}
      style={({ pressed }) => [styles.row, { alignItems: "stretch", borderRadius: 6, backgroundColor: pressed || hovered ? styles.c.surface2 : target ? tint(styles.action, 0.1) : "transparent" }]}
    >
      {children}
    </Pressable>
  );
}
