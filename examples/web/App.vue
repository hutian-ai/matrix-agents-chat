<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

const rooms = ref([]);
const roomId = ref("");
const room = ref(null);
const members = ref([]);
const agentCatalog = ref([]);
const roomAgents = ref([]);
const selectedAgentId = ref("");
const messages = ref([]);
const jobs = ref([]);
const active = ref(null);
const selectedId = ref("");
const timeline = ref(null);
const connected = ref(false);
const loaded = ref(false);
const sending = ref(false);
const acting = ref(false);
const notice = ref("");
const pending = ref(null);
const draft = ref("");
const replyTargetId = ref("");
const roomDialog = ref(null);
const roomNameInput = ref(null);
const newRoomName = ref("");
const newRoomAgents = ref([]);
const memberDialog = ref(null);
const inviting = ref("");
const memberNotice = ref("");
const creating = ref(false);
const createNotice = ref("");
const pendingRoom = ref(null);
try {
  const saved = JSON.parse(
    sessionStorage.getItem("chat:create-room") || "null",
  );
  if (
    typeof saved?.name === "string" &&
    typeof saved?.transactionId === "string"
  ) {
    pendingRoom.value = saved;
    newRoomName.value = saved.name;
    newRoomAgents.value = saved.agentIds || [];
  }
} catch {
  sessionStorage.removeItem("chat:create-room");
}
let changingRoom = false;
function saveRoom() {
  if (!roomId.value || changingRoom) return;
  sessionStorage.setItem(
    `chat:room:${roomId.value}`,
    JSON.stringify({
      draft: draft.value,
      replyTargetId: replyTargetId.value,
      selectedId: selectedId.value,
      selectedAgentId: selectedAgentId.value,
      pending: pending.value,
    }),
  );
}
watch([draft, replyTargetId, selectedId, selectedAgentId, pending], saveRoom, {
  flush: "sync",
});
const selected = computed(() =>
  messages.value.find(
    (message) => message.id === selectedId.value && message.sender === "human",
  ),
);
const joinedAgents = computed(() =>
  roomAgents.value.filter((agent) => agent.joined),
);
const runnableAgents = computed(() =>
  joinedAgents.value.filter((agent) => agent.executable),
);
const selectedAgent = computed(() =>
  joinedAgents.value.find(
    (agent) => agent.id === selectedAgentId.value && agent.executable,
  ),
);
const job = computed(() =>
  jobs.value.find(
    (value) =>
      value.eventId === selectedId.value &&
      value.agentId === selectedAgentId.value,
  ),
);
const state = computed(() => job.value?.state || "idle");
const labels = {
  idle: "尚未执行",
  running: "正在处理",
  completed: "等待收取回复",
  replied: "已回复",
  unknown: "结果待核对",
  failed: "运行未完成",
  cancelled: "原任务已结束",
};
const stateLabel = computed(() => labels[state.value] || "结果待核对");
const canRun = computed(
  () =>
    selected.value &&
    selectedAgent.value &&
    !acting.value &&
    !active.value &&
    state.value !== "replied" &&
    (!job.value?.runId || job.value.hasReceipt),
);
const actionLabel = computed(() =>
  state.value === "replied"
    ? "已收到回复"
    : (active.value?.roomId === roomId.value &&
          active.value.eventId === selectedId.value &&
          active.value.agentId === selectedAgentId.value) ||
        acting.value
      ? "助手正在处理…"
      : job.value?.runId
        ? state.value === "completed"
          ? "收取原任务回复"
          : "核对原任务"
        : "让所选助手回复",
);
const activeRoomName = computed(
  () =>
    rooms.value.find((value) => value.id === active.value?.roomId)?.name ||
    "其他房间",
);
const memberHint = (member) =>
  member.kind === "human"
    ? "发送消息，协调协作"
    : member.kind === "agent"
      ? agentCatalog.value.find((agent) => agent.userId === member.id)
          ?.executable
        ? "选择消息后按需回复"
        : "通过外部应用回复"
      : "已加入房间";
const agentName = (id) =>
  agentCatalog.value.find((agent) => agent.id === id)?.name || "助手";
const times = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dates = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "long",
});
const messageById = computed(
  () => new Map(messages.value.map((message) => [message.id, message])),
);
const replyTarget = computed(() => messageById.value.get(replyTargetId.value));
const time = (value) => times.format(new Date(value));
const day = (value) => dates.format(new Date(value));
const replyText = (message) =>
  messageById.value.get(message.replyTo)?.text || "一条较早的消息";
const statusFor = (id) =>
  jobs.value
    .filter((value) => value.eventId === id)
    .map(
      (value) =>
        `${agentName(value.agentId)}：${labels[value.state] || "结果待核对"}`,
    )
    .join(" · ");

async function api(path, body) {
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作暂未完成，请稍后重试。");
  return data;
}

let generation = 0;
let refreshingGeneration = -1;
let timer;
const resumedAt = new Map();
async function switchRoom(id) {
  if (
    !id ||
    !rooms.value.some((value) => value.id === id) ||
    roomId.value === id
  )
    return;
  saveRoom();
  changingRoom = true;
  generation++;
  roomId.value = id;
  sessionStorage.setItem("chat:room", id);
  room.value = rooms.value.find((value) => value.id === id);
  messages.value = [];
  jobs.value = [];
  members.value = [];
  roomAgents.value = [];
  loaded.value = false;
  connected.value = false;
  notice.value = "";
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(`chat:room:${id}`) || "{}") || {};
  } catch {
    /* 忽略损坏的浏览器草稿。 */
  }
  pending.value =
    typeof saved.pending?.text === "string" &&
    typeof saved.pending?.transactionId === "string"
      ? saved.pending
      : null;
  draft.value =
    pending.value?.text || (typeof saved.draft === "string" ? saved.draft : "");
  replyTargetId.value =
    pending.value?.replyTo ||
    (typeof saved.replyTargetId === "string" ? saved.replyTargetId : "");
  selectedId.value =
    typeof saved.selectedId === "string" ? saved.selectedId : "";
  selectedAgentId.value =
    typeof saved.selectedAgentId === "string" ? saved.selectedAgentId : "";
  changingRoom = false;
  await refresh();
}

