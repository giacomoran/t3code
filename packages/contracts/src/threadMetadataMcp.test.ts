import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);
const decodeUpdateResult = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateResult);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("accepts muting updates and older metadata mutation replies", () => {
    for (const action of ["mute_notifications", "unmute_notifications"]) {
      assert.equal(decodeUpdate({ action }).action, action);
      assert.throws(() => decodeUpdate({ action, title: "Unrelated rename" }));
    }
    const legacyResult = decodeUpdateResult({
      threadId: "thread:legacy",
      action: "rename",
      commandId: "command:legacy-rename",
      sequence: 1,
      title: "Renamed thread",
      titleRegeneration: null,
      linkedPullRequest: null,
      updatedAt: "2026-11-09T12:00:00Z",
    });
    assert.equal(legacyResult.notificationsMuted, undefined);
  });
  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });
});
