/**
 * One FIFO queue for all state-changing runtime work.
 *
 * Code that already holds this queue must call a locked operation. It must not
 * call `run` again because a recursive call waits behind its own operation.
 */
export class MutationQueue {
    #tail = Promise.resolve();
    /** Run one operation after all operations submitted before it have settled. */
    run(operation) {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
