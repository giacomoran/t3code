import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  snoozeUntilSettledActionLabel,
  snoozeUntilSettledLimitHint,
  toggleSnoozeUntilSettledSelection,
  type SnoozeCandidateStatusFilter,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type ProjectId,
  type ThreadId,
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
      onFinish={(threadIds) => finishSnoozeUntilSettledRequest(request.id, threadIds)}
    />
  );
}

function SnoozeUntilSettledSheet(props: {
  readonly request: SnoozeUntilSettledRequest;
  readonly onFinish: (threadIds: ReadonlyArray<ThreadId> | null) => void;
}) {
  const { environmentId, excludeThreadIds } = props.request;
  const gt = useGT();
  const messages = useMessages();
  const threads = useNavigationThreadShells();
  const projects = useProjects();
  const connected = useAtomValue(connectedEnvironmentIdsAtom).includes(environmentId);
  const searchInputRef = useRef<TextInputInstance>(null);
  const [nowMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [status, setStatus] = useState<SnoozeCandidateStatusFilter>("all");
  const [selectedThreadIds, setSelectedThreadIds] = useState<ReadonlyArray<ThreadId>>([]);

  // Message hits come from the server's thread search, as in the thread list.
  const threadSearch = useThreadSearch(
    connected ? [environmentId] : [],
    query,
    projectId === null ? {} : { projectIds: [projectId] },
  );
  const messageMatchThreadIds = new Set(
    threadSearch.matches
      .filter((match) => match.environmentId === environmentId)
      .map((match) => match.threadId),
  );
  const picker = resolveSnoozeUntilSettledPicker({
    threads,
    projects,
    environmentId,
    excludeThreadIds,
    selectedThreadIds,
    query,
    messageMatchThreadIds,
    projectId,
    status,
    nowMs,
    resolve: messages,
  });
  const selectedCount = picker.selectedThreads.length;
  const selectedProject = picker.projectOptions.find((project) => project.id === projectId);

  const toggle = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    setSelectedThreadIds((current) => toggleSnoozeUntilSettledSelection(current, threadId));
  };
  const confirm = () => {
    if (selectedCount === 0) return;
    props.onFinish(picker.selectedThreads.map((thread) => thread.id));
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
                  selectedThreadIds.length >= THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS
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
                <ListFilterMenu
                  label={selectedProject?.title ?? gt("All projects")}
                  accessibilityLabel={gt("Filter threads by project")}
                  active={selectedProject !== undefined}
                  actions={[
                    {
                      id: "all",
                      title: gt("All projects"),
                      state: projectId === null ? "on" : "off",
                    },
                    ...picker.projectOptions.map((project) => ({
                      id: JSON.stringify(project.id),
                      title: project.title,
                      state: project.id === projectId ? ("on" as const) : ("off" as const),
                    })),
                  ]}
                  onSelect={(id) => {
                    const project = picker.projectOptions.find(
                      (option) => JSON.stringify(option.id) === id,
                    );
                    setProjectId(project === undefined ? null : project.id);
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
                      key={thread.id}
                      size="small"
                      label={thread.title}
                      trailingIcon="xmark"
                      accessibilityLabel={gt("Remove {title}", { title: thread.title })}
                      onPress={() => toggle(thread.id)}
                    />
                  ))}
                </ScrollView>
              ) : null}
              <View className="flex-1">
                {picker.emptyState === "no-candidates" ? (
                  <EmptyState
                    variant="plain"
                    title={gt("Nothing to wait on")}
                    detail={gt("Every other thread here is already settled or archived.")}
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
                    keyExtractor={(row) => row.thread.id}
                    extraData={selectedThreadIds}
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
                        onPress={() => toggle(item.thread.id)}
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