let loadingRooms = false;
async function refreshRooms() {
  if (loadingRooms) return;
  loadingRooms = true;
  try {
    const data = await api("/api/rooms");
    rooms.value = data.rooms;
    agentCatalog.value = data.agents;
    if (!rooms.value.some((value) => value.id === roomId.value)) {
      const saved = sessionStorage.getItem("chat:room");
      const next =
        rooms.value.find((value) => value.id === saved)?.id ||
        rooms.value.find((value) => value.id === data.defaultRoomId)?.id ||
        rooms.value[0]?.id;
      if (next) await switchRoom(next);
      else {
        saveRoom();
        generation++;
        roomId.value = "";
        room.value = null;
        messages.value = [];
        jobs.value = [];
        members.value = [];
        roomAgents.value = [];
        active.value = null;
        connected.value = true;
        loaded.value = true;
      }
    }
  } catch {
    connected.value = false;
  } finally {
    loadingRooms = false;
  }
}

async function refresh() {
  const id = roomId.value;
  const version = generation;
  if (!id || refreshingGeneration === version) return;
  refreshingGeneration = version;
  const current = () => generation === version && roomId.value === id;
  try {
    const stick =
      !loaded.value ||
      !timeline.value ||
      timeline.value.scrollHeight -
        timeline.value.scrollTop -
        timeline.value.clientHeight <
        120;
    const data = await api(`/api/state?roomId=${encodeURIComponent(id)}`);
    if (!current()) return;
    room.value = data.room;
    members.value = data.members;
    roomAgents.value = data.agents;
    messages.value = data.messages;
    jobs.value = data.jobs;
    active.value = data.active;
    connected.value = true;
    loaded.value = true;
    if (!selectedAgent.value)
      selectedAgentId.value =
        joinedAgents.value.find((agent) => agent.executable)?.id || "";
    if (!selected.value)
      selectedId.value =
        data.messages.findLast((message) => message.sender === "human")?.id ||
        "";
    if (stick) {
      await nextTick();
      if (current())
        timeline.value?.scrollTo({ top: timeline.value.scrollHeight });
    }
    const original = data.jobs.find(
      (value) =>
        data.agents.some(
          (agent) =>
            agent.id === value.agentId && agent.joined && agent.executable,
        ) &&
        value.runId &&
        value.hasReceipt &&
        !value.replyEventId &&
        ["unknown", "running", "completed"].includes(value.state) &&
        Date.now() -
          Math.max(
            value.checkedAt,
            resumedAt.get(`${value.agentId}/${id}/${value.eventId}`) || 0,
          ) >
          12_000,
    );
    if (current() && !data.active && !acting.value && original) {
      resumedAt.set(
        `${original.agentId}/${id}/${original.eventId}`,
        Date.now(),
      );
      void run(original.eventId, true, true, original.agentId);
    }
  } catch {
    if (current()) connected.value = false;
  } finally {
    if (refreshingGeneration === version) refreshingGeneration = -1;
  }
}

async function send() {
  if (sending.value || !draft.value.trim() || !connected.value || !roomId.value)
    return;
  const id = roomId.value;
  const version = generation;
  sending.value = true;
  notice.value = "";
  if (!pending.value)
    pending.value = {
      text: draft.value,
      transactionId: crypto.randomUUID(),
      ...(replyTargetId.value
        ? { replyTo: replyTargetId.value, agentId: selectedAgentId.value }
        : {}),
    };
  const request = pending.value;
  try {
    const sent = await api("/api/messages", { roomId: id, ...request });
    // 即使已经切到其他房间，也只更新原房间的待发送状态。
    if (roomId.value !== id) {
      const saved = JSON.parse(
        sessionStorage.getItem(`chat:room:${id}`) || "{}",
      );
      if (saved.pending?.transactionId === request.transactionId) {
        sessionStorage.setItem(
          `chat:room:${id}`,
          JSON.stringify({
            ...saved,
            draft: "",
            replyTargetId: "",
            selectedId: sent.eventId,
            pending: null,
          }),
        );
      }
      if (request.agentId)
        await run(sent.eventId, false, false, request.agentId, id);
      return;
    }
    selectedId.value = sent.eventId;
    pending.value = null;
    draft.value = "";
    replyTargetId.value = "";
    if (request.agentId)
      await run(sent.eventId, false, false, request.agentId, id);
    await refresh();
    await nextTick();
    if (generation === version)
      timeline.value?.scrollTo({
        top: timeline.value.scrollHeight,
        behavior: "smooth",
      });
  } catch (error) {
    if (roomId.value === id)
      notice.value = error.message || "发送尚未确认，请沿用当前消息重试。";
  } finally {
    sending.value = false;
  }
}

async function run(
  eventId = selectedId.value,
  resumeOnly = Boolean(job.value?.runId),
  automatic = false,
  agentId = selectedAgentId.value,
  id = roomId.value,
) {
  if (!eventId || !agentId || acting.value || active.value || !id) return;
  const version = generation;
  acting.value = true;
  if (!automatic) notice.value = "";
  try {
    await api(resumeOnly ? "/api/agent/resume" : "/api/agent", {
      roomId: id,
      eventId,
      agentId,
    });
    await refresh();
  } catch (error) {
    if (!automatic && generation === version) notice.value = error.message;
  } finally {
    acting.value = false;
  }
}

async function handoff(message) {
  if (pending.value || sending.value) return;
  const target = joinedAgents.value.find(
    (agent) => agent.id !== message.agentId && agent.executable,
  );
  if (!target) {
    notice.value = "请先邀请另一位已接入执行宿主的助手。";
    return;
  }
  selectedAgentId.value = target.id;
  replyTargetId.value = message.id;
  if (!draft.value.trim()) draft.value = "请基于这条消息给出你的建议。";
  await nextTick();
  document.querySelector("textarea")?.focus();
}

