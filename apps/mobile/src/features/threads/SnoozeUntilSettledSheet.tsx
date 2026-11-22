import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  snoozeUntilSettledActionLabel,
  snoozeUntilSettledLimitHint,
  toggleSnoozeUntilSettledSelection,
  type SnoozeCandidateStatusFilter,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Modal, Platform, ScrollView, View, type TextInputInstance } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { SearchField } from "../../components/ui/SearchField";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useNavigationThreadShells, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useThreadSearch } from "../../state/queries";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import {
  finishSnoozeUntilSettledRequest,
  snoozeUntilSettledRequestAtom,
  type SnoozeUntilSettledRequest,
} from "./snooze-until-settled-request";
import {
  resolveSnoozeUntilSettledPicker,
  SNOOZE_UNTIL_SETTLED_STATUS_FILTERS,
} from "./snoozeUntilSettledPicker";

export function SnoozeUntilSettledHost() {
  const request = useAtomValue(snoozeUntilSettledRequestAtom);
  if (request === null) return null;
  return (
    <SnoozeUntilSettledSheet
      key={request.id}
      request={request}
      onFinish={(picks) => finishSnoozeUntilSettledRequest(request.id, picks)}
    />
  );
}

function refOf(thread: EnvironmentThreadShell): ScopedThreadRef {
  return { environmentId: thread.environmentId, threadId: thread.id };
}

