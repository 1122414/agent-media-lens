import { trace } from "./diagnostics.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { LensError, type Stage } from "./contracts.js";
const terminal = ["COMPLETED", "FAILED", "CANCELLED"];
type Timing = { stage: Stage; startedAt: string; elapsedMs?: number };
export interface Task {
  taskId: string;
  status: Stage;
  createdAt: string;
  completedAt?: string;
  stages: Timing[];
  retries: number;
  error?: { code: string; message: string };
  warnings?: string[];
  artifacts?: Record<string, string>;
}
export class Store {
  readonly db: DatabaseSync;
  readonly root: string;
  constructor(readonly settings: Config) {
    mkdirSync(settings.cacheDir, { recursive: true, mode: 0o700 });
    this.root = realpathSync(settings.cacheDir);
    const dbPath = join(this.root, "tasks.sqlite");
    if (lstatSync(dbPath, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new LensError("UNSAFE_PATH", "数据库路径无效");
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,pid INTEGER NOT NULL,active INTEGER NOT NULL,body TEXT NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS worker_owners (id TEXT PRIMARY KEY, pid INTEGER NOT NULL)",
    );
    this.transaction(() => this.recover());
  }
  trackWorker(id: string, pid: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO worker_owners VALUES(?,?)")
      .run(id, pid);
  }
  private recover() {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const rows = this.db
      .prepare(
        "SELECT t.id,t.pid,w.pid AS worker FROM tasks t LEFT JOIN worker_owners w ON t.id=w.id WHERE t.active=1",
      )
      .all();
    for (const row of rows) {
      if (alive(Number(row.pid))) continue;
      if (
        row.worker &&
        alive((process.platform === "win32" ? 1 : -1) * Number(row.worker))
      )
        continue;
      this.clearAlbumInputs(String(row.id));
      rmSync(this.file(String(row.id), ".playback.mp4"), { force: true });
      rmSync(this.file(String(row.id), "playback.mp4"), { force: true });
      this.stage(String(row.id), "FAILED", {
        error: { code: "INTERRUPTED", message: "处理进程已退出" },
      });
    }
  }
  transaction<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  dir(id: string) {
    z.uuid().parse(id);
    const p = join(this.root, id);
    const entry = lstatSync(p, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory())
      throw new LensError("UNSAFE_PATH", "任务目录不是安全路径");
    return p;
  }
  file(id: string, name: string) {
    if (
      !/^(\.page-\d{3}\.(?:img|mp4)|source\.mp4|\.?playback\.mp4|audio\.wav|evidence\.json|result\.json|transcript\.json|analysis\.md|(?:study|creative)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md|f\d{3}\.jpg)$/.test(
        name,
      )
    )
      throw new LensError("UNSAFE_PATH", "文件名无效");
    const p = join(this.dir(id), name);
    const entry = lstatSync(p, { throwIfNoEntry: false });
    if (entry && !entry.isFile())
      throw new LensError("UNSAFE_PATH", "任务文件无效");
    return p;
  }
  clearAlbumInputs(id: string) {
    const dir = this.dir(id);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir))
      if (/^\.page-\d{3}\.(?:img|mp4)$/.test(name))
        rmSync(this.file(id, name), { force: true });
  }
  task(id: string): Task {
    z.uuid().parse(id);
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    if (!row) throw new LensError("NOT_FOUND", "任务不存在");
    const task: Task = JSON.parse(String(row.body));
    if (task.status === "COMPLETED" && task.artifacts) {
      for (const [key, name] of [
        ["sourcePath", "source.mp4"],
        ["playbackPath", "playback.mp4"],
      ]) {
        if (existsSync(this.file(id, name))) task.artifacts[key] = name;
        else delete task.artifacts[key];
      }
    }
    return task;
  }
  cleanup() {
    return this.transaction(() => {
      this.recover();
      let removed = 0;
      for (const row of this.db
        .prepare("SELECT id FROM tasks WHERE active=0")
        .all()) {
        for (const name of ["source.mp4", "playback.mp4"]) {
          const path = this.file(String(row.id), name);
          if (
            existsSync(path) &&
            statSync(path).mtimeMs <=
              Date.now() - this.settings.retentionDays * 86400000
          ) {
            unlinkSync(path);
            removed++;
          }
        }
      }
      return { removed };
    });
  }
  ensureSpace(additionalBytes: number) {
    let used = 0;
    for (const row of this.db.prepare("SELECT id FROM tasks").all()) {
      const dir = this.dir(String(row.id));
      if (existsSync(dir))
        for (const f of readdirSync(dir)) used += lstatSync(join(dir, f)).size;
    }
    if (used + additionalBytes > this.settings.maxDiskBytes)
      throw new LensError("DISK_LIMIT", "缓存空间不足");
  }
  create() {
    this.cleanup();
    return this.transaction(() => {
      const active = Number(
        this.db.prepare("SELECT count(*) AS n FROM tasks WHERE active=1").get()
          ?.n,
      );
      if (active >= this.settings.concurrency)
        throw new LensError("BUSY", "并发任务已满");
      const reserve =
        this.settings.maxBytes +
        this.settings.maxFrames * 512000 +
        this.settings.maxSeconds * 32000 +
        8000000;
      this.ensureSpace(reserve * (active + 1));
      const id = randomUUID(),
        createdAt = new Date().toISOString();
      const task: Task = {
        taskId: id,
        createdAt,
        status: "PENDING",
        stages: [{ stage: "PENDING", startedAt: createdAt }],
        retries: 0,
      };
      mkdirSync(this.dir(id), { mode: 0o700 });
      this.db
        .prepare("INSERT INTO tasks VALUES(?,?,1,?)")
        .run(id, process.pid, JSON.stringify(task));
      return task;
    });
  }
  stage(
    id: string,
    status: Stage,
    extra: Partial<
      Pick<Task, "error" | "artifacts" | "retries" | "warnings">
    > = {},
  ) {
    const task = this.task(id);
    if (terminal.includes(task.status)) return task;
    const now = new Date().toISOString();
    const last = task.stages.at(-1)!;
    last.elapsedMs = Date.parse(now) - Date.parse(last.startedAt);
    task.stages.push({ stage: status, startedAt: now });
    task.status = status;
    Object.assign(task, extra);
    const done = terminal.includes(status);
    if (done) {
      task.completedAt = now;
      this.db.prepare("DELETE FROM worker_owners WHERE id=?").run(id);
    }
    this.db
      .prepare("UPDATE tasks SET body=?,active=? WHERE id=?")
      .run(JSON.stringify(task), done ? 0 : 1, id);
    trace({
      event: "stage",
      taskId: id,
      stage: status,
      previousStage: last.stage,
      elapsedMs: last.elapsedMs,
      code: extra.error?.code,
    });
    return task;
  }
}