async function openCreate() {
  if (!pendingRoom.value)
    newRoomAgents.value = agentCatalog.value[0]
      ? [agentCatalog.value[0].id]
      : [];
  else if (!Array.isArray(pendingRoom.value.agentIds)) {
    pendingRoom.value.agentIds = agentCatalog.value[0]
      ? [agentCatalog.value[0].id]
      : [];
    newRoomAgents.value = pendingRoom.value.agentIds;
  }
  createNotice.value = "";
  roomDialog.value.showModal();
  await nextTick();
  roomNameInput.value?.focus();
}
async function createRoom() {
  if (creating.value || !newRoomName.value.trim()) return;
  creating.value = true;
  createNotice.value = "";
  if (!pendingRoom.value) {
    pendingRoom.value = {
      name: newRoomName.value.trim(),
      agentIds: [...newRoomAgents.value],
      transactionId: crypto.randomUUID(),
    };
    sessionStorage.setItem(
      "chat:create-room",
      JSON.stringify(pendingRoom.value),
    );
  }
  try {
    const result = await api("/api/rooms", pendingRoom.value);
    pendingRoom.value = null;
    newRoomName.value = "";
    sessionStorage.removeItem("chat:create-room");
    await refreshRooms();
    if (!rooms.value.some((value) => value.id === result.room.id))
      rooms.value.push(result.room);
    await switchRoom(result.room.id);
    roomDialog.value.close();
  } catch (error) {
    createNotice.value = `${error.message} 创建尚未确认，重试会继续原房间。`;
  } finally {
    creating.value = false;
  }
}

function openMembers() {
  if (!roomId.value || !loaded.value) return;
  memberNotice.value = "";
  memberDialog.value.showModal();
}
async function inviteAgent(agentId) {
  if (inviting.value || !roomId.value) return;
  const id = roomId.value;
  inviting.value = agentId;
  memberNotice.value = "";
  try {
    await api("/api/members", { roomId: id, agentId });
    if (roomId.value === id) await refresh();
  } catch (error) {
    memberNotice.value = `${error.message} 可重试邀请，未触发执行。`;
  } finally {
    inviting.value = "";
  }
}

