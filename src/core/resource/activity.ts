/** 记录进程内可见的推理与 subagent 活动；每个 release 都是幂等的。 */
export class ResourceActivityTracker {
  #activeInference = 0;
  #activeSubagents = 0;

  get activeInference(): number {
    return this.#activeInference;
  }

  get activeSubagents(): number {
    return this.#activeSubagents;
  }

  beginInference(): () => void {
    this.#activeInference += 1;
    return once(() => {
      this.#activeInference = Math.max(0, this.#activeInference - 1);
    });
  }

  beginSubagent(): () => void {
    this.#activeSubagents += 1;
    return once(() => {
      this.#activeSubagents = Math.max(0, this.#activeSubagents - 1);
    });
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