function SnoozeUntilSettledSheet(props: {
  readonly request: SnoozeUntilSettledRequest;
  readonly onFinish: (picks: ReadonlyArray<ScopedThreadRef> | null) => void;
}) {
  const { environmentId, excludeThreadIds } = props.request;
  const gt = useGT();
  const messages = useMessages();
  const threads = useNavigationThreadShells();
  const projects = useProjects();
  const connectedEnvironmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  const searchInputRef = useRef<TextInputInstance>(null);
  const [nowMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [environmentFilter, setEnvironmentFilter] = useState<EnvironmentId | null>(null);
  const [project, setProject] = useState<ScopedProjectRef | null>(null);
  const [status, setStatus] = useState<SnoozeCandidateStatusFilter>("all");
  const [selected, setSelected] = useState<ReadonlyArray<ScopedThreadRef>>([]);

  // Threads of machines the snoozed thread's server links to can be picked too, when that
  // server can wait on them and this device is connected to them.
  const { environments } = useEnvironments();
  const supportsLinked =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.threadSnoozeUntilSettledLinked === true;
  const linkedEnvironments = useLinkedEnvironments(supportsLinked ? environmentId : null);
  const environmentIds = [
    environmentId,
    ...connectedEnvironmentIds.filter(
      (candidate) => candidate !== environmentId && linkedEnvironments.has(candidate),
    ),
  ];
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );

  // Message hits come from the servers' thread search, as in the thread list.
  const searchEnvironmentIds = (
    project !== null
      ? [project.environmentId]
      : environmentFilter !== null
        ? [environmentFilter]
        : environmentIds
  ).filter((candidate) => connectedEnvironmentIds.includes(candidate));
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    query,
    project === null ? {} : { projectIds: [project.projectId] },
  );
  const messageMatchThreadKeys = new Set(
    threadSearch.matches.map((match) => `${match.environmentId}:${match.threadId}`),
  );
  const picker = resolveSnoozeUntilSettledPicker({
    threads,
    projects,
    environmentId,
    environmentIds,
    environmentLabelById,
    excludeThreadIds,
    selected,
    query,
    messageMatchThreadKeys,
    environmentFilter,
    project,
    status,
    nowMs,
    resolve: messages,
  });
  const selectedCount = picker.selectedThreads.length;
  const projectKey = (ref: ScopedProjectRef) => JSON.stringify([ref.environmentId, ref.projectId]);
  const selectedProject =
    project === null
      ? undefined
      : picker.projectOptions.find((option) => projectKey(option.project) === projectKey(project));
  const selectedEnvironment = picker.environmentOptions.find(
    (option) => option.environmentId === environmentFilter,
  );

  const toggle = (ref: ScopedThreadRef) => {
    void Haptics.selectionAsync();
    setSelected((current) => toggleSnoozeUntilSettledSelection(current, ref));
  };
  const confirm = () => {
    if (selectedCount === 0) return;
    props.onFinish(picker.selectedThreads.map(refOf));
  };
  const cancel = () => props.onFinish(null);

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={cancel}>
      {/* A Modal is its own native hierarchy, so it measures its own safe area. */}
      <SafeAreaProvider style={{ flex: 1 }}>
        <View className="flex-1 bg-screen">
          <SafeAreaView style={{ flex: 1 }}>
            <KeyboardAvoidingView behavior="padding" className="flex-1">
              <SheetHeader
                presentation="inline"
                title={gt("Snooze until threads settle")}
                subtitle={
                  selected.length >= THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS
                    ? snoozeUntilSettledLimitHint(messages)
                    : selectedCount === 0
                      ? gt("Wakes when every picked thread settles")
                      : gt("{count} selected", { count: selectedCount })
                }
                onCancel={cancel}
                accessibilityLabel={gt("Cancel snooze until threads settle")}
              />
              <View className="flex-row px-5 pb-2">
                <SearchField
                  inputRef={searchInputRef}
                  autoFocus={false}
                  accessibilityLabel={gt("Search threads")}
                  clearAccessibilityLabel={gt("Clear thread search")}
                  placeholder={gt("Search titles, projects, and messages")}
                  value={query}
                  onChangeText={setQuery}
                />
              </View>
              <ScrollView
                horizontal
                keyboardShouldPersistTaps="handled"
                showsHorizontalScrollIndicator={false}
                className="grow-0"
                contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 6, gap: 8 }}
              >
                {picker.environmentOptions.length > 0 ? (
                  <ListFilterMenu
                    label={selectedEnvironment?.label ?? gt("All machines")}
                    accessibilityLabel={gt("Filter threads by machine")}
                    active={selectedEnvironment !== undefined}
                    actions={[
                      {
                        id: "all",
                        title: gt("All machines"),
                        state: environmentFilter === null ? "on" : "off",
                      },
                      ...picker.environmentOptions.map((option) => ({
                        id: JSON.stringify(option.environmentId),
                        title: option.label,
                        state:
                          option.environmentId === environmentFilter
                            ? ("on" as const)
                            : ("off" as const),
                      })),
                    ]}
                    onSelect={(id) => {
                      const option = picker.environmentOptions.find(
                        (candidate) => JSON.stringify(candidate.environmentId) === id,
                      );
                      setEnvironmentFilter(option === undefined ? null : option.environmentId);
                      setProject(null);
                    }}
                  />
                ) : null}
                <ListFilterMenu
                  label={selectedProject?.title ?? gt("All projects")}
                  accessibilityLabel={gt("Filter threads by project")}
                  active={selectedProject !== undefined}
                  actions={[
                    {
                      id: "all",
                      title: gt("All projects"),
                      state: project === null ? "on" : "off",
                    },
                    ...picker.projectOptions.map((option) => ({
                      id: projectKey(option.project),
                      title: option.title,
                      state: option === selectedProject ? ("on" as const) : ("off" as const),
                    })),
                  ]}
                  onSelect={(id) => {
                    const option = picker.projectOptions.find(
                      (candidate) => projectKey(candidate.project) === id,
                    );
                    setProject(option === undefined ? null : option.project);
                  }}
                />
                {SNOOZE_UNTIL_SETTLED_STATUS_FILTERS.map((filter) => (
                  <Chip
                    key={filter.value}
                    label={messages(filter.label)}
                    accessibilityLabel={gt("Show {status} threads", {
                      status: messages(filter.label).toLowerCase(),
                    })}
                    selected={status === filter.value}
                    onPress={() => setStatus(filter.value)}
                  />
                ))}
              </ScrollView>
              {selectedCount > 0 ? (
                <ScrollView
                  horizontal
                  keyboardShouldPersistTaps="handled"
                  showsHorizontalScrollIndicator={false}
                  className="grow-0"
                  contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 6, gap: 8 }}
                >
                  {picker.selectedThreads.map((thread) => (
                    <Chip
                      key={`${thread.environmentId}:${thread.id}`}
                      size="small"
                      label={thread.title}
                      trailingIcon="xmark"
                      accessibilityLabel={gt("Remove {title}", { title: thread.title })}
                      onPress={() => toggle(refOf(thread))}
                    />
                  ))}
                </ScrollView>
              ) : null}
              <View className="flex-1">
                {picker.emptyState === "no-candidates" ? (
                  <EmptyState
                    variant="plain"
                    title={gt("Nothing to wait on")}
                    detail={
                      picker.environmentOptions.length > 0
                        ? gt("Every other thread is already settled or archived.")
                        : gt("Every other thread here is already settled or archived.")
                    }
                  />
                ) : picker.emptyState === "no-matches" ? (
                  <EmptyState
                    variant="plain"
                    title={gt("No matching threads")}
                    detail={gt("Try another search or filter.")}
                  />
                ) : (
                  // oxlint-disable-next-line t3code/require-registered-list-scroll -- A full-screen Modal with an inline header; there is no navigation header to register with.
                  <LegendList
                    data={picker.rows}
                    keyExtractor={(row) => `${row.thread.environmentId}:${row.thread.id}`}
                    extraData={selected}
                    estimatedItemSize={64}
                    recycleItems
                    className="flex-1"
                    keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{
                      paddingHorizontal: 16,
                      paddingTop: 8,
                      paddingBottom: 16,
                    }}
                    renderItem={({ item, index }) => (
                      <SelectionRow
                        role="checkbox"
                        title={item.thread.title}
                        subtitle={item.subtitle}
                        selected={item.selected}
                        isFirst={index === 0}
                        isLast={index === picker.rows.length - 1}
                        onPress={() => toggle(refOf(item.thread))}
                      />
                    )}
                  />
                )}
              </View>
              <View className="px-5 pt-2 pb-3">
                <Button
                  tone="primary"
                  fullWidth
                  label={
                    selectedCount === 0
                      ? gt("Pick threads to wait on")
                      : snoozeUntilSettledActionLabel(selectedCount, messages)
                  }
                  disabled={selectedCount === 0}
                  onPress={confirm}
                />
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}
