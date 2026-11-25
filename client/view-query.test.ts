import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AttentionView } from "../shared/attention";
import { viewMeta } from "../shared/test-builders";
import { VIEW_QUERY_KEY, viewQuery } from "./view-query";

const view = (revision: number) => ({ ...viewMeta(), revision }) as unknown as AttentionView;

describe("the cached view", () => {
  it("FRESH-04: a poll that began before an action and lands after it doesn't undo the action's view", async () => {
    const client = new QueryClient();
    let answer!: (view: AttentionView) => void;
    const poll = client.fetchQuery(viewQuery(() => new Promise<AttentionView>((resolve) => (answer = resolve))));
    // The action finishes first, with the server's view after it.
    client.setQueryData(VIEW_QUERY_KEY, view(5));
    answer(view(4));
    await poll;
    expect(client.getQueryData<AttentionView>(VIEW_QUERY_KEY)?.revision).toBe(5);
    await client.fetchQuery({ ...viewQuery(async () => view(6)), staleTime: 0 });
    expect(client.getQueryData<AttentionView>(VIEW_QUERY_KEY)?.revision).toBe(6);
  });
});
