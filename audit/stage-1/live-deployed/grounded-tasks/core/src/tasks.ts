export type TaskStatus = "pending" | "in_progress" | "blocked" | "done";

export interface Task {
  id: string;
  text: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  waitReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskState {
  tasks: Task[];
  nextId: number;
}

export function emptyTaskState(): TaskState {
  return { tasks: [], nextId: 1 };
}

export function cloneTaskState(state: TaskState): TaskState {
  return { tasks: state.tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })), nextId: state.nextId };
}

export function validateTaskState(state: TaskState): void {
  if (!state || !Array.isArray(state.tasks) || !Number.isSafeInteger(state.nextId) || state.nextId < 1) {
    throw new Error("Malformed task state");
  }
  const validStatuses = new Set<TaskStatus>(["pending", "in_progress", "blocked", "done"]);
  const ids = new Set<string>();
  for (const task of state.tasks) {
    if (!task || typeof task.id !== "string" || typeof task.text !== "string" || !task.text.trim()
      || (task.description !== undefined && typeof task.description !== "string")
      || !validStatuses.has(task.status) || !Array.isArray(task.blockedBy)
      || !task.blockedBy.every((id): id is string => typeof id === "string")
      || (task.waitReason !== undefined && (typeof task.waitReason !== "string" || !task.waitReason.trim()))
      || !Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt)) {
      throw new Error("Malformed task entry");
    }
    if (!task.id || ids.has(task.id)) throw new Error(`Duplicate or empty task id: ${task.id}`);
    if (new Set(task.blockedBy).size !== task.blockedBy.length) throw new Error(`Task ${task.id} has duplicate blockers`);
    ids.add(task.id);
  }
  for (const task of state.tasks) {
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot block itself`);
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} has unknown blocker ${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const blocker of byId.get(id)!.blockedBy) visit(blocker);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of state.tasks) visit(task.id);
  if (state.tasks.filter((task) => task.status === "in_progress").length > 1) {
    throw new Error("Task state may contain at most one in-progress task");
  }
}

export function refreshBlockedStatuses(state: TaskState): void {
  const done = new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));
  for (const task of state.tasks) {
    if (task.status === "done") continue;
    const blocked = Boolean(task.waitReason) || task.blockedBy.some((id) => !done.has(id));
    if (blocked) task.status = "blocked";
    else if (task.status === "blocked") task.status = "pending";
  }
}

export function addTask(
  state: TaskState,
  input: { text: string; description?: string; blockedBy?: string[]; waitReason?: string; id?: string },
  now = Date.now(),
): Task {
  const text = input.text.trim();
  if (!text) throw new Error("Task text must not be empty");
  const previousNextId = state.nextId;
  const id = input.id ?? `T${state.nextId++}`;
  const explicitNumber = /^T(\d+)$/.exec(id);
  if (explicitNumber) state.nextId = Math.max(state.nextId, Number(explicitNumber[1]) + 1);
  const task: Task = {
    id,
    text,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    status: "pending",
    blockedBy: [...(input.blockedBy ?? [])],
    ...(input.waitReason?.trim() ? { waitReason: input.waitReason.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
  state.tasks.push(task);
  try {
    validateTaskState(state);
    refreshBlockedStatuses(state);
    return task;
  } catch (error) {
    state.tasks.pop();
    state.nextId = previousNextId;
    throw error;
  }
}

export function taskById(state: TaskState, id: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

export function startTask(state: TaskState, id: string, now = Date.now()): Task {
  refreshBlockedStatuses(state);
  const task = taskById(state, id);
  if (task.waitReason) throw new Error(`Task ${id} is waiting: ${task.waitReason}`);
  if (task.blockedBy.some((blocker) => taskById(state, blocker).status !== "done")) {
    throw new Error(`Task ${id} is blocked by unfinished dependencies`);
  }
  if (task.status === "done") throw new Error(`Task ${id} is already done`);
  for (const other of state.tasks) {
    if (other.status === "in_progress") other.status = "pending";
  }
  refreshBlockedStatuses(state);
  task.status = "in_progress";
  task.updatedAt = now;
  return task;
}

export function completeTask(state: TaskState, id: string, now = Date.now()): Task {
  const task = taskById(state, id);
  if (task.waitReason) throw new Error(`Task ${id} is waiting: ${task.waitReason}`);
  if (task.blockedBy.some((blocker) => taskById(state, blocker).status !== "done")) {
    throw new Error(`Task ${id} is blocked by unfinished dependencies`);
  }
  task.status = "done";
  task.updatedAt = now;
  refreshBlockedStatuses(state);
  return task;
}

export function updateTask(
  state: TaskState,
  id: string,
  input: { text?: string; description?: string; blockedBy?: string[]; waitReason?: string },
  now = Date.now(),
): Task {
  const task = taskById(state, id);
  const previous = { ...task, blockedBy: [...task.blockedBy] };
  if (input.text !== undefined) {
    if (!input.text.trim()) throw new Error("Task text must not be empty");
    task.text = input.text.trim();
  }
  if (input.description !== undefined) {
    if (input.description.trim()) task.description = input.description.trim();
    else delete task.description;
  }
  if (input.blockedBy !== undefined) task.blockedBy = [...input.blockedBy];
  if (input.waitReason !== undefined) {
    if (input.waitReason.trim()) task.waitReason = input.waitReason.trim();
    else delete task.waitReason;
  }
  task.updatedAt = now;
  try {
    validateTaskState(state);
    refreshBlockedStatuses(state);
    return task;
  } catch (error) {
    Object.assign(task, previous);
    task.blockedBy = previous.blockedBy;
    if (previous.waitReason === undefined) delete task.waitReason;
    throw error;
  }
}

export function removeTask(state: TaskState, id: string): void {
  const dependent = state.tasks.find((task) => task.blockedBy.includes(id));
  if (dependent) throw new Error(`Cannot remove ${id}; it is referenced by ${dependent.id}`);
  const index = state.tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`Task not found: ${id}`);
  state.tasks.splice(index, 1);
}

export function reorderTask(state: TaskState, id: string, position: number): void {
  const index = state.tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`Task not found: ${id}`);
  const [task] = state.tasks.splice(index, 1);
  state.tasks.splice(Math.max(0, Math.min(state.tasks.length, position)), 0, task!);
}

export function clearDone(state: TaskState): number {
  const done = new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));
  const before = state.tasks.length;
  state.tasks = state.tasks.filter((task) => !done.has(task.id));
  for (const task of state.tasks) task.blockedBy = task.blockedBy.filter((id) => !done.has(id));
  refreshBlockedStatuses(state);
  return before - state.tasks.length;
}