onMounted(() => {
  void refreshRooms();
  let ticks = 0;
  timer = setInterval(() => {
    void refresh();
    if (++ticks % 4 === 0 || !roomId.value) void refreshRooms();
  }, 2500);
});
onUnmounted(() => {
  clearInterval(timer);
  saveRoom();
});
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Matrix Agents Chat 首页">
        <span class="brand-mark"
          ><svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 5h14v10H11l-4 4v-4H5z" /></svg
        ></span>
        <span>matrix<span class="brand-suffix"> / agents chat</span></span>
      </a>
      <div class="workspace-label">
        聊天室 <span>{{ String(rooms.length).padStart(2, "0") }}</span>
      </div>
      <nav class="room-list" aria-label="聊天室列表">
        <button
          v-for="item in rooms"
          :key="item.id"
          class="room-nav"
          :class="{ current: item.id === roomId }"
          :aria-current="item.id === roomId ? 'page' : undefined"
          @click="switchRoom(item.id)"
        >
          <span class="hash">#</span><span>{{ item.name }}</span
          ><i v-if="active?.roomId === item.id" aria-label="助手正在处理" />
        </button>
      </nav>
      <button class="create-room-button" @click="openCreate">
        <span>＋</span> 新建聊天室
      </button>
      <div class="member-section">
        <div class="workspace-label">
          房间成员 <span>{{ String(members.length).padStart(2, "0") }}</span>
        </div>
        <div v-for="member in members" :key="member.id" class="member">
          <span
            class="avatar"
            :class="member.kind === 'human' ? 'human-avatar' : 'agent-avatar'"
            >{{
              member.kind === "human"
                ? "你"
                : member.kind === "agent"
                  ? member.name.slice(0, 1)
                  : "#"
            }}</span
          >
          <div>
            <b
              >{{ member.name }}
              <small v-if="member.kind === 'agent'">AGENT</small></b
            ><span>{{ memberHint(member) }}</span>
          </div>
        </div>
        <button
          class="create-room-button"
          :disabled="!loaded || !roomId"
          @click="openMembers"
        >
          <span>＋</span> 邀请助手
        </button>
      </div>
      <div class="sidebar-bottom">
        <span class="local-dot" />本机工作区<span class="sidebar-footnote"
          >人来协调，助手来回应。</span
        >
      </div>
    </aside>

    <main class="chat">
      <header class="chat-header">
        <div class="header-title">
          <div class="eyebrow">人和 Agent 的共同频道</div>
          <h1><span>#</span> {{ room?.name || "协作聊天室" }}</h1>
        </div>
        <div class="header-actions">
          <button
            class="members-button"
            :disabled="!loaded || !roomId"
            @click="openMembers"
          >
            成员 {{ members.length }}</button
          ><span class="connection" :class="{ offline: !connected }"
            ><i />{{
              connected ? "聊天已连接" : loaded ? "重新连接中" : "正在连接"
            }}</span
          >
        </div>
      </header>
      <div class="mobile-rooms">
        <select
          aria-label="切换聊天室"
          :value="roomId"
          @change="switchRoom($event.target.value)"
        >
          <option v-if="!rooms.length" value="">暂无聊天室</option>
          <option v-for="item in rooms" :key="item.id" :value="item.id">
            # {{ item.name }}
          </option></select
        ><button @click="openCreate">＋ 新建</button>
      </div>
      <div v-if="!connected && loaded" class="connection-note" role="status">
        连接暂时中断，正在重连。已显示的消息会保留。
      </div>
      <section ref="timeline" class="timeline" aria-label="聊天消息">
        <div v-if="!loaded" class="empty">
          <span class="empty-mark">#</span>
          <h2>{{ connected ? "正在读取消息" : "正在连接聊天室" }}</h2>
          <p>消息会在这里按时间排列。</p>
          <button
            class="text-button"
            @click="roomId ? refresh() : refreshRooms()"
          >
            重新连接
          </button>
        </div>
        <div v-else-if="!messages.length" class="empty">
          <span class="empty-mark">#</span>
          <h2>{{ roomId ? "从第一条消息开始" : "创建你的第一个聊天室" }}</h2>
          <p>
            {{
              roomId
                ? "发送后，选择交给哪位助手。"
                : "创建房间时选择一起加入的助手。"
            }}
          </p>
          <button v-if="!roomId" class="primary" @click="openCreate">
            新建聊天室
          </button>
        </div>
        <template v-for="(message, index) in messages" :key="message.id">
          <div
            v-if="
              !index ||
              day(message.timestamp) !== day(messages[index - 1].timestamp)
            "
            class="date-divider"
          >
            <span>{{ day(message.timestamp) }}</span>
          </div>
          <article
            class="message-row"
            :class="{ mine: message.sender === 'human' }"
          >
            <span
              v-if="message.sender !== 'human'"
              class="avatar agent-avatar message-avatar"
              >{{
                message.sender === "agent" ? message.name.slice(0, 1) : "#"
              }}</span
            >
            <div class="message-content">
              <div class="message-meta">
                <b>{{ message.name }}</b
                ><span v-if="message.sender === 'agent'" class="agent-label"
                  >AGENT</span
                ><time>{{ time(message.timestamp) }}</time>
              </div>
              <button
                v-if="message.sender === 'human'"
                class="bubble selectable"
                :class="{ selected: selectedId === message.id }"
                :aria-pressed="selectedId === message.id"
                @click="selectedId = message.id"
              >
                <span v-if="message.replyTo" class="reply-quote">{{
                  replyText(message)
                }}</span
                ><span class="message-text">{{ message.text }}</span>
              </button>
              <div v-else class="bubble">
                <div v-if="message.replyTo" class="reply-quote">
                  {{ replyText(message) }}
                </div>
                <span class="message-text">{{ message.text }}</span>
              </div>
              <div v-if="message.sender === 'human'" class="message-actions">
                <button class="text-button" @click="selectedId = message.id">
                  {{
                    selectedId === message.id ? "已选中" : "选择这条消息"
                  }}</button
                ><span v-if="statusFor(message.id)" class="message-state">{{
                  statusFor(message.id)
                }}</span>
              </div>
              <div
                v-else-if="message.sender === 'agent'"
                class="message-actions"
              >
                <button
                  class="text-button"
                  :disabled="Boolean(pending) || sending"
                  @click="handoff(message)"
                >
                  转交给其他助手
                </button>
              </div>
            </div>
          </article>
        </template>
      </section>
      <footer class="composer-wrap">
        <div v-if="notice" class="notice" role="alert">
          <span>{{ notice }}</span
          ><button aria-label="关闭提示" @click="notice = ''">×</button>
        </div>
        <form class="composer" @submit.prevent="send">
          <div v-if="replyTargetId" class="reply-compose">
            <div>
              <b
                >交给{{
                  pending?.agentId
                    ? agentName(pending.agentId)
                    : selectedAgent?.name || "所选助手"
                }}
                · 引用{{ replyTarget?.name || "原消息" }}</b
              >
              <p>{{ replyTarget?.text || "将读取这条消息的原文" }}</p>
            </div>
            <button
              type="button"
              aria-label="取消转交"
              :disabled="Boolean(pending) || sending"
              @click="replyTargetId = ''"
            >
              ×
            </button>
          </div>
          <textarea
            v-model="draft"
            aria-label="消息正文"
            placeholder="发送一条消息…"
            maxlength="16000"
            rows="2"
            :disabled="!roomId || !loaded"
            :readonly="sending || Boolean(pending)"
            @keydown.enter.exact.meta.prevent="send"
            @keydown.enter.exact.ctrl.prevent="send"
          />
          <div class="composer-tools">
            <span>{{
              pending
                ? "发送尚未确认，重试会沿用原消息。"
                : "⌘ / Ctrl + Enter 发送"
            }}</span
            ><button
              class="primary send-button"
              :disabled="
                sending ||
                !draft.trim() ||
                !connected ||
                !roomId ||
                Boolean(replyTargetId && (!selectedAgent || active))
              "
              type="submit"
            >
              {{
                sending
                  ? "发送中…"
                  : pending
                    ? "重试发送"
                    : replyTargetId
                      ? "发送并交给助手"
                      : "发送"
              }}<span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
        <p class="composer-note">发送消息后，由你决定是否交给助手。</p>
      </footer>
    </main>

    <aside class="run-panel" aria-label="助手执行">
      <div class="run-heading">
        <span class="avatar agent-avatar">{{
          selectedAgent?.name.slice(0, 1) || "A"
        }}</span>
        <div>
          <h2>{{ selectedAgent?.name || "选择协作成员" }}</h2>
          <span>由你选择，按需执行</span>
        </div>
      </div>
      <div class="agent-picker">
        <label for="reply-agent">由谁回复</label
        ><select
          id="reply-agent"
          v-model="selectedAgentId"
          :disabled="!runnableAgents.length || Boolean(pending?.agentId)"
        >
          <option v-if="!runnableAgents.length" value="">
            {{
              joinedAgents.length ? "尚未接入执行宿主" : "先邀请助手加入房间"
            }}
          </option>
          <option
            v-for="agent in joinedAgents"
            :key="agent.id"
            :value="agent.id"
            :disabled="!agent.executable"
          >
            {{ agent.name }}{{ agent.executable ? "" : " · 外部接入" }}
          </option>
        </select>
        <p>
          {{
            selectedAgent?.description ||
            "可通过 SDK 回复，配置执行宿主后可从网页触发。"
          }}
        </p>
        <button
          v-if="!joinedAgents.length"
          class="text-button"
          @click="openMembers"
        >
          邀请助手
        </button>
      </div>
      <div
        class="run-status"
        :class="{
          passed: state === 'replied',
          processing: state === 'running',
        }"
      >
        <i />{{ stateLabel }}
      </div>
      <div class="section-label">选中的消息</div>
      <div v-if="selected" class="selected-request">
        <span>你 · {{ time(selected.timestamp) }}</span>
        <p>{{ selected.text }}</p>
      </div>
      <div v-else class="selection-placeholder">
        在聊天中选择一条你发送的消息。
      </div>
      <button
        class="primary run-button"
        :disabled="!canRun || !connected"
        @click="run()"
      >
        {{ actionLabel }}
      </button>
      <p class="cost-note">
        {{
          selectedAgent
            ? "会调用模型并使用账户额度。"
            : "配置执行宿主后，可在这里触发助手回复。"
        }}
      </p>
      <div v-if="job?.error" class="job-notice" role="status">
        {{ job.error }}
      </div>
      <p
        v-if="
          job?.runId &&
          !job.hasReceipt &&
          !['running', 'replied'].includes(state)
        "
        class="job-notice"
      >
        原运行的回执尚未确认，已保留记录，未重复派发。
      </p>
      <p
        v-if="
          active &&
          (active.roomId !== roomId ||
            active.eventId !== selectedId ||
            active.agentId !== selectedAgentId)
        "
        class="job-notice"
      >
        {{ agentName(active.agentId) }}正在{{
          active.roomId === roomId ? "当前房间" : `「${activeRoomName}」`
        }}处理消息，完成后可继续。
      </p>
      <div v-if="state === 'replied'" class="delivery-note">
        <span>✓</span>
        <div>
          <b>回复已送达</b>
          <p>在聊天中查看与原消息关联的回复。</p>
        </div>
      </div>
      <details v-if="job?.runId" class="run-details">
        <summary>运行信息</summary>
        <span>原运行 ID</span><code>{{ job.runId }}</code
        ><span>消息 ID</span><code>{{ selectedId }}</code>
      </details>
      <div class="run-footer">
        <span class="mini-line" />
        <p>页面重新打开后，会沿原记录核对任务状态。</p>
      </div>
    </aside>
    <dialog
      ref="roomDialog"
      class="room-dialog"
      aria-labelledby="create-room-title"
      @cancel="creating && $event.preventDefault()"
    >
      <form @submit.prevent="createRoom">
        <div class="dialog-heading">
          <div>
            <div class="eyebrow">一个新的共同频道</div>
            <h2 id="create-room-title">新建聊天室</h2>
          </div>
          <button
            type="button"
            aria-label="关闭新建聊天室"
            :disabled="creating"
            @click="roomDialog.close()"
          >
            ×
          </button>
        </div>
        <label for="room-name">房间名称</label
        ><input
          id="room-name"
          ref="roomNameInput"
          v-model="newRoomName"
          maxlength="80"
          placeholder="例如：产品讨论"
          autocomplete="off"
          required
          :readonly="creating || Boolean(pendingRoom)"
        />
        <fieldset
          class="agent-choices"
          :disabled="creating || Boolean(pendingRoom)"
        >
          <legend>一起加入的助手</legend>
          <label v-for="agent in agentCatalog" :key="agent.id"
            ><input
              v-model="newRoomAgents"
              type="checkbox"
              :value="agent.id"
            /><span
              ><b>{{ agent.name }}</b
              ><small>{{ agent.description }}</small></span
            ></label
          >
        </fieldset>
        <p>可选择多位助手，也可以稍后再邀请。消息与回复保存在这个房间。</p>
        <div v-if="createNotice" class="notice" role="alert">
          {{ createNotice }}
        </div>
        <button
          class="primary"
          type="submit"
          :disabled="creating || !newRoomName.trim()"
        >
          {{
            creating
              ? "正在创建…"
              : pendingRoom
                ? "继续创建原房间"
                : "创建并进入"
          }}
        </button>
      </form>
    </dialog>
    <dialog
      ref="memberDialog"
      class="room-dialog"
      aria-labelledby="members-title"
      @cancel="inviting && $event.preventDefault()"
    >
      <div class="dialog-heading">
        <div>
          <div class="eyebrow">{{ room?.name }}</div>
          <h2 id="members-title">房间成员 · {{ members.length }}</h2>
        </div>
        <button
          type="button"
          aria-label="关闭房间成员"
          :disabled="Boolean(inviting)"
          @click="memberDialog.close()"
        >
          ×
        </button>
      </div>
      <div
        v-for="member in members"
        :key="member.id"
        class="member dialog-member"
      >
        <span
          class="avatar"
          :class="member.kind === 'human' ? 'human-avatar' : 'agent-avatar'"
          >{{ member.name.slice(0, 1) }}</span
        >
        <div>
          <b>{{ member.name }}</b
          ><span>{{ member.id }}</span>
        </div>
        <small>已加入</small>
      </div>
      <div class="section-label invite-heading">可邀请的助手</div>
      <div
        v-for="agent in roomAgents.filter((value) => !value.joined)"
        :key="agent.id"
        class="invite-row"
      >
        <div>
          <b>{{ agent.name }}</b>
          <p>{{ agent.description }}</p>
        </div>
        <button
          class="primary"
          :disabled="Boolean(inviting)"
          @click="inviteAgent(agent.id)"
        >
          {{ inviting === agent.id ? "邀请中…" : `邀请${agent.name}` }}
        </button>
      </div>
      <p v-if="roomAgents.every((value) => value.joined)">
        所有已接入的助手都已在房间中。
      </p>
      <div v-if="memberNotice" class="notice" role="alert">
        {{ memberNotice }}
      </div>
      <p>邀请只建立成员关系。消息交给哪位助手，由你手动选择。</p>
    </dialog>
  </div>
