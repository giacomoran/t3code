import type { OrchestrationV2ServerCommand, RunId } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../Orchestrator.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import * as QuotaReserve from "./QuotaReserve.ts";

const RESERVE_CONTINUATION_MESSAGE =
  "Continue from where you stopped. I authorize using the quota reserve for this thread until the current five-hour window resets.";

function rejectReserveCommand(
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
) {
  return new Orchestrator.OrchestratorDispatchError({
    commandId: command.commandId,
    commandType: command.type,
    cause: "Quota reserve is not enabled for this provider instance.",
  });
}

export function decorate(
  threads: ThreadManagementService.ThreadManagementServiceShape,
  reserve: QuotaReserve.QuotaReserveShape,
): ThreadManagementService.ThreadManagementServiceShape {
  const dispatch: ThreadManagementService.ThreadManagementServiceShape["dispatch"] = Effect.fn(
    "quotaReserve.threadManagement.dispatch",
  )(function* (command) {
    if (command.type !== "message.dispatch") return yield* threads.dispatch(command);

    if (command.text.trim() === "/reserve" && command.attachments.length === 0) {
      const { thread } = yield* threads.getThreadRecords(command.threadId, []);
      if (!(yield* reserve.isEnabled(thread.providerInstanceId))) {
        return yield* rejectReserveCommand(command);
      }
      if (!(yield* reserve.authorize(command.threadId, thread.providerInstanceId))) {
        return yield* rejectReserveCommand(command);
      }
      return yield* threads.dispatch({
        ...command,
        text: RESERVE_CONTINUATION_MESSAGE,
      });
    }

    const continuationRunIds: ReadonlyArray<RunId> = [
      ...(command.manualContinuationOfRunId === undefined
        ? []
        : [command.manualContinuationOfRunId]),
      ...(command.usageLimitContinuationOfRunId === undefined
        ? []
        : [command.usageLimitContinuationOfRunId]),
    ];
    if (continuationRunIds.length > 0) {
      const projection = yield* threads.getThreadRecords(command.threadId, ["runs", "turnItems"], {
        runIds: continuationRunIds,
        turnItemRunIds: continuationRunIds,
        turnItemTypes: ["error"],
      });
      for (const continuationRunId of continuationRunIds) {
        const run = projection.runs.find((candidate) => candidate.id === continuationRunId);
        if (run === undefined) continue;
        const failure = latestRootProviderFailure(run, projection.turnItems);
        if (failure?.code !== "quota_reserve" || failure.resetAt == null) continue;
        // Only the stopped window: continuing after its reset must not unlock the next one.
        yield* reserve.authorize(command.threadId, run.providerInstanceId, failure.resetAt);
      }
    }

    return yield* threads.dispatch(command);
  });

  return ThreadManagementService.ThreadManagementService.of({ ...threads, dispatch });
}

export const layer: Layer.Layer<
  ThreadManagementService.ThreadManagementService,
  never,
  ThreadManagementService.ThreadManagementService
> = Layer.effect(
  ThreadManagementService.ThreadManagementService,
  Effect.gen(function* () {
    return decorate(
      yield* ThreadManagementService.ThreadManagementService,
      yield* QuotaReserve.QuotaReserve,
    );
  }),
);
