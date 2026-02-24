import { WORKER_CODE } from './render-worker.js';

export interface WorkerMessage {
  type: string;
  id?: number;
  [key: string]: unknown;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: number[] = [];
  private queue: Array<{
    msg: WorkerMessage;
    transfers: Transferable[];
    resolve: (value: WorkerMessage) => void;
  }> = [];
  private resolvers = new Map<number, { resolve: (value: WorkerMessage) => void }>();
  private nextId = 0;

  constructor(size: number) {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this.onMessage(i, e);
      this.workers.push(w);
      this.idle.push(i);
    }
  }

  private onMessage(workerIdx: number, e: MessageEvent): void {
    const msg = e.data as WorkerMessage;
    const resolver = this.resolvers.get(msg.id!);
    if (resolver) {
      this.resolvers.delete(msg.id!);
      resolver.resolve(msg);
    }
    this.idle.push(workerIdx);
    this.drain();
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const workerIdx = this.idle.shift()!;
      const { msg, transfers, resolve } = this.queue.shift()!;
      const id = this.nextId++;
      msg.id = id;
      this.resolvers.set(id, { resolve });
      this.workers[workerIdx].postMessage(msg, transfers);
    }
  }

  dispatch(msg: WorkerMessage, transfers: Transferable[] = []): Promise<WorkerMessage> {
    return new Promise((resolve) => {
      if (this.idle.length > 0) {
        const workerIdx = this.idle.shift()!;
        const id = this.nextId++;
        msg.id = id;
        this.resolvers.set(id, { resolve });
        this.workers[workerIdx].postMessage(msg, transfers);
      } else {
        this.queue.push({ msg, transfers, resolve });
      }
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.resolvers.clear();
  }
}