</template>

<style>
:root {
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
  color: #28352f;
  background: #f3f5f2;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
button,
textarea,
input,
select {
  font: inherit;
}
button,
a {
  -webkit-tap-highlight-color: transparent;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.48;
}
button:focus-visible,
a:focus-visible,
summary:focus-visible {
  outline: 2px solid #46866a;
  outline-offset: 4px;
}
.shell {
  display: grid;
  grid-template-columns: 230px minmax(320px, 1fr) 288px;
  height: 100dvh;
  max-width: 1680px;
  margin: auto;
  background: #fff;
}
.sidebar {
  display: flex;
  flex-direction: column;
  padding: 30px 18px 22px;
  border-right: 1px solid #e5e9e4;
  background: #f4f6f2;
  min-width: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: #253e30;
  font-size: 17px;
  font-weight: 750;
  letter-spacing: -0.6px;
  white-space: nowrap;
}
.brand-mark {
  display: grid;
  place-items: center;
  background: #285c48;
  width: 32px;
  height: 32px;
  border-radius: 10px;
}
.brand-mark svg {
  width: 23px;
  fill: none;
  stroke: #fff;
  stroke-width: 1.7;
  stroke-linejoin: round;
}
.brand-suffix {
  font-size: 11px;
  color: #6b7a6e;
  font-weight: 500;
  letter-spacing: -0.2px;
}
.workspace-label {
  margin: 38px 10px 12px;
  display: flex;
  justify-content: space-between;
  color: #7d887e;
  font-size: 11px;
  letter-spacing: 1.2px;
}
.workspace-label span {
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #9aa297;
}
.room-list {
  max-height: 35vh;
  overflow-y: auto;
  flex-shrink: 0;
}
.room-nav {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  margin-bottom: 4px;
  text-align: left;
  color: inherit;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
}
.room-nav:hover {
  background: #edf1e9;
}
.room-nav.current {
  border-color: #dbe5d9;
  background: #e8eee4;
  font-weight: 600;
}
.room-nav > span:nth-child(2) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hash {
  font-size: 20px;
  font-weight: 400;
  color: #70846f;
}
.room-nav i,
.member-dot {
  width: 5px;
  height: 5px;
  background: #618568;
  border-radius: 50%;
  margin-left: auto;
  flex-shrink: 0;
}
.member-section .workspace-label {
  margin-top: 36px;
}
.create-room-button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  margin-top: 4px;
  border: 1px dashed #d4dece;
  background: transparent;
  color: #788970;
  border-radius: 8px;
  font-size: 11px;
}
.create-room-button:hover {
  background: #edf1e9;
}
.create-room-button > span {
  font-size: 17px;
}
.header-title {
  min-width: 0;
}
.header-title h1 {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mobile-rooms {
  display: none;
}
.member {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 11px 10px;
}
.member-section {
  min-height: 0;
  overflow-y: auto;
}
.member > div {
  min-width: 0;
}
.member b {
  overflow-wrap: anywhere;
}
.header-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
}
.members-button {
  padding: 6px 9px;
  border: 1px solid #e4e9df;
  border-radius: 20px;
  background: #fff;
  color: #6b8062;
  font-size: 11px;
  white-space: nowrap;
}
.avatar {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 650;
  flex-shrink: 0;
}
.human-avatar {
  background: #e3e8df;
  color: #5b6958;
}
.agent-avatar {
  background: #eaf0e7;
  color: #50734d;
  border: 1px solid #dce7d8;
}
.member b {
  display: block;
  font-size: 12px;
  font-weight: 550;
}
.member div > span {
  display: block;
  color: #8b9388;
  font-size: 10px;
  margin-top: 5px;
}
.member small {
  font-size: 8px;
  font-weight: 500;
  color: #708268;
  margin-left: 3px;
}
.sidebar-bottom {
  margin-top: auto;
  padding: 20px 10px 0;
  color: #758170;
  font-size: 11px;
}
.local-dot {
  width: 5px;
  height: 5px;
  display: inline-block;
  background: #8d9c81;
  border-radius: 50%;
  margin-right: 7px;
}
.sidebar-footnote {
  display: block;
  font-size: 10px;
  color: #929b8b;
  margin-top: 9px;
}
.chat {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #fdfefd;
}
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 27px 34px 24px;
  background: #fff;
  border-bottom: 1px solid #e9ece7;
}
.eyebrow {
  font-size: 10px;
  color: #8a9588;
  letter-spacing: 1px;
  margin-bottom: 7px;
}
h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.3px;
}
h1 > span {
  color: #8b9b83;
  font-weight: 400;
  margin-right: 5px;
}
.connection {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 10px;
  color: #61816c;
  background: #f1f6ef;
  border: 1px solid #e4ede1;
  padding: 6px 9px;
  border-radius: 20px;
}
.connection i,
.run-status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.connection.offline {
  background: #f9f3e8;
  color: #a17e49;
  border-color: #eee2cf;
}
.connection-note {
  padding: 9px 26px;
  background: #faf4e9;
  color: #967749;
  font-size: 12px;
}
.timeline {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 34px 28px;
  scrollbar-width: thin;
  scrollbar-color: #dce3d8 transparent;
}
.date-divider {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  color: #9aa294;
  font-size: 10px;
  margin: 18px 0 30px;
}
.date-divider::before,
.date-divider::after {
  content: "";
  height: 1px;
  background: #edf0e9;
  flex: 1;
  max-width: 70px;
}
.message-row {
  display: flex;
  gap: 10px;
  margin: 0 0 28px;
}
.message-row.mine {
  justify-content: flex-end;
}
.message-avatar {
  margin-top: 25px;
  width: 29px;
  height: 29px;
  border-radius: 9px;
}
.message-content {
  min-width: 0;
  max-width: 85%;
}
.mine .message-content {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.message-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 10px;
  color: #97a08f;
  margin-bottom: 9px;
}
.message-meta b {
  color: #62705d;
  font-weight: 500;
}
.message-meta time {
  font-size: 9px;
  letter-spacing: 0.3px;
}
.agent-label {
  font-size: 8px;
  color: #839475;
  letter-spacing: 0.8px;
}
.bubble {
  display: block;
  max-width: 100%;
  text-align: left;
  color: #3b4937;
  background: #fff;
  border: 1px solid #e4e9df;
  padding: 15px 17px;
  border-radius: 3px 13px 13px;
  box-shadow: 0 2px 4px #28352f03;
}
.mine .bubble {
  background: #edf2e8;
  border-color: #e2e9db;
  border-radius: 13px 3px 13px 13px;
}
.selectable {
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.selectable:hover {
  border-color: #a5b89a;
}
.selectable.selected {
  border-color: #7a9b69;
  box-shadow: 0 0 0 2px #71926313;
}
.message-text {
  font-size: 13px;
  line-height: 1.85;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.reply-quote {
  display: block;
  max-height: 56px;
  overflow: hidden;
  border-left: 2px solid #b8c8ac;
  padding: 3px 0 3px 9px;
  margin-bottom: 10px;
  color: #86927e;
  font-size: 11px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.reply-compose {
  display: flex;
  gap: 10px;
  border-left: 2px solid #99af8a;
  padding-left: 10px;
  margin-bottom: 10px;
}
.reply-compose > div {
  flex: 1;
  min-width: 0;
}
.reply-compose b {
  font-size: 10px;
  font-weight: 500;
  color: #6b8062;
}
.reply-compose p {
  font-size: 11px;
  line-height: 1.6;
  color: #929e88;
  margin: 5px 0 0;
  max-height: 36px;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.reply-compose button {
  border: 0;
  align-self: start;
  background: transparent;
  color: #8b9781;
  font-size: 18px;
}
.message-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 7px;
}
.text-button {
  border: 0;
  padding: 1px;
  background: transparent;
  color: #7d8e74;
  font-size: 10px;
}
.text-button:hover {
  color: #285c48;
}
.message-state {
  font-size: 9px;
  color: #8c9d82;
}
.composer-wrap {
  padding: 0 26px 16px;
  background: #fdfefd;
}
.composer {
  border: 1px solid #dce4d6;
  border-radius: 12px;
  background: #fff;
  padding: 13px 15px 10px;
  box-shadow: 0 4px 18px #28352f04;
}
.composer:focus-within {
  border-color: #9cb18e;
}
.composer textarea {
  width: 100%;
  border: 0;
  outline: 0;
  resize: none;
  min-height: 47px;
  max-height: 130px;
  background: transparent;
  color: #3d4c36;
  font-size: 13px;
  line-height: 1.8;
}
.composer textarea::placeholder {
  color: #a1a99b;
}
.composer-tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.composer-tools > span {
  font-size: 9px;
  color: #a0a797;
}
.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  border: 1px solid #285c48;
  border-radius: 7px;
  padding: 11px 16px;
  background: #285c48;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  transition: background 0.15s;
}
.primary:hover:not(:disabled) {
  background: #1c4b38;
}
.send-button {
  padding: 8px 14px;
  min-width: 80px;
}
.send-button span {
  font-size: 16px;
}
.composer-note {
  font-size: 9px;
  text-align: center;
  color: #a2aa9b;
  margin: 9px 0 0;
}
.notice {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 11px;
  margin-bottom: 8px;
  border-radius: 7px;
  background: #fbf3e6;
  font-size: 12px;
  color: #8f6b36;
}
.notice button {
  background: transparent;
  border: 0;
  color: inherit;
  font-size: 18px;
}
.run-panel {
  background: #fafbf8;
  border-left: 1px solid #e5e9e0;
  padding: 31px 23px 22px;
  overflow-y: auto;
  min-width: 0;
}
.run-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}
.run-heading h2 {
  font-size: 13px;
  margin: 0 0 5px;
  font-weight: 600;
}
.run-heading > div > span {
  color: #8b9781;
  font-size: 10px;
}
.run-heading .avatar {
  width: 35px;
  height: 35px;
  border-radius: 11px;
}
.run-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #eff1eb;
  color: #8e9a82;
  border: 1px solid #e7ebe0;
  border-radius: 20px;
  padding: 5px 9px;
  font-size: 10px;
  margin: 23px 0 31px;
}
.run-status.passed {
  color: #4d7b55;
  background: #edf4e9;
  border-color: #e0ebd9;
}
.run-status.processing {
  color: #a37d3d;
  background: #faf2e3;
  border-color: #efe0c6;
}
.section-label {
  font-size: 10px;
  color: #8c9883;
  margin-bottom: 12px;
}
.agent-picker {
  margin-top: 22px;
}
.agent-picker label {
  display: block;
  font-size: 10px;
  color: #8c9883;
  margin-bottom: 9px;
}
.agent-picker select {
  width: 100%;
  min-width: 0;
  padding: 10px;
  border: 1px solid #dce4d6;
  border-radius: 7px;
  background: #fff;
  color: #4f6847;
  font-size: 12px;
}
.agent-picker p {
  font-size: 10px;
  color: #8b9781;
  line-height: 1.8;
  margin: 9px 0 0;
}
.agent-picker + .run-status {
  margin-top: 18px;
}
.message-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.message-state {
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.selected-request {
  border: 1px solid #e2e8db;
  background: #fff;
  border-radius: 9px;
  padding: 13px;
  margin-bottom: 20px;
}
.selected-request > span {
  font-size: 9px;
  color: #9aa490;
}
.selected-request p {
  font-size: 12px;
  line-height: 1.9;
  color: #627057;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 170px;
  overflow: auto;
  margin: 8px 0 0;
}
.selection-placeholder {
  border: 1px dashed #dfe5d9;
  color: #a2ac98;
  font-size: 12px;
  line-height: 1.9;
  padding: 20px 13px;
  border-radius: 9px;
  margin-bottom: 20px;
}
.run-button {
  width: 100%;
  min-height: 41px;
}
.cost-note {
  text-align: center;
  font-size: 9px;
  color: #a2ab98;
  margin: 10px 0 0;
}
.job-notice {
  color: #9a804d;
  font-size: 11px;
  line-height: 1.8;
  padding: 11px;
  border: 1px solid #ede3d0;
  background: #fbf6eb;
  border-radius: 7px;
  margin-top: 16px;
}
.delivery-note {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  margin: 24px 0;
  color: #63815d;
}
.delivery-note > span {
  width: 19px;
  height: 19px;
  display: grid;
  place-items: center;
  border: 1px solid #d6e3cb;
  background: #edf4e8;
  border-radius: 50%;
  font-size: 10px;
}
.delivery-note b {
  font-size: 11px;
  font-weight: 500;
}
.delivery-note p {
  margin: 6px 0 0;
  font-size: 10px;
  line-height: 1.8;
  color: #8d9c83;
}
.run-details {
  font-size: 10px;
  color: #99a48e;
  border-top: 1px solid #e6ebdf;
  padding-top: 16px;
  margin-top: 26px;
}
.run-details summary {
  cursor: pointer;
  color: #839174;
}
.run-details > span {
  display: block;
  margin: 14px 0 5px;
}
.run-details code {
  display: block;
  overflow-wrap: anywhere;
  font-size: 9px;
  line-height: 1.7;
  user-select: all;
  color: #7c8b6c;
}
.run-footer {
  margin-top: 31px;
}
.mini-line {
  display: block;
  width: 24px;
  height: 1px;
  background: #d5dfcd;
}
.run-footer p {
  font-size: 10px;
  color: #9aa58e;
  line-height: 1.8;
  margin-top: 12px;
}
.empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #9ba692;
  padding: 30px;
}
.empty-mark {
  display: grid;
  place-items: center;
  width: 55px;
  height: 55px;
  border: 1px solid #e0e7d9;
  background: #f2f5ee;
  border-radius: 18px;
  font-size: 28px;
  color: #91a180;
}
.empty h2 {
  font-size: 16px;
  color: #6c7d61;
  font-weight: 500;
  margin: 20px 0 0;
}
.empty p {
  font-size: 12px;
  line-height: 1.8;
}
.empty .text-button {
  margin-top: 6px;
}
.room-dialog {
  width: min(440px, calc(100vw - 32px));
  padding: 26px;
  color: #3b4937;
  border: 1px solid #e0e7d9;
  border-radius: 16px;
  box-shadow: 0 20px 70px #28352f25;
}
.room-dialog::backdrop {
  background: #26392d55;
  backdrop-filter: blur(3px);
}
.dialog-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 25px;
}
.dialog-heading h2 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}
.dialog-heading button {
  align-self: start;
  border: 0;
  background: transparent;
  color: #8a9588;
  font-size: 23px;
}
.room-dialog label {
  display: block;
  font-size: 12px;
  margin-bottom: 9px;
}
.room-dialog input {
  width: 100%;
  min-width: 0;
  padding: 12px;
  border: 1px solid #d4dece;
  border-radius: 7px;
  background: #fcfdfb;
  color: inherit;
  font-size: 14px;
}
.room-dialog input:focus {
  outline: 2px solid #c7d6be;
  outline-offset: 1px;
}
.room-dialog p {
  font-size: 11px;
  line-height: 1.9;
  color: #8b9781;
  margin: 13px 0 24px;
}
.room-dialog .primary {
  width: 100%;
}
.agent-choices {
  padding: 0;
  margin: 22px 0 0;
  border: 0;
}
.agent-choices legend {
  font-size: 12px;
  margin-bottom: 12px;
}
.agent-choices label {
  display: flex;
  gap: 10px;
  align-items: start;
  padding: 10px;
  border: 1px solid #e4e9df;
  border-radius: 8px;
}
.agent-choices input {
  width: 15px;
  margin: 2px 0 0;
  accent-color: #285c48;
}
.agent-choices b {
  font-size: 12px;
  font-weight: 550;
}
.agent-choices small {
  display: block;
  color: #8b9781;
  font-size: 10px;
  line-height: 1.7;
  margin-top: 4px;
}
.dialog-member {
  padding-inline: 0;
}
.dialog-member > div > span {
  overflow-wrap: anywhere;
  font-size: 9px;
  line-height: 1.6;
}
.dialog-member > small {
  margin-left: auto;
  white-space: nowrap;
  color: #8b9781;
  font-size: 10px;
}
.invite-heading {
  margin-top: 25px;
}
.invite-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px solid #e9ece7;
}
.invite-row > div {
  flex: 1;
  min-width: 0;
}
.invite-row b {
  font-size: 12px;
  font-weight: 550;
}
.invite-row p {
  font-size: 10px;
  margin: 6px 0 0;
}
.invite-row .primary {
  width: auto;
  flex-shrink: 0;
  padding: 8px 10px;
  font-size: 10px;
}
@media (min-width: 1680px) {
  .shell {
    border-inline: 1px solid #e5e9e4;
  }
}
@media (max-width: 1120px) {
  .shell {
    grid-template-columns: 195px minmax(300px, 1fr) 255px;
  }
  .sidebar {
    padding-inline: 12px;
  }
  .brand-suffix {
    display: none;
  }
  .chat-header {
    padding-inline: 23px;
  }
  .timeline {
    padding-inline: 23px;
  }
  .run-panel {
    padding-inline: 18px;
  }
}
@media (max-width: 900px) {
  .shell {
    grid-template-columns: minmax(300px, 1fr) 255px;
  }
  .sidebar {
    display: none;
  }
  .mobile-rooms {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 18px;
    border-bottom: 1px solid #e9ece7;
  }
  .mobile-rooms select {
    min-width: 0;
    flex: 1;
    max-width: 100%;
    padding: 7px;
    border: 1px solid #e0e7d9;
    border-radius: 6px;
    background: #f4f6f2;
    color: #56704e;
    font-size: 12px;
  }
  .mobile-rooms button {
    border: 0;
    background: transparent;
    color: #56704e;
    font-size: 12px;
    white-space: nowrap;
  }
}
@media (max-width: 650px) {
  .shell {
    display: flex;
    flex-direction: column;
  }
  .chat {
    flex: 1;
  }
  .chat-header {
    padding: 18px;
  }
  h1 {
    font-size: 17px;
  }
  .eyebrow {
    font-size: 9px;
  }
  .timeline {
    padding: 12px 17px;
  }
  .message-content {
    max-width: 91%;
  }
  .bubble {
    padding: 12px 14px;
  }
  .composer-wrap {
    padding: 0 14px 10px;
  }
  .run-panel {
    padding: 15px 18px;
    border-left: 0;
    border-top: 1px solid #e3e9dd;
    max-height: 225px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px 14px;
    flex-shrink: 0;
  }
  .run-heading .avatar {
    width: 28px;
    height: 28px;
  }
  .run-heading h2 {
    font-size: 12px;
  }
  .run-heading > div > span {
    font-size: 9px;
  }
  .run-status {
    margin: 0;
    justify-self: end;
    align-self: center;
  }
  .section-label,
  .run-footer,
  .run-details,
  .delivery-note {
    display: none;
  }
  .selected-request,
  .selection-placeholder {
    margin: 0;
    grid-column: 1 / -1;
    padding: 8px 11px;
  }
  .selected-request > span {
    display: none;
  }
  .selected-request p {
    margin: 0;
    max-height: 48px;
    font-size: 11px;
    line-height: 1.6;
  }
  .run-button {
    grid-column: 1 / -1;
    min-height: 34px;
    padding: 8px;
  }
  .cost-note {
    grid-column: 1 / -1;
    margin: 0;
  }
  .job-notice {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 10px;
    padding: 7px;
  }
}
@media (max-width: 650px) {
  .header-actions {
    gap: 6px;
  }
  .connection {
    padding: 6px 7px;
    font-size: 9px;
  }
  .members-button {
    font-size: 10px;
  }
  .agent-picker {
    grid-column: 1 / -1;
    margin-top: 0;
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .agent-picker label {
    margin: 0;
    white-space: nowrap;
  }
  .agent-picker select {
    padding: 7px;
  }
  .agent-picker p {
    display: none;
  }
  .agent-picker + .run-status {
    margin: 0;
    grid-row: 1;
    grid-column: 2;
  }
  .run-panel {
    max-height: 275px;
  }
  .room-dialog {
    padding: 22px;
  }
  .room-dialog .invite-heading {
    display: block;
  }
}
</style>
